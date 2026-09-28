/**
 * The skill-links thread library against the real engine — the contract pair
 * of the ICL architecture: extract-links and validate-links are STORED
 * RECIPES (test-pinned semantics replayed verbatim). Two thread roles: the
 * seeder puts the recipes into the store at boot (recipes-as-tenant, the
 * model/ICL surface); the dispatchers turn a links_request into the
 * shell_request run-op (recipe static on input, markdown via env). The recipes run for
 * real through `bun run -` in the integration describe (fixture port of the
 * tool-spec cases).
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
  LINKS_EXTRACT_RECIPE_KEY,
  LINKS_RECIPES_COLLECTION,
  SKILL_EXTRACT_LINKS_SCRIPT,
  SKILL_VALIDATE_LINKS_SCRIPT,
  skillLinksThreads,
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
  for (const thread of skillLinksThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  program.trigger({ type: 'links_gate_pump', detail: {} })
  program.trigger({ type: 'links_gate_pump', detail: {} })
  return selected
}

describe('skill-links threads — recipe seeding', () => {
  test('boot seeds both recipes into the store (recipes-as-tenant)', () => {
    const selected = runProgram([])
    const puts = selected.filter((s) => s.type === FACULTY_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    const keys = puts.map((p) => (p.detail?.input as JsonObject)?.key).sort()
    expect(keys).toEqual(['extract-links', 'validate-links'])
    const extract = puts.find((p) => (p.detail?.input as JsonObject)?.key === LINKS_EXTRACT_RECIPE_KEY)
    expect((extract?.detail?.input as JsonObject)?.collection).toBe(LINKS_RECIPES_COLLECTION)
    expect((extract?.detail?.input as JsonObject)?.value).toBe(SKILL_EXTRACT_LINKS_SCRIPT)
    const validate = puts.find((p) => (p.detail?.input as JsonObject)?.key === 'validate-links')
    expect((validate?.detail?.input as JsonObject)?.value).toBe(SKILL_VALIDATE_LINKS_SCRIPT)
  })

  test('seeding fires once per key — a second pump adds no duplicate puts', () => {
    const selected = runProgram([])
    const puts = selected.filter((s) => s.type === FACULTY_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    expect(puts).toHaveLength(2)
  })
})

describe('skill-links threads — dispatchers', () => {
  test('an extract links_request becomes the extract shell_request: recipe static on the run op, markdown via env', () => {
    const selected = runProgram([
      {
        type: 'links_request',
        detail: {
          id: 'l1',
          recipe: 'extract-links',
          input: { markdown: 'See [a](scripts/a.ts)' },
        },
      },
    ])
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)
    expect(call).toBeDefined()
    expect(call?.detail?.id).toBe('l1')
    expect(call?.detail?.label).toBe('skill-extract-links')
    const input = call?.detail?.input as JsonObject
    expect(input.op).toBe('run')
    expect(input.script).toBe(SKILL_EXTRACT_LINKS_SCRIPT)
    expect(input.format).toBe('json')
    expect((input.env as JsonObject)?.LINKS_INPUT).toBe('See [a](scripts/a.ts)')
  })

  test('a validate links_request becomes the validate shell_request: rootRelative rides env', () => {
    const selected = runProgram([
      {
        type: 'links_request',
        detail: {
          id: 'l2',
          recipe: 'validate-links',
          input: { markdown: 'See [x](docs/x.md)', rootRelative: true },
        },
      },
    ])
    const call = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)
    expect(call?.detail?.label).toBe('skill-validate-links')
    const input = call?.detail?.input as JsonObject
    expect(input.script).toBe(SKILL_VALIDATE_LINKS_SCRIPT)
    expect((input.env as JsonObject)?.LINKS_INPUT).toBe('See [x](docs/x.md)')
    expect((input.env as JsonObject)?.LINKS_ROOT_RELATIVE).toBe('1')
  })

  test('a request for an unknown recipe dispatches nothing', () => {
    const selected = runProgram([
      {
        type: 'links_request',
        detail: { id: 'l3', recipe: 'nope', input: { markdown: 'x' } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
  })
})

describe('skill-links recipes — real bun run - runs (fixture port)', () => {
  const runRecipe = async (
    script: string,
    markdown: string,
    env: Record<string, string> = {},
    cwd?: string,
  ): Promise<unknown> => {
    const proc = Bun.spawn(['bun', 'run', '-'], {
      ...(cwd === undefined ? {} : { cwd }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LINKS_INPUT: markdown, ...env },
    })
    proc.stdin.write(script)
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    expect([exitCode, stderr]).toEqual([0, ''])
    return JSON.parse(stdout)
  }

  test('extract-links returns sorted, de-duplicated local links with display text', async () => {
    const out = (await runRecipe(
      SKILL_EXTRACT_LINKS_SCRIPT,
      'See [b](scripts/b.ts) and [a](scripts/a.ts) ![d](assets/d.png) [a again](scripts/a.ts)',
    )) as { links: Array<{ value: string; text: string }> }
    expect(out.links).toEqual([
      { value: 'assets/d.png', text: 'd' },
      { value: 'scripts/a.ts', text: 'a' },
      { value: 'scripts/b.ts', text: 'b' },
    ])
  })

  test('extract-links drops external and fragment-only; keeps inline HTML', async () => {
    const out = (await runRecipe(
      SKILL_EXTRACT_LINKS_SCRIPT,
      '[site](https://example.com) [mail](mailto:a@b.c) [frag](#section) <a href="docs/guide.md">guide</a> <img src="assets/logo.png" alt="logo">',
    )) as { links: Array<{ value: string; text: string }> }
    expect(out.links).toEqual([
      { value: 'assets/logo.png', text: 'logo' },
      { value: 'docs/guide.md', text: 'guide' },
    ])
  })

  test('validate-links returns present and missing resolved against cwd', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'behavioral-links-'))
    try {
      mkdirSync(join(baseDir, 'docs'), { recursive: true })
      writeFileSync(join(baseDir, 'docs/guide.md'), '# guide')
      const out = (await runRecipe(
        SKILL_VALIDATE_LINKS_SCRIPT,
        'See [guide](docs/guide.md) and [missing](docs/missing.md)',
        {},
        baseDir,
      )) as { present: unknown[]; missing: unknown[] }
      expect(out.present).toEqual([{ value: 'docs/guide.md', text: 'guide' }])
      expect(out.missing).toEqual([{ value: 'docs/missing.md', text: 'missing' }])
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test('validate-links rootRelative resolves leading-slash against cwd', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'behavioral-links-'))
    try {
      mkdirSync(join(baseDir, 'tables'), { recursive: true })
      writeFileSync(join(baseDir, 'tables/customers.md'), '# customers')
      const out = (await runRecipe(
        SKILL_VALIDATE_LINKS_SCRIPT,
        'See [customers](/tables/customers.md) and [gone](/tables/gone.md)',
        { LINKS_ROOT_RELATIVE: '1' },
        baseDir,
      )) as { present: unknown[]; missing: unknown[] }
      expect(out.present).toEqual([{ value: '/tables/customers.md', text: 'customers' }])
      expect(out.missing).toEqual([{ value: '/tables/gone.md', text: 'gone' }])
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
