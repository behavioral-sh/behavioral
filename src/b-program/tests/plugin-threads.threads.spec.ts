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
import type { BPEvent, JsonObject, Thread } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { hashString } from '../../utils.ts'
import {
  PLUGIN_THREAD_IMPORT_SCRIPT,
  PLUGIN_THREADS_EVENT_TYPES,
  pluginThreadsThreads,
} from '../plugin-threads.threads.ts'
import { driveComposition } from './composition-drive.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = async (events: BPEvent[]): Promise<Selected[]> => {
  // Mint semantics (the transform-faculty ruling): the pack's transform
  // listeners complete only through the fixed fourth faculty — the drive is
  // async and settles on quiescence. Zero thread edits.
  const drive = driveComposition({ threads: pluginThreadsThreads })
  try {
    for (const event of events) drive.trigger(event)
    await drive.settle()
    return drive.selected
  } finally {
    drive.terminate()
  }
}

const proposal = (over: Partial<BPEvent> = {}): BPEvent => ({
  type: PLUGIN_THREADS_EVENT_TYPES.proposal,
  detail: { id: 'p1', input: { plugin: '/plugins/alpha', file: 't.ts' } },
  ...over,
})

describe('plugin threads — import issue', () => {
  test('a proposal issues the plugin-threads import shell_request: run op, label, env-carried target, ctx echo', async () => {
    const selected = await runProgram([proposal()])
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

  test('a proposal with a target space carries it on the echo', async () => {
    const selected = await runProgram([
      proposal({ detail: { id: 'p2', input: { plugin: '/plugins/alpha', file: 't.ts', space: 's1' } } }),
    ])
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p2-import')
    const ctx = call?.detail?.ctx as { echo?: Record<string, unknown> }
    expect(ctx?.echo).toMatchObject({ source: 'p2', space: 's1' })
  })

  test('a malformed proposal (missing plugin) never issues an import', async () => {
    const selected = await runProgram([
      { type: PLUGIN_THREADS_EVENT_TYPES.proposal, detail: { id: 'p3', input: { file: 't.ts' } } },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p3-import')).toBe(
      false,
    )
  })
})

describe('plugin threads — the join and the candidates', () => {
  const threadA: Thread = {
    name: 'greeter',
    description: 'Test thread.',
    once: true,
    rules: [{ request: { type: 'hello' } }],
  }
  const threadB: Thread = {
    name: 'farewell',
    description: 'Test thread.',
    once: true,
    rules: [{ request: { type: 'bye' } }],
  }

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
          jsonData: {
            threads: threads as unknown as JsonObject[],
            warnings: ['a warning'],
            hash: 'abc123',
            sourceHash: hashString('/plugins/alpha'),
          },
        },
        ctx: { echo },
      },
    }) as unknown as BPEvent

  test('a validated import surfaces the batch and proposes one add_thread per thread', async () => {
    const selected = await runProgram([
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
    expect(importedInput.sourceHash).toBe(hashString('/plugins/alpha'))
    expect(importedInput.threads).toHaveLength(2)
    expect(importedInput.warnings).toEqual(['a warning'])
    // one add_thread proposal per thread, correlated ids
    const adds = selected.filter((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request)
    expect(adds.map((s) => s.detail?.id)).toEqual(['p1-add-0', 'p1-add-1'])
    for (const add of adds) {
      expect(add.detail?.op).toBe('add_thread')
      const input = add.detail?.input as { thread?: { name?: string; sourceHash?: number } }
      const label = input.thread?.name ?? ''
      expect(['greeter', 'farewell']).toContain(label)
      // PROVENANCE: the candidate's thread carries the source hash — djb2 over
      // the plugin's canonical source path — stamped at the proposal path.
      expect(input.thread?.sourceHash).toBe(hashString('/plugins/alpha'))
    }
  })

  test('a named target space stamps the proposed thread — the admission owns the mount scope', async () => {
    const selected = await runProgram([
      proposal({ detail: { id: 'p2', input: { plugin: '/p', file: 'f', space: 's1' } } }),
      importResult([threadA], { source: 'p2', plugin: '/p', file: 'f', space: 's1' }),
    ])
    const add = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request)
    const input = add?.detail?.input as { thread?: { space?: string; name?: string } }
    expect(input.thread?.space).toBe('s1')
    expect(input.thread?.name).toBe('greeter')
  })

  test('a space-stamped proposal event reaches the root dispatcher — the declared space still stamps the target', async () => {
    const selected = await runProgram([
      proposal({ space: 's1', detail: { id: 'p3', input: { plugin: '/plugins/alpha', file: 't.ts', space: 's1' } } }),
      importResult([threadA], { source: 'p3', plugin: '/plugins/alpha', file: 't.ts', space: 's1' }),
    ])
    // The join: the root dispatcher's unstamped waitFor matches the
    // s1-stamped proposal event (Direction/R) — the import issues.
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === 'p3-import')
    expect(call).toBeDefined()
    // The flow-through: the proposal's declared space reaches the add_thread
    // target stamp (the registry keys per space; admission owns the scope).
    const add = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request)
    const input = add?.detail?.input as { thread?: { space?: string; name?: string } }
    expect(input.thread?.space).toBe('s1')
    expect(input.thread?.name).toBe('greeter')
  })

  test('a root target (no space) mounts with no space stamp — root-only, never omni', async () => {
    const authored = { ...threadA, space: 'author-space' }
    const selected = await runProgram([
      proposal(),
      importResult([authored], { source: 'p1', plugin: '/plugins/alpha', file: 't.ts' }),
    ])
    const add = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request)
    const input = add?.detail?.input as { thread?: Record<string, unknown> }
    expect('space' in (input.thread ?? {})).toBe(false)
  })

  test('an empty validated import proposes nothing — the batch carries only warnings', async () => {
    const selected = await runProgram([
      proposal(),
      importResult([], { source: 'p1', plugin: '/plugins/alpha', file: 't.ts' }),
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request)).toBe(false)
  })

  test('a failed import surfaces the typed failure — never a crash', async () => {
    const selected = await runProgram([
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

  test('a shell-level failure (timeout) surfaces the typed failure too', async () => {
    const selected = await runProgram([
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
  test("a thread name colliding with the plugin's skill or MCP surface is skipped with a warning — clean siblings still import", async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'plugin-threads-'))
    try {
      // the plugin's claimed namespaces: a skill dir named 'greeter', an MCP
      // server named 'farewell' — the within-plugin union the pass enforces
      mkdirSync(join(plugin, 'skills/greeter'), { recursive: true })
      writeFileSync(join(plugin, 'skills/greeter/SKILL.md'), '---\nname: greeter\ndescription: d\n---\nbody')
      writeFileSync(
        join(plugin, 'mcp.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: { farewell: { type: 'stdio', command: './run.sh' } },
        }),
      )
      const dir = join(plugin, 'sh.behavioral/threads')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 't.ts'),
        "export const a = { name: 'greeter', description: 'Test thread.', once: true, rules: [{ request: { type: 'a' } }] }\n" +
          "export const b = { name: 'farewell', description: 'Test thread.', once: true, rules: [{ request: { type: 'b' } }] }\n" +
          "export const c = { name: 'clean', description: 'Test thread.', once: true, rules: [{ request: { type: 'c' } }] }\n",
      )
      const out = await runScript({ PLUGIN_THREADS_ROOT: plugin, PLUGIN_THREADS_FILE: 't.ts' })
      const threads = out.threads as { name?: string }[]
      expect(threads.map((t) => t?.name).sort()).toEqual(['clean'])
      const warnings = out.warnings as string[]
      expect(warnings.some((w) => w.includes('greeter') && w.includes('collision'))).toBe(true)
      expect(warnings.some((w) => w.includes('farewell') && w.includes('collision'))).toBe(true)
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })

  test('two plugins MAY export the same thread name — cross-plugin uniqueness is not a concern (the source hash disambiguates)', async () => {
    const source =
      "export const greeter = { name: 'greeter', description: 'Test thread.', once: true, rules: [{ request: { type: 'hello' } }] }\n"
    const pluginA = mkdtempSync(join(tmpdir(), 'plugin-threads-a-'))
    const pluginB = mkdtempSync(join(tmpdir(), 'plugin-threads-b-'))
    try {
      for (const plugin of [pluginA, pluginB]) {
        const dir = join(plugin, 'sh.behavioral/threads')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 't.ts'), source)
      }
      const outA = await runScript({ PLUGIN_THREADS_ROOT: pluginA, PLUGIN_THREADS_FILE: 't.ts' })
      const outB = await runScript({ PLUGIN_THREADS_ROOT: pluginB, PLUGIN_THREADS_FILE: 't.ts' })
      for (const out of [outA, outB]) {
        const threads = out.threads as { name?: string; sourceHash?: number }[]
        expect(threads).toHaveLength(1)
        expect(threads[0]?.name).toBe('greeter')
      }
      // same name, distinct provenance — the source hash disambiguates
      expect(outA.sourceHash).not.toBe(outB.sourceHash)
    } finally {
      rmSync(pluginA, { recursive: true, force: true })
      rmSync(pluginB, { recursive: true, force: true })
    }
  })

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
        "export const greeter = { name: 'greeter',        description: 'Test thread.', once: true, rules: [{ request: { type: 'hello' } }] }\n" +
        'export const notAThread = { nope: true }\n'
      writeFileSync(join(dir, 't.ts'), source)

      const out = await runScript({ PLUGIN_THREADS_ROOT: plugin, PLUGIN_THREADS_FILE: 't.ts' })
      const threads = out.threads as { name?: string }[]
      expect(threads).toHaveLength(1)
      expect(threads[0]?.name).toBe('greeter')
      const warnings = out.warnings as string[]
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('notAThread')
      // the content hash — the registry's re-arm key
      expect(out.hash).toBe(new Bun.CryptoHasher('sha256').update(source).digest('hex'))
      // the source hash — provenance: djb2 over the plugin's canonical source path
      expect(out.sourceHash).toBe(hashString(plugin))
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
