/**
 * The skill-client thread library through the REAL composition — the ICL
 * replacement for the skill-discover tool: a boot thread requests the scan
 * recipe through the shell worker (the run op), and a transform
 * threads the result into a store put of the catalog. The recipe itself is
 * run for real against a fixture tree (read file → slice frontmatter fence →
 * YAML.parse the slice).
 *
 * Mint semantics (the transform-faculty ruling): the catalog transform
 * completes only through the fixed fourth faculty — the drive is async and
 * settles on quiescence. Zero thread edits: the pack mounts unchanged.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BPEvent, JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { SKILL_SCAN_CALL_ID, SKILL_SCAN_SCRIPT, skillThreads } from '../shell.threads.ts'
import { driveComposition } from './composition-drive.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = async (events: BPEvent[]): Promise<Selected[]> => {
  const drive = driveComposition({ threads: skillThreads })
  try {
    for (const event of events) drive.trigger(event)
    await drive.settle()
    return drive.selected
  } finally {
    drive.terminate()
  }
}

describe('skill threads — scan boot', () => {
  test('boot requests the skill-scan shell_request: the run op carries the recipe, json format', async () => {
    const selected = await runProgram([])
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

  test('boot fires once — a second pump adds no duplicate call', async () => {
    const selected = await runProgram([])
    const calls = selected.filter(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === SKILL_SCAN_CALL_ID,
    )
    expect(calls).toHaveLength(1)
  })
})

describe('skill threads — catalog transform', () => {
  test('a scan result with a skills catalog is put into the store as one value', async () => {
    const catalog = {
      skills: [{ name: 'alpha', description: 'does alpha things', location: '/x/SKILL.md' }],
      warnings: [],
    }
    const selected = await runProgram([
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

  test('a result without a catalog does not put', async () => {
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'other-call', result: { status: 'completed', lines: ['x'], totalLines: 1 } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })

  test('a malformed catalog fails the detailSchema gate — fail-closed, never partial admission', async () => {
    // `skills` is present (the jq filter passes) but not an array of records —
    // the envelope schema must reject the whole put, not admit the bad value.
    const malformed = { skills: 'not-an-array', warnings: [] }
    const selected = await runProgram([
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

  test('name/dir mismatch warns but the skill still loads — the INTENTIONAL leniency (do not harden)', async () => {
    // PIN (the thread-identity ruling): the agentskills spec requires name ==
    // parent directory, but the scan is deliberately lenient — the mismatch
    // surfaces as a visible warning while the skill loads. The within-plugin
    // collision pass can rely on directory names (filesystem-precluded
    // duplicates); the frontmatter name staying off is the operator's signal.
    const project = mkdtempSync(join(tmpdir(), 'skill-scan-mismatch-'))
    try {
      mkdirSync(join(project, '.agents/skills/misnamed'), { recursive: true })
      writeFileSync(
        join(project, '.agents/skills/misnamed/SKILL.md'),
        '---\nname: other-name\ndescription: mismatched but loads\n---\nbody',
      )
      const proc = Bun.spawn(['bun', 'run', '-'], {
        cwd: project,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: project },
      })
      proc.stdin.write(SKILL_SCAN_SCRIPT)
      proc.stdin.end()
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      expect(exitCode).toBe(0)
      const out = JSON.parse(stdout) as { skills: JsonObject[]; warnings: string[] }
      // the skill LOADED under its frontmatter name…
      expect(out.skills).toHaveLength(1)
      expect(out.skills[0]).toMatchObject({ name: 'other-name' })
      // …and the mismatch is VISIBLE, never silent
      expect(out.warnings.some((w) => w.includes('does not match parent directory'))).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
