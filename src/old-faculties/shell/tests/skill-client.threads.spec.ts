/**
 * The skill-client thread library against the real engine — the ICL
 * replacement for the skill-discover tool: a boot thread requests the scan
 * recipe through the shell worker (the run op), and a transform
 * threads the result into a store put of the catalog. The recipe itself is
 * run for real against a fixture tree (read file → slice frontmatter fence →
 * YAML.parse the slice).
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { SKILL_SCAN_CALL_ID, SKILL_SCAN_SCRIPT, skillThreads } from '../threads.ts'

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
  for (const thread of skillThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  // addThread is inert — trigger admits one ingress event and runs one
  // super-step; the second pump cascades transform re-entries.
  program.trigger({ type: 'skill_gate_pump', detail: {} })
  program.trigger({ type: 'skill_gate_pump', detail: {} })
  return selected
}

describe('skill threads — scan boot', () => {
  test('boot requests the skill-scan shell_request: the run op carries the recipe, json format', () => {
    const selected = runProgram([])
    const call = selected.find(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === SKILL_SCAN_CALL_ID,
    )
    expect(call).toBeDefined()
    expect(call?.detail?.label).toBe('skill-scan')
    const input = call?.detail?.input as JsonObject
    expect(input.op).toBe('run')
    expect(input.format).toBe('json')
    expect(input.script).toBe(SKILL_SCAN_SCRIPT)
    // the recipe reads each SKILL.md, slices the frontmatter fence, then YAML.parses the slice
    expect(String(input.script).includes('YAML.parse')).toBe(true)
    expect(String(input.script).includes('---')).toBe(true)
  })

  test('boot fires once — a second pump adds no duplicate call', () => {
    const selected = runProgram([])
    const calls = selected.filter(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === SKILL_SCAN_CALL_ID,
    )
    expect(calls).toHaveLength(1)
  })
})

describe('skill threads — catalog transform', () => {
  test('a scan result with a skills catalog is put into the store as one value', () => {
    const catalog = {
      skills: [{ name: 'alpha', description: 'does alpha things', location: '/x/SKILL.md' }],
      warnings: [],
    }
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: SKILL_SCAN_CALL_ID, result: { status: 'completed', jsonData: catalog } },
      },
    ])
    const put = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    expect(put).toBeDefined()
    const input = put?.detail?.input as JsonObject
    expect(input.collection).toBe('skills')
    expect(input.key).toBe('catalog')
    expect(input.value).toEqual(catalog)
  })

  test('a result without a catalog does not put', () => {
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'other-call', result: { status: 'completed', lines: ['x'], totalLines: 1 } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })

  test('a malformed catalog fails the detailSchema gate — fail-closed, never partial admission', () => {
    // `skills` is present (the jq filter passes) but not an array of records —
    // the envelope schema must reject the whole put, not admit the bad value.
    const malformed = { skills: 'not-an-array', warnings: [] }
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: SKILL_SCAN_CALL_ID, result: { status: 'completed', jsonData: malformed } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })
})

describe('skill scan recipe — frontmatter validation (real run)', () => {
  test('scans project + user roots, validates frontmatter, prints the catalog as JSON', async () => {
    const project = mkdtempSync(join(tmpdir(), 'skill-scan-project-'))
    const home = mkdtempSync(join(tmpdir(), 'skill-scan-home-'))
    try {
      mkdirSync(join(project, '.agents/skills/alpha'), { recursive: true })
      writeFileSync(
        join(project, '.agents/skills/alpha/SKILL.md'),
        '---\nname: alpha\ndescription: does alpha things\n---\n\nDo alpha.\n',
      )
      mkdirSync(join(project, '.agents/skills/broken'), { recursive: true })
      writeFileSync(join(project, '.agents/skills/broken/SKILL.md'), '---\nname: broken: unquoted: colons\n---\nbody')
      // a directory with no SKILL.md is skipped silently
      mkdirSync(join(project, '.agents/skills/no-skill-md'), { recursive: true })
      // user-level alpha is overridden by the project-level alpha
      mkdirSync(join(home, '.agents/skills/alpha'), { recursive: true })
      writeFileSync(
        join(home, '.agents/skills/alpha/SKILL.md'),
        '---\nname: alpha\ndescription: user-level alpha\n---\nbody',
      )

      const proc = Bun.spawn(['bun', 'run', '-'], {
        cwd: project,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: home },
      })
      proc.stdin.write(SKILL_SCAN_SCRIPT)
      proc.stdin.end()
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      expect([exitCode, stderr]).toEqual([0, ''])

      const out = JSON.parse(stdout) as { skills: JsonObject[]; warnings: string[] }
      expect(out.skills).toHaveLength(1)
      expect(out.skills[0]).toMatchObject({ name: 'alpha', description: 'does alpha things' })
      expect(out.warnings.some((w) => w.includes('project-level overrides user-level'))).toBe(true)
      expect(out.warnings.some((w) => w.includes('broken') && w.includes('unparseable'))).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
