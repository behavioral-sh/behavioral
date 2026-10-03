import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import type { ClientMessage } from '../../controller/controller.types.ts'
import { B_PROGRAM_WORKER_PATH } from '../../controller/worker-transport.ts'
import { createSocketHost, instanceSocketPath } from '../socket-host.ts'

/** The identity the engine stamps on every trace — the hello's payload. */
const identity = { instanceId: 'bp_instance_test', sessionId: 'sess_test' }

/** The host's runtime surface, faked: records triggers, traces, and lifecycle calls. */
const fakeRuntime = (withIdentity = identity) => {
  const triggers: BPEvent[] = []
  const listeners: Array<(trace: Trace) => void> = []
  const runtime = {
    identity: withIdentity,
    trigger: (event: BPEvent): void => {
      triggers.push(event)
    },
    useTrace: (listener: (trace: Trace) => void): (() => void) => {
      listeners.push(listener)
      return () => {}
    },
    start: (): void => {},
    terminate: (): void => {},
  }
  const emit = (trace: Trace): void => {
    for (const listener of listeners) listener(trace)
  }
  return { runtime, triggers, emit }
}

const selectionOf = (selected: { type: string; detail?: JsonObject; space?: string }): SelectionTrace => ({
  kind: TRACE_MESSAGE_KINDS.selection,
  timestamp: 0,
  instanceId: 'i',
  sessionId: 'i',
  step: 1,
  selected: { priority: 0, ...selected },
})

const traceOf = (kind: Trace['kind'], extra: Partial<Trace> = {}): Trace =>
  ({ kind, timestamp: 0, instanceId: 'i', sessionId: 'i', step: 1, ...extra }) as Trace

/**
 * A Transport-shaped client over the real instance socket: `send` frames a
 * ClientMessage (or a trigger) as one JSON-RPC frame; inbound JSON-RPC
 * notifications land raw in `frames` for assertions.
 */
type TestClient = {
  send: (message: ClientMessage | { type: 'trigger'; detail: { event: BPEvent } }) => void
  sendRaw: (line: string) => void
  frames: unknown[]
  waitFor: <T>(pred: (frame: unknown) => boolean, what: string) => Promise<T>
  close: () => void
}

const attachClient = (path: string): Promise<TestClient> =>
  new Promise((resolveClient, reject) => {
    const socket = new WebSocket(`ws+unix://${path}`)
    const frames: unknown[] = []
    let nextId = 1
    socket.addEventListener('open', () => {
      resolveClient({
        send: (message) => {
          const id = nextId++
          if (message.type === 'trigger' || message.type === 'ui_event') {
            socket.send(
              JSON.stringify({ jsonrpc: '2.0', id, method: message.type, params: { event: message.detail.event } }),
            )
            return
          }
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: message.type, params: message.detail }))
        },
        sendRaw: (line) => socket.send(line),
        frames,
        waitFor: <T>(pred: (frame: unknown) => boolean, what: string): Promise<T> =>
          new Promise<T>((resolveWait, rejectWait) => {
            const start = Date.now()
            const timer = setInterval(() => {
              const found = frames.find(pred)
              if (found !== undefined) {
                clearInterval(timer)
                resolveWait(found as T)
              } else if (Date.now() - start > 3000) {
                clearInterval(timer)
                rejectWait(new Error(`timed out waiting for ${what}`))
              }
            }, 5)
          }),
        close: () => socket.close(),
      })
    })
    socket.addEventListener('message', (ev) => {
      frames.push(JSON.parse(String(ev.data)))
    })
    socket.addEventListener('error', (ev) => reject(new Error(`client socket error: ${String(ev)}`)))
  })

const homes: string[] = []
const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'behavioral-socket-host-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

