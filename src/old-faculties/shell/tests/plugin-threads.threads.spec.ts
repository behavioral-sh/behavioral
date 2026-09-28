/**
 * The plugin-threads proposal path against the real engine — the ICL
 * threads turning a proposal (plugin, file) into a worker import: a
 * dispatcher issues the bun-direct import script through the shell
 * faculty's `run` op (the plugin file's top level executes ONCE, in the
 * worker, behind the explicit proposal act), the ctx.echo join maps the
 * result to candidates, and one `add_thread` frontier proposal rides per
 * validated thread. Validation is the engine's ThreadSchema home — imported
 * by the script, never hand-mirrored.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import {
  PLUGIN_THREAD_IMPORT_SCRIPT,
  PLUGIN_THREADS_EVENT_TYPES,
  pluginThreadsThreads,
} from '../plugin-threads.threads.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = (events: BPEvent[]): Selected[] => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection) {
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
    }
  })
  for (const thread of pluginThreadsThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  // addThread is inert — trigger admits one ingress event and runs one
  // super-step; the second pump cascades transform re-entries.
  program.trigger({ type: 'plugin_threads_pump', detail: {} })
  program.trigger({ type: 'plugin_threads_pump', detail: {} })
  return selected
}

const proposal = (over: Partial<BPEvent> = {}): BPEvent => ({
  type: PLUGIN_THREADS_EVENT_TYPES.proposal,
  detail: { id: 'p1', input: { plugin: '/plugins/alpha', file: 't.ts' } },
  ...over,
})

describe('plugin threads — import issue', () => {
  test('a proposal issues the plugin-threads import shell_request: run op, label, env-carried target, ctx echo', () => {
    const selected = runProgram([proposal()])
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p1-import')
    expect(call).toBeDefined()
    expect(call?.detail?.label).toBe('plugin-threads')
    const input = call?.detail?.input as JsonObject
    expect(input.op).toBe('run')
    expect(input.format).toBe('json')
    expect(typeof input.script).toBe('string')
    const env = input.env as Record<string, string>
    expect(env.PLUGIN_THREADS_ROOT).toBe('/plugins/alpha')
    expect(env.PLUGIN_THREADS_FILE).toBe('t.ts')
    // the join lane: the ctx echo carries the proposal's source id and target
    const ctx = call?.detail?.ctx as { echo?: Record<string, unknown> }
    expect(ctx?.echo).toMatchObject({ source: 'p1', plugin: '/plugins/alpha', file: 't.ts' })
  })

  test('a proposal with a target space carries it on the echo', () => {
    const selected = runProgram([
      proposal({ detail: { id: 'p2', input: { plugin: '/plugins/alpha', file: 't.ts', space: 's1' } } }),
    ])
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p2-import')
    const ctx = call?.detail?.ctx as { echo?: Record<string, unknown> }
    expect(ctx?.echo).toMatchObject({ source: 'p2', space: 's1' })
  })

  test('a malformed proposal (missing plugin) never issues an import', () => {
    const selected = runProgram([
      { type: PLUGIN_THREADS_EVENT_TYPES.proposal, detail: { id: 'p3', input: { file: 't.ts' } } },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p3-import')).toBe(
      false,
    )
  })
})

describe('plugin threads — the join and the candidates', () => {
  const threadA: Thread = { label: 'greeter', once: true, rules: [{ request: { type: 'hello' } }] }
  const threadB: Thread = { label: 'farewell', once: true, rules: [{ request: { type: 'bye' } }] }

  const importResult = (threads: Thread[], echo: Record<string, unknown>, id = 'p1'): BPEvent =>
    ({
      type: FACULTY_MESSAGE_KINDS.shell_request_result,
      detail: {
        id: `${id}-import`,
        ok: true,
        // a validated Thread is pure data but not statically JsonValue — the
        // composition's own candidate emission casts the same way
        result: {
          status: 'completed',
          jsonData: { threads: threads as unknown as JsonObject[], warnings: ['a warning'], hash: 'abc123' },
        },
        ctx: { echo },
      },
    }) as unknown as BPEvent

  test('a validated import surfaces the batch and proposes one add_thread per thread', () => {
    const selected = runProgram([
      proposal(),
      importResult([threadA, threadB], { source: 'p1', plugin: '/plugins/alpha', file: 't.ts' }),
    ])
    // the batch surface: the imported event carries the validated threads + hash + warnings
    const imported = selected.find((s) => s.type === PLUGIN_THREADS_EVENT_TYPES.imported)
    expect(imported).toBeDefined()
    const importedInput = imported?.detail?.input as Record<string, unknown>
    expect(importedInput.plugin).toBe('/plugins/alpha')
    expect(importedInput.file).toBe('t.ts')
    expect(importedInput.hash).toBe('abc123')
    expect(importedInput.threads).toHaveLength(2)
    expect(importedInput.warnings).toEqual(['a warning'])
    // one add_thread proposal per thread, correlated ids
    const adds = selected.filter((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_request)
    expect(adds.map((s) => s.detail?.id)).toEqual(['p1-add-0', 'p1-add-1'])
    for (const add of adds) {
      expect(add.detail?.op).toBe('add_thread')
      const input = add.detail?.input as { thread?: { label?: string } }
      const label = input.thread?.label ?? ''
      expect(['greeter', 'farewell']).toContain(label)
    }
  })

  test('a named target space stamps the proposed thread — the admission owns the mount scope', () => {
    const selected = runProgram([
      proposal({ detail: { id: 'p2', input: { plugin: '/p', file: 'f', space: 's1' } } }),
      importResult([threadA], { source: 'p2', plugin: '/p', file: 'f', space: 's1' }),
    ])
    const add = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_request)
    const input = add?.detail?.input as { thread?: { space?: string; label?: string } }
    expect(input.thread?.space).toBe('s1')
    expect(input.thread?.label).toBe('greeter')
  })

  test('a space-stamped proposal event reaches the root dispatcher — the declared space still stamps the target', () => {
    const selected = runProgram([
      proposal({ space: 's1', detail: { id: 'p3', input: { plugin: '/plugins/alpha', file: 't.ts', space: 's1' } } }),
      importResult([threadA], { source: 'p3', plugin: '/plugins/alpha', file: 't.ts', space: 's1' }),
    ])
    // The join: the root dispatcher's unstamped waitFor matches the
    // s1-stamped proposal event (Direction/R) — the import issues.
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p3-import')
    expect(call).toBeDefined()
    // The flow-through: the proposal's declared space reaches the add_thread
    // target stamp (the registry keys per space; admission owns the scope).
    const add = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_request)
    const input = add?.detail?.input as { thread?: { space?: string; label?: string } }
    expect(input.thread?.space).toBe('s1')
    expect(input.thread?.label).toBe('greeter')
  })

  test('a root target (no space) mounts with no space stamp — root-only, never omni', () => {
    const authored = { ...threadA, space: 'author-space' }
    const selected = runProgram([
      proposal(),
      importResult([authored], { source: 'p1', plugin: '/plugins/alpha', file: 't.ts' }),
    ])
    const add = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_request)
    const input = add?.detail?.input as { thread?: Record<string, unknown> }
    expect('space' in (input.thread ?? {})).toBe(false)
  })

  test('an empty validated import proposes nothing — the batch carries only warnings', () => {
    const selected = runProgram([
      proposal(),
      importResult([], { source: 'p1', plugin: '/plugins/alpha', file: 't.ts' }),
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_request)).toBe(false)
  })

  test('a failed import surfaces the typed failure — never a crash', () => {
    const selected = runProgram([
      proposal({ detail: { id: 'p9', input: { plugin: '/p', file: 'broken.ts' } } }),
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: 'p9-import',
          ok: true,
          result: {
            status: 'completed',
            jsonData: { ok: false, error: { code: 'import_failed', message: 'SyntaxError: boom' } },
          },
          ctx: { echo: { source: 'p9', plugin: '/p', file: 'broken.ts' } },
        },
      },
    ])
    const failed = selected.find((s) => s.type === PLUGIN_THREADS_EVENT_TYPES.failed)
    expect(failed).toBeDefined()
    const input = failed?.detail?.input as Record<string, unknown>
    expect(input.plugin).toBe('/p')
    expect(input.file).toBe('broken.ts')
    expect(input.error).toMatchObject({ code: 'import_failed' })
    expect(selected.some((s) => s.type === PLUGIN_THREADS_EVENT_TYPES.candidate)).toBe(false)
  })

  test('a shell-level failure (timeout) surfaces the typed failure too', () => {
    const selected = runProgram([
      proposal({ detail: { id: 'p8', input: { plugin: '/p', file: 'slow.ts' } } }),
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: 'p8-import',
          ok: false,
          error: { code: 'timeout', message: 'deadline exceeded' },
          ctx: { echo: { source: 'p8', plugin: '/p', file: 'slow.ts' } },
        },
      },
    ])
    const failed = selected.find((s) => s.type === PLUGIN_THREADS_EVENT_TYPES.failed)
    expect(failed).toBeDefined()
    const input = failed?.detail?.input as { error?: Record<string, unknown> }
    expect(input.error).toMatchObject({ code: 'timeout' })
  })
})

describe('plugin threads — the import script (real run)', () => {
  const runScript = async (env: Record<string, string>): Promise<Record<string, unknown>> => {
    const proc = Bun.spawn(['bun', 'run', '-'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    })
    proc.stdin.write(PLUGIN_THREAD_IMPORT_SCRIPT)
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    return JSON.parse(stdout) as Record<string, unknown>
  }

  test('imports the file in-worker, validates every export against the engine ThreadSchema, hashes the content', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'plugin-threads-'))
    try {
      const dir = join(plugin, 'sh.behavioral/threads')
      mkdirSync(dir, { recursive: true })
      const source =
        "export const greeter = { label: 'greeter', once: true, rules: [{ request: { type: 'hello' } }] }\n" +
        'export const notAThread = { nope: true }\n'
      writeFileSync(join(dir, 't.ts'), source)

      const out = await runScript({ PLUGIN_THREADS_ROOT: plugin, PLUGIN_THREADS_FILE: 't.ts' })
      const threads = out.threads as { label?: string }[]
      expect(threads).toHaveLength(1)
      expect(threads[0]?.label).toBe('greeter')
      const warnings = out.warnings as string[]
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('notAThread')
      // the content hash — the registry's re-arm key
      expect(out.hash).toBe(new Bun.CryptoHasher('sha256').update(source).digest('hex'))
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })

  test('an unparseable file surfaces the typed import error — never a crash', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'plugin-threads-'))
    try {
      const dir = join(plugin, 'sh.behavioral/threads')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'broken.ts'), 'export const = {{{ not ts')
      const out = await runScript({ PLUGIN_THREADS_ROOT: plugin, PLUGIN_THREADS_FILE: 'broken.ts' })
      expect(out.ok).toBe(false)
      const error = out.error as { code?: string; message?: string }
      expect(error.code).toBe('import_failed')
      expect(typeof error.message).toBe('string')
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })

  test('a missing file surfaces the typed read error', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'plugin-threads-'))
    try {
      const out = await runScript({ PLUGIN_THREADS_ROOT: plugin, PLUGIN_THREADS_FILE: 'absent.ts' })
      expect(out.ok).toBe(false)
      expect((out.error as { code?: string }).code).toBe('read_failed')
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })
})
