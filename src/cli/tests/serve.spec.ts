import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { createHost } from '../serve.ts'

/** The host's runtime surface, faked: records triggers, traces, and lifecycle calls. */
const fakeRuntime = () => {
  const triggers: BPEvent[] = []
  const listeners: Array<(trace: Trace) => void> = []
  const calls = { started: 0, terminated: 0 }
  const runtime = {
    identity: { instanceId: 'bp_serve_test', sessionId: 'bp_serve_test' },
    trigger: (event: BPEvent): void => {
      triggers.push(event)
    },
    useTrace: (listener: (trace: Trace) => void): (() => void) => {
      listeners.push(listener)
      return () => {}
    },
    start: (): void => {
      calls.started += 1
    },
    terminate: (): void => {
      calls.terminated += 1
    },
  }
  const emit = (trace: Trace): void => {
    for (const listener of listeners) listener(trace)
  }
  return { runtime, triggers, calls, emit }
}

const selectionOf = (selected: { type: string; detail?: JsonObject; space?: string }): SelectionTrace => ({
  kind: TRACE_MESSAGE_KINDS.selection,
  timestamp: 0,
  instanceId: 'i',
  sessionId: 'i',
  step: 1,
  selected: { priority: 0, ...selected },
})

const drive = (input: string, home: string) => {
  const out: string[] = []
  const fake = fakeRuntime()
  const host = createHost({
    runtime: fake.runtime,
    input: new Response(input).body as ReadableStream<Uint8Array>,
    write: (line) => out.push(line),
    home,
  })
  return { host, out, ...fake }
}

const lines = (out: string[]): unknown[] => out.map((line) => JSON.parse(line))

describe('createHost', () => {
  test('starts the runtime and announces ready', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      const { host, out, calls } = drive('', home)
      await host.rpc.done
      expect(calls.started).toBe(1)
      expect(lines(out)).toEqual([{ jsonrpc: '2.0', method: 'ready' }])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a ui_event notification triggers its inner BPEvent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      const { host, triggers } = drive(
        '{"jsonrpc":"2.0","method":"ui_event","params":{"event":{"type":"click"}}}\n',
        home,
      )
      await host.rpc.done
      expect(triggers).toEqual([{ type: 'click' }])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a trigger request admits the event and answers accepted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      const { host, out, triggers } = drive(
        '{"jsonrpc":"2.0","id":1,"method":"trigger","params":{"event":{"type":"kick"}}}\n',
        home,
      )
      await host.rpc.done
      expect(triggers).toEqual([{ type: 'kick' }])
      expect(lines(out)).toContainEqual({ jsonrpc: '2.0', id: 1, result: { accepted: true } })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a ui_* notification triggers a namespaced event', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      const { host, triggers } = drive(
        '{"jsonrpc":"2.0","method":"ui_scale_check_result","params":{"id":"s1"}}\n',
        home,
      )
      await host.rpc.done
      expect(triggers).toEqual([{ type: 'ui_scale_check_result', detail: { id: 's1' } }])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a ui_* selection is pushed to the client as a notification', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      const { host, out, emit } = drive('', home)
      await host.rpc.done
      emit(selectionOf({ type: 'ui_render', detail: { id: 'r1', target: 'main' } }))
      expect(lines(out)).toContainEqual({
        jsonrpc: '2.0',
        method: 'ui_render',
        params: { id: 'r1', target: 'main' },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a selection is also pushed as a redacted trace notification', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      const { host, out, emit } = drive('', home)
      await host.rpc.done
      emit(selectionOf({ type: 'ui_render', detail: { id: 'r1' } }))
      expect(lines(out)).toContainEqual({
        jsonrpc: '2.0',
        method: 'trace',
        params: selectionOf({ type: 'ui_render', detail: { id: 'r1' } }),
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/** One parsed stdout line from the serve process. */
type RpcLine = { jsonrpc: string; method?: string; params?: { kind?: string; selected?: { type?: string } } }

describe('serve entry (stdio)', () => {
  test('announces ready, traces a trigger to idle, and exits 0 on stdin close', async () => {
    const repoRoot = resolve(import.meta.dir, '../../..')
    const home = mkdtempSync(join(tmpdir(), 'behavioral-serve-'))
    try {
      // actuators: [] prunes every actuator process — the engine alone, no spawns.
      await Bun.write(join(home, 'config.ts'), `export default { actuators: [] }`)
      const proc = Bun.spawn(['bun', 'bin/behavioral.ts', 'serve'], {
        cwd: repoRoot,
        env: { ...process.env, BEHAVIORAL_HOME: home },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'trigger', params: { event: { type: 'kick' } } })}\n`,
      )
      proc.stdin.end()
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`serve exited ${code}: ${stderr}`)
      const messages = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RpcLine)
      expect(messages).toContainEqual({ jsonrpc: '2.0', method: 'ready' })
      expect(messages.some((m) => m.method === 'trace' && m.params?.kind === 'idle')).toBe(true)
      expect(messages.some((m) => m.method === 'trace' && m.params?.selected?.type === 'kick')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