describe('createSocketHost', () => {
  test('a new client is helloed with the engine identity before anything else', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    const hello = await client.waitFor<{ method: string; params: unknown }>(
      (frame) => (frame as { method?: string }).method === 'hello',
      'hello notification',
    )
    expect(hello.params).toEqual(identity)
    // Connection-scoped notification, not an engine event: nothing entered
    // the engine, nothing triggered a super-step.
    expect(fake.triggers).toEqual([])
    client.close()
    await host.close()
  })

  test('the hello is per-connection and stays first on the wire', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const first = await attachClient(host.path)
    const second = await attachClient(host.path)
    fake.emit(traceOf(TRACE_MESSAGE_KINDS.idle))
    await first.waitFor((frame) => (frame as { method?: string }).method === 'trace', 'trace on client one')
    await second.waitFor((frame) => (frame as { method?: string }).method === 'trace', 'trace on client two')
    // Each client saw exactly one hello, and it preceded every trace frame.
    for (const client of [first, second]) {
      const hellos = client.frames.filter((frame) => (frame as { method?: string }).method === 'hello')
      expect(hellos).toHaveLength(1)
      const helloIndex = client.frames.findIndex((frame) => (frame as { method?: string }).method === 'hello')
      const traceIndex = client.frames.findIndex((frame) => (frame as { method?: string }).method === 'trace')
      expect(helloIndex).toBeLessThan(traceIndex)
    }
    first.close()
    second.close()
    await host.close()
  })

  test('a runtime without a well-formed identity helloes nobody', async () => {
    const home = tempHome()
    const fake = fakeRuntime({ instanceId: 'bp_instance_test' } as typeof identity)
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    await Bun.sleep(100)
    const hellos = client.frames.filter((frame) => (frame as { method?: string }).method === 'hello')
    expect(hellos).toEqual([])
    client.close()
    await host.close()
  })

  test('a trigger request lands as an engine event and answers accepted', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    client.send({ type: 'trigger', detail: { event: { type: 'kick' } } })
    type ResponseFrame = { id: number; result?: unknown; error?: unknown }
    const response = await client.waitFor<ResponseFrame>(
      (frame) => (frame as { id?: number }).id === 1,
      'trigger response',
    )
    expect(fake.triggers).toEqual([{ type: 'kick' }])
    expect(response.result).toEqual({ accepted: true })
    client.close()
    await host.close()
  })

  test('redacted traces fan back out to every connected client', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const first = await attachClient(host.path)
    const second = await attachClient(host.path)
    fake.emit(traceOf(TRACE_MESSAGE_KINDS.idle))
    const firstTrace = await first.waitFor<{ method: string; params: Trace }>(
      (frame) => (frame as { method?: string }).method === 'trace',
      'trace on client one',
    )
    const secondTrace = await second.waitFor<{ method: string; params: Trace }>(
      (frame) => (frame as { method?: string }).method === 'trace',
      'trace on client two',
    )
    expect(firstTrace.params.kind).toBe(TRACE_MESSAGE_KINDS.idle)
    expect(secondTrace.params.kind).toBe(TRACE_MESSAGE_KINDS.idle)
    first.close()
    second.close()
    await host.close()
  })

  test('a ui_* selection is pushed to clients as its own notification', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    fake.emit(selectionOf({ type: 'ui_render', detail: { id: 'r1', target: 'main' } }))
    const frame = await client.waitFor<{ method: string; params: JsonObject }>(
      (item) => (item as { method?: string }).method === 'ui_render',
      'ui_render notification',
    )
    expect(frame.params).toEqual({ id: 'r1', target: 'main' })
    client.close()
    await host.close()
  })

  test('an unknown method is answered with a JSON-RPC error', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    client.sendRaw('{"jsonrpc":"2.0","id":2,"method":"nope"}')
    const frame = await client.waitFor<{ id: number; error?: { code: number } }>(
      (item) => (item as { id?: number }).id === 2,
      'error response',
    )
    expect(frame.error?.code).toBe(-32603)
    client.close()
    await host.close()
  })

  test('the socket file lives while the host runs and is removed on close', async () => {
    const home = tempHome()
    const path = instanceSocketPath(home)
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    expect(existsSync(path)).toBe(true)
    await host.close()
    expect(existsSync(path)).toBe(false)
  })

  test('a stale socket file from a dead instance is replaced at start', async () => {
    const home = tempHome()
    writeFileSync(instanceSocketPath(home), 'garbage from a crashed instance')
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    client.send({ type: 'trigger', detail: { event: { type: 'kick' } } })
    await client.waitFor((frame) => (frame as { id?: number }).id === 1, 'trigger response')
    client.close()
    await host.close()
  })

  test('the ui capture lane is wired: a ui run lands in <home>/captures', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      // A scripted ui pipeline under one minted pipeline id (pid `ui-e2e`):
      // the render ingress, the scale check, the browser reply, and the
      // render — the capture binds the run by the pid lineage and closes it
      // at the render.
      fake.emit({
        ...selectionOf({ type: 'render', detail: {} }),
        selected: { priority: 0, type: 'render', detail: {}, ingress: true },
      })
      fake.emit(
        selectionOf({
          type: 'ui_scale_check',
          detail: { id: 'ui-e2e-scale', target: 'body', swap: 'innerHTML' },
        }) as never,
      )
      fake.emit(
        selectionOf({
          type: 'ui_scale_check_result',
          detail: { id: 'ui-e2e-scale', target: 'body', effectiveScale: 's3', timeStamp: 1 },
        }) as never,
      )
      fake.emit(
        selectionOf({
          type: 'ui_render',
          detail: { id: 'ui-e2e-render', target: 'body', html: '<p>x</p>', swap: 'innerHTML' },
        }) as never,
      )
      const file = join(home, 'captures', 'ui-runs.jsonl')
      const deadline = Date.now() + 5_000
      while (!existsSync(file)) {
        if (Date.now() > deadline) throw new Error('capture file never appeared')
        await Bun.sleep(10)
      }
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { messages: Array<{ selected: { type: string } }> })
      expect(lines).toHaveLength(1)
      expect(lines[0]!.messages.map((m) => m.selected.type)).toEqual([
        'render',
        'ui_scale_check',
        'ui_scale_check_result',
        'ui_render',
      ])
    } finally {
      await host.close()
    }
  })

  test('a plain HTTP request on the carrier is refused with 426', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const response = await fetch('http://localhost/', { unix: host.path })
    expect(response.status).toBe(426)
    await host.close()
  })

  test('the conventional worker route serves the self-booting composition bundle', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      const response = await fetch(`http://localhost${B_PROGRAM_WORKER_PATH}`, { unix: host.path })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')?.startsWith('text/javascript')).toBe(true)
      // fetch transparently decompresses the gzip body — the composition's
      // wire markers (the bundler-visible faculty literals + the attach
      // protocol) ride the decoded text.
      const body = await response.text()
      expect(body).toContain('attach')
      expect(body).toContain('system-one.faculty.ts')
    } finally {
      await host.close()
    }
  })
})
