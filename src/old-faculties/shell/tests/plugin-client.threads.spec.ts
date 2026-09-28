/**
 * The plugin-client thread library against the real engine — the ICL
 * replacement for the plugin-client tool: a boot thread requests the
 * manifest-scan recipe through the tools worker (`bun run -` on stdin), and
 * a transform threads the result into the store as the PLUGINS manifest
 * tenant. The recipe itself runs for real against fixture plugin trees
 * (plugin.json + mcp.json §11.3 posture, skills/ + sh.behavioral/threads/ discovery).
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import {
  PLUGIN_MANIFESTS_COLLECTION,
  PLUGIN_MANIFESTS_KEY,
  PLUGIN_SCAN_CALL_ID,
  PLUGIN_SCAN_SCRIPT,
  pluginThreads,
} from '../threads.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = (events: BPEvent[]): Selected[] => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  for (const thread of pluginThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  // addThread is inert — trigger admits one ingress event and runs one
  // super-step; the second pump cascades transform re-entries.
  program.trigger({ type: 'plugin_gate_pump', detail: {} })
  program.trigger({ type: 'plugin_gate_pump', detail: {} })
  return selected
}

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

describe('plugin threads — scan boot', () => {
  test('boot requests the plugin-scan shell_request: the run op carries the recipe, json format', () => {
    const selected = runProgram([])
    const call = selected.find(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === PLUGIN_SCAN_CALL_ID,
    )
    expect(call).toBeDefined()
    expect(call?.detail?.label).toBe('plugin-scan')
    const input = call?.detail?.input as JsonObject
    expect(input.op).toBe('run')
    expect(input.format).toBe('json')
    expect(input.script).toBe(PLUGIN_SCAN_SCRIPT)
    // the recipe validates plugin.json + mcp.json and discovers skills/threads
    expect(String(input.script).includes('plugin.json')).toBe(true)
    expect(String(input.script).includes('mcp.json')).toBe(true)
  })

  test('boot fires once — a second pump adds no duplicate call', () => {
    const selected = runProgram([])
    const calls = selected.filter(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === PLUGIN_SCAN_CALL_ID,
    )
    expect(calls).toHaveLength(1)
  })
})

describe('plugin threads — manifests transform', () => {
  test('a scan result with manifests is put into the store as one value', () => {
    const manifests = {
      plugins: [
        {
          name: 'alpha',
          version: '1.0.0',
          mcps: { ok: { type: 'stdio', command: './run.sh' } },
          skills: ['alpha'],
          threads: ['t.ts'],
          warnings: [],
        },
      ],
      warnings: [],
    }
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: PLUGIN_SCAN_CALL_ID, result: { status: 'completed', jsonData: manifests } },
      },
    ])
    const put = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    expect(put).toBeDefined()
    const input = put?.detail?.input as JsonObject
    expect(input.collection).toBe(PLUGIN_MANIFESTS_COLLECTION)
    expect(input.key).toBe(PLUGIN_MANIFESTS_KEY)
    expect(input.value).toEqual(manifests)
  })

  test('a result without manifests does not put', () => {
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'other-call', result: { status: 'completed', lines: ['x'], totalLines: 1 } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })

  test('a malformed manifest set fails the detailSchema gate — fail-closed, never partial admission', () => {
    // `plugins` is present (the jq filter passes) but not an array — the
    // envelope schema must reject the whole put, not admit the bad value.
    const malformed = { plugins: 'not-an-array', warnings: [] }
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: PLUGIN_SCAN_CALL_ID, result: { status: 'completed', jsonData: malformed } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })
})

describe('plugin scan recipe — manifest validation (real run)', () => {
  test('scans project + user roots, applies the §11.3 posture, prints manifests as JSON', async () => {
    const project = mkdtempSync(join(tmpdir(), 'plugin-scan-project-'))
    const home = mkdtempSync(join(tmpdir(), 'plugin-scan-home-'))
    try {
      // a good plugin: plugin.json + mcp.json (one ok server, one bad entry —
      // failure isolation), skills/, threads/, and an unknown top-level field
      const goodDir = join(project, '.agents/plugins/alpha')
      mkdirSync(goodDir, { recursive: true })
      writeFileSync(
        join(goodDir, 'plugin.json'),
        JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'alpha', version: '1.0.0', mystery: true }),
      )
      writeFileSync(
        join(goodDir, 'mcp.json'),
        JSON.stringify({
          $schema: MCP_SCHEMA,
          mcpServers: {
            ok: { type: 'stdio', command: './run.sh' },
            bad: { type: 'stdio', command: 'a b', args: 'not-an-array' },
          },
        }),
      )
      mkdirSync(join(goodDir, 'skills/alpha'), { recursive: true })
      writeFileSync(join(goodDir, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: d\n---\nbody')
      // behavioral-specific threads live under the reverse-domain namespace
      // dir (agent-plugins §8.2): sh.behavioral/threads/ is discovered…
      mkdirSync(join(goodDir, 'sh.behavioral/threads'), { recursive: true })
      writeFileSync(join(goodDir, 'sh.behavioral/threads/t.ts'), 'export const t = 1')
      // …and the pre-1.0 top-level threads/ location is NOT (breaks outright)
      mkdirSync(join(goodDir, 'threads'), { recursive: true })
      writeFileSync(join(goodDir, 'threads/legacy.ts'), 'export const legacy = 1')

      // a fatal plugin: wrong $schema — rejected, no components discovered
      const fatalDir = join(home, '.agents/plugins/broken')
      mkdirSync(fatalDir, { recursive: true })
      writeFileSync(
        join(fatalDir, 'plugin.json'),
        JSON.stringify({ $schema: 'https://wrong.example.com/schema.json', name: 'broken' }),
      )

      // a user-level good plugin that also loads
      const userDir = join(home, '.agents/plugins/beta')
      mkdirSync(userDir, { recursive: true })
      writeFileSync(join(userDir, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'beta' }))

      const proc = Bun.spawn(['bun', 'run', '-'], {
        cwd: project,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: home },
      })
      proc.stdin.write(PLUGIN_SCAN_SCRIPT)
      proc.stdin.end()
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      expect([exitCode, stderr]).toEqual([0, ''])

      const out = JSON.parse(stdout) as {
        plugins: Array<{
          name: string
          mcps: Record<string, unknown>
          skills: string[]
          threads: string[]
          warnings: string[]
        }>
        warnings: string[]
      }
      const names = out.plugins.map((p) => p.name).sort()
      expect(names).toEqual(['alpha', 'beta'])

      const alpha = out.plugins.find((p) => p.name === 'alpha')
      expect(Object.keys(alpha?.mcps ?? {})).toEqual(['ok'])
      expect(alpha?.skills).toEqual(['alpha'])
      expect(alpha?.threads).toEqual(['t.ts'])
      // §5.2 report-and-ignore: unknown top-level field warned, plugin loads
      expect(alpha?.warnings.some((w) => w.includes('unknown top-level field') && w.includes('mystery'))).toBe(true)
      // §7.2 failure isolation: the bad server skipped, the sibling loaded
      expect(alpha?.warnings.some((w) => w.includes('"bad"') && w.includes('skipped'))).toBe(true)

      // the fatal plugin is skipped with a warning; no components discovered
      expect(out.warnings.some((w) => w.includes('broken') && w.includes('$schema'))).toBe(true)
      expect(out.warnings.some((w) => w.includes('Skipped plugin'))).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
