import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { instancePidfilePath } from '../../actuators/instance-lock.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { Trace } from '../../behavioral/behavioral.types.ts'
import { CONNECT_BEHAVIORAL_ROUTE } from '../../controller/bundle-controller.ts'
import type { HostRuntime } from '../serve.ts'
import { instanceSocketPath } from '../socket-host.ts'

const homes: string[] = []
// RE-PIN (the systemOne deployment requirement, 2026-10-03): every temp home
// carries the minimal valid deployment config — a deployment boots with a
// decision model or fails fast at load. The endpoint is never contacted (the
// runtime is the echo seam).
const tempHome = (): string => {
  const home = join(tmpdir(), `behavioral-attach-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  homes.push(home)
  mkdirSync(home, { recursive: true })
  void Bun.write(
    join(home, 'config.ts'),
    "export default { systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' } }",
  )
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

/** Poll until `pred` holds or the timeout elapses. */
const eventually = async (pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

/** Incrementally drain a subprocess stream into a string. */
const collect = (stream: ReadableStream<Uint8Array>): { text: () => string } => {
  const decoder = new TextDecoder()
  let acc = ''
  void (async () => {
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
        acc += decoder.decode(chunk, { stream: true })
    } catch {
      // Stream torn down with the process.
    }
  })()
  return { text: () => acc }
}

/** The two-process fixture: mode 'start' boots the foreground instance; mode 'attach' attaches. */
const spawnLifecycleProcess = (mode: 'start' | 'attach', home: string) =>
  Bun.spawn({
    cmd: ['bun', 'run', join(import.meta.dir, 'fixtures', 'attach-instance.ts'), mode],
    env: { ...process.env, BEHAVIORAL_HOME: home },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

const pidOf = async (home: string): Promise<number> =>
  (JSON.parse(await Bun.file(instancePidfilePath(home)).text()) as { pid: number }).pid

describe('attachOrStart — the two-process lifecycle', () => {
  test('a bare start owns the home; an attacher reuses it; SIGTERM cleans up', async () => {
    const home = tempHome()
    const instance = spawnLifecycleProcess('start', home)
    const instanceOut = collect(instance.stdout)

    // The instance is up: the socket file exists and the pidfile names its pid.
    const socketPath = instanceSocketPath(home)
    await eventually(() => existsSync(socketPath), 'instance socket')
    const instancePid = await pidOf(home)
    expect(instancePid).toBeGreaterThan(0)

    // Second process: attach-or-start must attach, never spawn a second instance.
    const attacher = spawnLifecycleProcess('attach', home)
    const attacherOut = collect(attacher.stdout)
    attacher.stdin.write('/kick\n')
    await eventually(() => attacherOut.text().includes('attached to running instance'), 'attach notice')

    // No second instance: the pidfile still names the first instance's pid.
    expect(await pidOf(home)).toBe(instancePid)

    // The trigger crossed processes: the instance selected the tui_command event.
    await eventually(() => instanceOut.text().includes('tui_command'), 'trigger selection trace on the instance')

    // The attacher's stdin ends → it detaches; the instance keeps running.
    attacher.stdin.end()
    const attacherCode = await attacher.exited
    expect(attacherCode).toBe(0)
    expect(existsSync(socketPath)).toBe(true)
    expect(await pidOf(home)).toBe(instancePid)

    // SIGTERM: terminate + pidfile/socket cleanup (the daemon-door discipline).
    instance.kill('SIGTERM')
    const instanceCode = await instance.exited
    expect(instanceCode).toBe(0)
    await eventually(() => !existsSync(socketPath), 'socket removal')
    expect(existsSync(instancePidfilePath(home))).toBe(false)
  }, 40_000)

  test('a stale pidfile is reaped and the instance starts fresh', async () => {
    const home = tempHome()
    await Bun.write(instancePidfilePath(home), JSON.stringify({ pid: 999_999_999 }))
    const instance = spawnLifecycleProcess('start', home)
    await eventually(() => existsSync(instanceSocketPath(home)), 'instance socket after stale-pidfile reap')
    const pid = await pidOf(home)
    expect(pid).toBeGreaterThan(1)
    expect(pid).not.toBe(999_999_999)
    instance.kill('SIGTERM')
    await instance.exited
  }, 40_000)

  test('an idle instance helloes the attacher — the notice is immediate, carries the right id, and prints once per attach', async () => {
    const home = tempHome()
    const instance = spawnLifecycleProcess('start', home)
    await eventually(() => existsSync(instanceSocketPath(home)), 'instance socket')
    const instanceId = (await Bun.file(join(home, 'spec-instance-id')).text()).trim()

    // Attach WITHOUT sending any trigger: the echo runtime only emits traces
    // on start (before the attacher exists) and on triggers, so a notice now
    // can only come from the connection hello.
    const attacher = spawnLifecycleProcess('attach', home)
    const attacherOut = collect(attacher.stdout)
    await eventually(() => attacherOut.text().includes('attached to running instance'), 'immediate attach notice')
    expect(attacherOut.text()).toContain(`attached to running instance ${instanceId}`)
    expect(attacherOut.text().match(/attached to running instance/g)).toHaveLength(1)

    // A subsequent attach prints exactly once as well.
    const second = spawnLifecycleProcess('attach', home)
    const secondOut = collect(second.stdout)
    await eventually(() => secondOut.text().includes('attached to running instance'), 'second attach notice')
    expect(secondOut.text().match(/attached to running instance/g)).toHaveLength(1)

    second.stdin.end()
    await second.exited
    attacher.stdin.end()
    await attacher.exited
    instance.kill('SIGTERM')
    await instance.exited
  }, 40_000)
})

/** A still-open readable whose buffered contents readline consumes. */
const scriptInput = (lines: string[]): Readable => {
  const stream = new Readable({ read() {} })
  for (const line of lines) stream.push(line)
  return stream
}

/** The echo runtime of the child fixture, in-process: selections echo traces. */
const echoRuntime = (): HostRuntime => {
  const instanceId = Bun.randomUUIDv7()
  const listeners = new Set<(trace: Trace) => void>()
  const emit = (trace: Trace): void => {
    for (const listener of listeners) listener(trace)
  }
  const base = { instanceId, sessionId: instanceId }
  return {
    identity: base,
    trigger: (event) =>
      emit({
        kind: TRACE_MESSAGE_KINDS.selection,
        timestamp: Date.now(),
        step: 1,
        ...base,
        selected: { priority: 0, type: event.type, detail: event.detail },
      }),
    useTrace: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    start: () => emit({ kind: TRACE_MESSAGE_KINDS.idle, timestamp: Date.now(), step: 1, ...base }),
    terminate: () => {},
  }
}

describe('attachOrStart — the --dev flag', () => {
  test('start-time only: dev: true serves the dev bundle; the attach path has no dev knob', async () => {
    const { attachOrStart } = await import('../attach-or-start.ts')
    const home = tempHome()
    // The input stays open until the assertions are done.
    const input = scriptInput(['/kick\n'])
    const pending = attachOrStart({ home, input, write: () => {}, createRuntime: echoRuntime, dev: true })
    await eventually(() => existsSync(instanceSocketPath(home)), 'started instance socket')
    // The started instance serves the controller bundle on the same listener.
    const response = await fetch(`http://localhost${CONNECT_BEHAVIORAL_ROUTE}`, { unix: instanceSocketPath(home) })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ui_render')
    // Stdin ends → clean detach with pidfile/socket cleanup.
    input.push(null)
    const result = await pending
    expect(result.attached).toBe(false)
    expect(existsSync(instanceSocketPath(home))).toBe(false)
  }, 30_000)

  test('an attacher cannot flip a running instance into dev mode (start-time only)', async () => {
    const { attachOrStart } = await import('../attach-or-start.ts')
    const home = tempHome()
    await Bun.write(join(home, 'instance.pid'), JSON.stringify({ pid: process.pid }))
    // A live pidfile → attach path: no dev option is even accepted to reach a
    // runtime — attaching starts nothing and reconfigures nothing.
    const result = await attachOrStart({
      home,
      input: scriptInput([]),
      write: () => {},
      createRuntime: () => {
        throw new Error('attach must never start a runtime')
      },
    })
    expect(result.attached).toBe(true)
  })
})
