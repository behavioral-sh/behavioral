/**
 * The ui_* producer threads — the view-generation policy (composition
 * territory, no process). Slice coverage here:
 *
 * - the design.md scan → store tenant (the boot scan recipe through the
 *   shell `run` op, the lenient consumer-table validation, the warnings-as-
 *   data posture, the no-lock contract: the USER's `<home>/DESIGN.md` only);
 * - the scale preflight (block-then-stamp over `ui_scale_check`);
 * - the generation lane (the design tenant → systemTwo → `ui_render`,
 *   validate-before-request, the custom-properties artifact, the plain
 *   degradation when no tenant exists);
 * - the autoresearch loop capture is pinned in ui-capture.spec.ts.
 *
 * Engine-level specs drive the pure threads through the real engine (the
 * skill-client spec pattern); composition-level specs drive the real
 * bProgram — the serve dispatcher included — against real faculty processes
 * and the fixture Open Responses endpoint.
 */

import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bProgram } from '../../b-program/b-program.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, PendingBidsTrace, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import {
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  StoreRequestEventSchema,
  StoreRequestResultEventSchema,
} from '../../faculties/faculties.types.ts'
import { useSystemTwo } from '../../faculties/system-two/config.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from '../../faculties/system-two/tests/fixtures/model-server.ts'
import { useFaculty } from '../../faculties/use-faculty.ts'
import { createHost, dispatchToRuntime } from '../serve.ts'
import {
  DESIGN_SCAN_SCRIPT,
  UI_DESIGN_ARTIFACT_KEY,
  UI_DESIGN_COLLECTION,
  UI_DESIGN_CONTEXT_KEY,
  UI_DESIGN_SCAN_CALL_ID,
  UI_GENERATE_EVENT_TYPE,
  uiPipelineThreads,
  uiThreads,
} from '../ui-threads.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** Drive the thread set through the real engine — the skill-client spec harness. */
const runProgram = (events: BPEvent[]): { selected: Selected[]; traces: Trace[] } => {
  const program = behavioral()
  const selected: Selected[] = []
  const traces: Trace[] = []
  program.useTrace((trace: Trace) => {
    traces.push(trace)
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  for (const thread of uiThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  // addThread is inert — trigger admits one ingress event and runs one
  // super-step; the second pump cascades transform re-entries.
  program.trigger({ type: 'ui_threads_pump', detail: {} })
  program.trigger({ type: 'ui_threads_pump', detail: {} })
  return { selected, traces }
}

/** Run one scan recipe for real (bun-direct, the run-op contract) against a home. */
const runScan = async (env: Record<string, string>) => {
  const proc = Bun.spawn(['bun', 'run', '-'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  proc.stdin.write(DESIGN_SCAN_SCRIPT)
  proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

// ─── Slice 1 — the design.md scan → store tenant ─────────────────────────────

describe('ui threads — the design scan boot', () => {
  test('boot requests the design-scan shell_request: the run op carries the recipe, json format', () => {
    const { selected } = runProgram([])
    const call = selected.find(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === UI_DESIGN_SCAN_CALL_ID,
    )
    expect(call).toBeDefined()
    expect(call?.detail?.label).toBe('design-scan')
    const input = call?.detail?.input as JsonObject
    expect(input.op).toBe('run')
    expect(input.format).toBe('json')
    expect(input.script).toBe(DESIGN_SCAN_SCRIPT)
  })

  test('boot fires once — a second pump adds no duplicate call', () => {
    const { selected } = runProgram([])
    const calls = selected.filter(
      (s) => s.type === FACULTY_MESSAGE_KINDS.shell_request && s.detail?.id === UI_DESIGN_SCAN_CALL_ID,
    )
    expect(calls).toHaveLength(1)
  })
})

describe('ui threads — the design tenant transform', () => {
  test('a scan result with a design context is put into the store as the design tenant', () => {
    const context = {
      tokens: { colors: { primary: '#101010' } },
      sections: { Overview: 'Matte surfaces.' },
      warnings: [],
    }
    const { selected } = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: UI_DESIGN_SCAN_CALL_ID, result: { status: 'completed', jsonData: context } },
      },
    ])
    const put = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    expect(put).toBeDefined()
    const input = put?.detail?.input as JsonObject
    expect(input.collection).toBe('design')
    expect(input.key).toBe('context')
    expect(input.value).toEqual(context)
  })

  test('a missing DESIGN.md (the empty scan shape) puts nothing — no tenant, no warning-spam', () => {
    const { selected } = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: UI_DESIGN_SCAN_CALL_ID,
          result: { status: 'completed', jsonData: { tokens: null, sections: null, warnings: [] } },
        },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })

  test('a warnings-only scan result (the rejected file) still puts — the rejection rides the tenant', () => {
    const rejected = {
      tokens: null,
      sections: null,
      warnings: ['Duplicate section heading "## Colors": the file is rejected'],
    }
    const { selected } = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: UI_DESIGN_SCAN_CALL_ID, result: { status: 'completed', jsonData: rejected } },
      },
    ])
    const put = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    expect(put).toBeDefined()
    const input = put?.detail?.input as JsonObject
    expect(input.value).toEqual(rejected)
  })

  test('a malformed scan result fails the detailSchema gate — fail-closed, never partial admission', () => {
    const malformed = { tokens: 'not-an-object', sections: null, warnings: [] }
    const { selected } = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: UI_DESIGN_SCAN_CALL_ID, result: { status: 'completed', jsonData: malformed } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)).toBe(false)
  })
})

describe('ui threads — the design scan recipe (real run)', () => {
  test('a user-authored DESIGN.md carries the USER\u2019s tokens, not the shipped defaults', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-home-'))
    try {
      writeFileSync(
        join(home, 'DESIGN.md'),
        [
          '---',
          'name: Mine',
          'colors:',
          '  primary: "#0A0A0A"',
          '  accent: "light-dark(#111, #EEE)"',
          'rounded:',
          '  md: 8px',
          '---',
          '',
          '# Mine',
          '',
          '## Overview',
          '',
          'My system.',
          '',
          '## Iconography',
          '',
          'An unknown section.',
        ].join('\n'),
      )
      const { stdout, stderr, exitCode } = await runScan({ BEHAVIORAL_HOME: home })
      expect([exitCode, stderr]).toEqual([0, ''])
      const out = JSON.parse(stdout) as {
        tokens: Record<string, unknown> | null
        sections: Record<string, string> | null
        warnings: string[]
      }
      expect(out.tokens).toEqual({
        name: 'Mine',
        colors: { primary: '#0A0A0A', accent: 'light-dark(#111, #EEE)' },
        rounded: { md: '8px' },
      })
      expect(out.sections).toEqual({ Overview: 'My system.', Iconography: 'An unknown section.' })
      expect(out.warnings).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('the shipped default DESIGN.md seeds a conforming tenant when copied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-home-'))
    try {
      copyFileSync(join(import.meta.dir, '../../../skills/behavioral/assets/DESIGN.md'), join(home, 'DESIGN.md'))
      const { stdout, stderr, exitCode } = await runScan({ BEHAVIORAL_HOME: home })
      expect([exitCode, stderr]).toEqual([0, ''])
      const out = JSON.parse(stdout) as {
        tokens: Record<string, unknown> | null
        sections: Record<string, string> | null
        warnings: string[]
      }
      expect(out.tokens).not.toBe(null)
      const tokens = out.tokens as Record<string, Record<string, unknown>>
      // The spec-named groups validate; the unknown groups ride verbatim.
      expect(typeof tokens.colors?.primary).toBe('string')
      expect(typeof tokens.rounded?.md).toBe('string')
      expect(typeof tokens.spacing?.md).toBe('string')
      expect(typeof tokens.typography?.['display-lg']).toBe('object')
      expect(typeof tokens.brand).toBe('object')
      expect(out.warnings).toEqual([])
      expect(Object.keys(out.sections ?? {}).length).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a duplicate body section rejects the file — the rejection rides the warnings', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-home-'))
    try {
      writeFileSync(
        join(home, 'DESIGN.md'),
        [
          '---',
          'colors:',
          '  primary: "#101010"',
          '---',
          '',
          '## Colors',
          '',
          'First.',
          '',
          '## Colors',
          '',
          'Second.',
        ].join('\n'),
      )
      const { stdout, stderr, exitCode } = await runScan({ BEHAVIORAL_HOME: home })
      expect([exitCode, stderr]).toEqual([0, ''])
      const out = JSON.parse(stdout) as {
        tokens: Record<string, unknown> | null
        sections: Record<string, string> | null
        warnings: string[]
      }
      expect(out.tokens).toBe(null)
      expect(out.sections).toBe(null)
      expect(out.warnings.some((w) => w.includes('Duplicate section heading') && w.includes('Colors'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a missing DESIGN.md is not an error — the empty shape, no warnings', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-home-'))
    try {
      const { stdout, stderr, exitCode } = await runScan({ BEHAVIORAL_HOME: home })
      expect([exitCode, stderr]).toEqual([0, ''])
      expect(JSON.parse(stdout)).toEqual({ tokens: null, sections: null, warnings: [] })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a malformed spec-named token group drops with a warning — lenient, the file survives', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-home-'))
    try {
      writeFileSync(
        join(home, 'DESIGN.md'),
        [
          '---',
          'colors:',
          '  primary:',
          '    nested: true',
          'spacing:',
          '  md: 16px',
          '---',
          '',
          '## Overview',
          '',
          'Body.',
        ].join('\n'),
      )
      const { stdout, stderr, exitCode } = await runScan({ BEHAVIORAL_HOME: home })
      expect([exitCode, stderr]).toEqual([0, ''])
      const out = JSON.parse(stdout) as {
        tokens: Record<string, unknown> | null
        sections: Record<string, string> | null
        warnings: string[]
      }
      expect(out.tokens).toEqual({ spacing: { md: '16px' } })
      expect(out.sections).toEqual({ Overview: 'Body.' })
      expect(out.warnings.some((w) => w.includes('colors'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ─── The per-trigger pipeline once-threads (the dispatcher's mint) ────────────

/**
 * Mount one minted per-trigger pipeline — what the composition's host leg
 * (b-program's pump) mints on a render ingress.
 */
const mountPipeline = (program: ReturnType<typeof behavioral>, id: string, detail: JsonObject): void => {
  for (const thread of uiPipelineThreads({ id, detail })) program.addThread(thread)
}

/** Drive one minted pipeline through the real engine (standing set + the set + drive events). */
const pipelineRun = (id: string, detail: JsonObject, events: BPEvent[]) => {
  const program = behavioral()
  const selected: Selected[] = []
  const traces: Trace[] = []
  program.useTrace((trace: Trace) => {
    traces.push(trace)
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  for (const thread of uiThreads) program.addThread(thread)
  mountPipeline(program, id, detail)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  program.trigger({ type: 'ui_pipeline_pump', detail: {} })
  program.trigger({ type: 'ui_pipeline_pump', detail: {} })
  return { selected, traces }
}

/** The browser's correlated scale reply for pipeline `id`. */
const scaleReply = (id: string, scale = 's3', target = 'body'): BPEvent => ({
  type: 'ui_scale_check_result',
  detail: { id: `${id}-scale`, target, effectiveScale: scale, timeStamp: 1 },
})

describe('ui threads — the per-trigger pipeline', () => {
  test('the set requests the scale check under its own id — and nothing generates before the reply', () => {
    const { selected, traces } = pipelineRun('ui-x1', { message: 'a panel' }, [])
    const check = selected.find((s) => s.type === 'ui_scale_check')
    expect(check).toBeDefined()
    expect(check?.detail).toEqual({ id: 'ui-x1-scale', target: 'body', swap: 'innerHTML' })
    expect(selected.some((s) => s.type === 'generate')).toBe(false)
    // The no-browser hold, per-trigger: the scale-join once-thread parks on
    // its transform listener — visible in the frontier (pending_bids).
    const holds = traces.filter((t): t is PendingBidsTrace => t.kind === TRACE_MESSAGE_KINDS.pending_bids)
    expect(
      holds.some((t) =>
        t.threads.some(
          (bid) =>
            bid.label === 'ui/pipeline:ui-x1/scale-join' &&
            bid.transform?.some((l) => l.type === 'ui_scale_check_result'),
        ),
      ),
    ).toBe(true)
  })

  test('a named target on the trigger detail rides the scale check', () => {
    const { selected } = pipelineRun('ui-x2', { target: 'main' }, [])
    const check = selected.find((s) => s.type === 'ui_scale_check')
    expect(check?.detail).toEqual({ id: 'ui-x2-scale', target: 'main', swap: 'innerHTML' })
  })

  test('the correlated reply stamps the generate request — scale+target via ctx, the trigger detail as the request', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [scaleReply('ui-x1')])
    const generate = selected.find((s) => s.type === 'generate')
    expect(generate).toBeDefined()
    expect(generate?.detail).toEqual({
      ctx: { scale: 's3', target: 'body', echo: { pipeline: 'ui-x1' } },
      request: { message: 'a panel' },
    })
  })

  test('a foreign reply joins nothing — the per-trigger id isolates the hold', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [
      {
        type: 'ui_scale_check_result',
        detail: { id: 'ui-other-scale', target: 'body', effectiveScale: 's2', timeStamp: 1 },
      },
      scaleReply('ui-x1', 's5'),
    ])
    const generates = selected.filter((s) => s.type === 'generate')
    expect(generates).toHaveLength(1)
    expect((generates[0]?.detail as { ctx?: { scale?: string } } | undefined)?.ctx?.scale).toBe('s5')
  })

  test('two interleaved pipelines join independently — A’s reply never joins B’s hold', () => {
    const program = behavioral()
    const selected: Selected[] = []
    program.useTrace((trace: Trace) => {
      if (trace.kind === TRACE_MESSAGE_KINDS.selection)
        selected.push({
          type: (trace as SelectionTrace).selected.type,
          detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
        })
    })
    for (const thread of uiThreads) program.addThread(thread)
    mountPipeline(program, 'ui-a', { message: 'view A' })
    mountPipeline(program, 'ui-b', { message: 'view B' })
    program.addThread({ label: 'producer/a-reply', once: true, rules: [{ request: scaleReply('ui-a') }] })
    program.trigger({ type: 'ui_pipeline_pump', detail: {} })
    program.trigger({ type: 'ui_pipeline_pump', detail: {} })
    const generates = selected.filter((s) => s.type === 'generate')
    expect(generates).toHaveLength(1)
    expect((generates[0]?.detail as { ctx?: { echo?: { pipeline?: string } } } | undefined)?.ctx?.echo?.pipeline).toBe(
      'ui-a',
    )
  })
})

// ─── The per-trigger generation lane ──────────────────────────────────────────

/** The pipeline's tenant-bearing (or null) store result, joined by the ctx echo. */
const tenantStoreResult = (pipeline: string, value: JsonObject | null): BPEvent => ({
  type: 'store_request_result',
  detail: {
    id: `${pipeline}-tenant`,
    ok: true,
    result: { value },
    ctx: {
      echo: {
        ctx: { scale: 's3', target: 'body', echo: { pipeline } },
        request: { message: 'a panel' },
      },
    },
  },
})

describe('ui threads — the per-trigger generation lane', () => {
  test('the generate fetches the design tenant — the whole generate detail rides the store ctx echo', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [scaleReply('ui-x1')])
    const get = selected.find(
      (s) => s.type === 'store_request' && (s.detail as { op?: string } | undefined)?.op === 'get',
    )
    expect(get).toBeDefined()
    expect(get?.detail).toEqual({
      id: 'ui-x1-tenant',
      op: 'get',
      input: { collection: 'design', key: 'context' },
      ctx: {
        echo: {
          ctx: { scale: 's3', target: 'body', echo: { pipeline: 'ui-x1' } },
          request: { message: 'a panel' },
        },
      },
    })
  })

  test('a tenant-bearing result composes the systemTwo request — the trigger detail in the user message, the vocabulary in the instructions', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [
      scaleReply('ui-x1'),
      tenantStoreResult('ui-x1', {
        tokens: {
          colors: { primary: 'light-dark(#755576, #E2BAE0)' },
          typography: { 'body-md': { fontFamily: 'Ropa Sans', fontSize: '14px' } },
        },
        sections: { Overview: 'Matte surfaces, notebook discipline.' },
        warnings: [],
      }),
    ])
    const request = selected.find((s) => s.type === 'system_two_request')
    expect(request).toBeDefined()
    expect(request?.detail?.id).toBe('ui-x1-gen')
    expect(request?.detail?.ctx).toEqual({ scale: 's3', target: 'body', pipeline: 'ui-x1' })
    const input = request?.detail?.input as Record<string, unknown>
    expect(input.provider).toBe('default')
    const instructions = input.instructions as string
    expect(instructions).toContain('--design-colors-primary')
    expect(instructions).toContain('--design-typography-body-md-fontFamily')
    expect(instructions).toContain('Matte surfaces, notebook discipline.')
    // THE BLINDNESS FIX: the trigger's own content rides the user message,
    // model-facing by right (the user's request, not a host-supplied fact).
    const content = (input.input as Array<{ content?: string }>)[0]?.content
    expect(content).toContain('View request:')
    expect(content).toContain('a panel')
  })

  test('the style-issue leg composes a scoped ui_style from the tenant — @scope root on the target', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [
      scaleReply('ui-x1'),
      tenantStoreResult('ui-x1', {
        tokens: { colors: { primary: 'light-dark(#755576, #E2BAE0)' } },
        sections: null,
        warnings: [],
      }),
    ])
    const style = selected.find((s) => s.type === 'ui_style')
    expect(style).toBeDefined()
    expect(style?.detail?.id).toBe('ui-x1-style')
    expect(style?.detail?.target).toBe('body')
    const css = style?.detail?.css as string
    // The @scope root is the render target's b-target selector; :scope
    // carries the custom properties (the subtree inherits them).
    expect(css).toContain('@scope ([b-target="body"])')
    expect(css).toContain(':scope')
    expect(css).toContain('--design-colors-primary: light-dark(#755576, #E2BAE0);')
  })

  test('plain degradation — a null tenant or tokenless tenant emits no ui_style', () => {
    const tokenless = pipelineRun('ui-x1', { message: 'a panel' }, [
      scaleReply('ui-x1'),
      tenantStoreResult('ui-x1', { tokens: null, sections: { Overview: 'x' }, warnings: [] }),
    ])
    expect(tokenless.selected.some((s) => s.type === 'ui_style')).toBe(false)

    const tenantless = pipelineRun('ui-x2', { message: 'a panel' }, [
      scaleReply('ui-x2'),
      tenantStoreResult('ui-x2', null),
    ])
    expect(tenantless.selected.some((s) => s.type === 'ui_style')).toBe(false)
  })

  test('named provider/modelId reach the composed systemTwo request — the config seam', () => {
    const program = behavioral()
    const selected: Selected[] = []
    program.useTrace((trace: Trace) => {
      if (trace.kind === TRACE_MESSAGE_KINDS.selection)
        selected.push({
          type: (trace as SelectionTrace).selected.type,
          detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
        })
    })
    for (const thread of uiThreads) program.addThread(thread)
    for (const thread of uiPipelineThreads({
      id: 'ui-x9',
      detail: { message: 'a panel' },
      provider: 'named',
      modelId: 'named-model',
    }))
      program.addThread(thread)
    program.addThread({ label: 'producer/reply', once: true, rules: [{ request: scaleReply('ui-x9') }] })
    program.addThread({
      label: 'producer/tenant',
      once: true,
      rules: [{ request: tenantStoreResult('ui-x9', null) }],
    })
    program.trigger({ type: 'ui_pipeline_pump', detail: {} })
    program.trigger({ type: 'ui_pipeline_pump', detail: {} })
    const request = selected.find((s) => s.type === 'system_two_request')
    expect(request).toBeDefined()
    const input = request?.detail?.input as { provider?: string; modelId?: string } | undefined
    expect(input?.provider).toBe('named')
    expect(input?.modelId).toBe('named-model')
  })

  test('a null tenant composes the plain request — no vocabulary, no prose, the content still rides', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [
      scaleReply('ui-x1'),
      tenantStoreResult('ui-x1', null),
    ])
    const request = selected.find((s) => s.type === 'system_two_request')
    expect(request).toBeDefined()
    const input = request?.detail?.input as Record<string, unknown> | undefined
    const instructions = input?.instructions as string | undefined
    expect(instructions?.includes('--design-')).toBe(false)
    expect(instructions?.includes('Design rationale')).toBe(false)
    const content = (input?.input as Array<{ content?: string }> | undefined)?.[0]?.content
    expect(content).toContain('a panel')
  })

  test('the model reply composes the draft; the standing gate emits the render under the per-trigger id', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [
      scaleReply('ui-x1'),
      tenantStoreResult('ui-x1', null),
      {
        type: 'system_two_request_result',
        detail: {
          id: 'ui-x1-gen',
          ok: true,
          result: {
            items: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '<p>Hello</p>' }],
              },
            ],
          },
          ctx: { scale: 's3', target: 'body', pipeline: 'ui-x1' },
        },
      },
    ])
    const draft = selected.find((s) => s.type === 'render_draft')
    expect(draft).toBeDefined()
    expect(draft?.detail).toEqual({
      id: 'ui-x1-render',
      target: 'body',
      html: '<p>Hello</p>',
      swap: 'innerHTML',
    })
    const render = selected.find((s) => s.type === 'ui_render')
    expect(render).toBeDefined()
    expect(render?.detail).toEqual({
      id: 'ui-x1-render',
      target: 'body',
      html: '<p>Hello</p>',
      swap: 'innerHTML',
    })
  })

  test('a non-conforming reply is held as data — the draft never becomes a render', () => {
    const { selected } = pipelineRun('ui-x1', { message: 'a panel' }, [
      scaleReply('ui-x1'),
      tenantStoreResult('ui-x1', null),
      {
        type: 'system_two_request_result',
        detail: {
          id: 'ui-x1-gen',
          ok: true,
          result: { items: [] },
          ctx: { scale: 's3', target: 'body', pipeline: 'ui-x1' },
        },
      },
    ])
    // The draft IS selected (held as data, visible in traces) — but its
    // null html fails the render gate, so no ui_render is ever requested.
    const draft = selected.find((s) => s.type === 'render_draft')
    expect(draft).toBeDefined()
    expect((draft?.detail as { html?: string | null } | undefined)?.html).toBe(null)
    expect(selected.some((s) => s.type === 'ui_render')).toBe(false)
  })
})

describe('ui threads — the custom-properties artifact', () => {
  test('a tenant-bearing scan result compiles the artifact — the values pass through verbatim', () => {
    const context = {
      tokens: { colors: { primary: 'light-dark(#755576, #E2BAE0)' }, spacing: { md: '16px' } },
      sections: null,
      warnings: [],
    }
    const { selected } = runProgram([
      {
        type: 'shell_request_result',
        detail: { id: 'ui-design-scan', result: { status: 'completed', jsonData: context } },
      },
    ])
    const puts = selected.filter(
      (s) => s.type === 'store_request' && (s.detail as { op?: string } | undefined)?.op === 'put',
    )
    expect(puts).toHaveLength(2)
    const artifact = puts.find((s) => (s.detail as { input?: { key?: string } } | undefined)?.input?.key === 'artifact')
    const css = (artifact?.detail as { input?: { value?: { css?: string } } } | undefined)?.input?.value?.css as string
    expect(css).toContain(':root {')
    expect(css).toContain('--design-colors-primary: light-dark(#755576, #E2BAE0);')
    expect(css).toContain('--design-spacing-md: 16px;')
  })

  test('a tenant without tokens compiles no artifact', () => {
    const rejected = { tokens: null, sections: null, warnings: ['Duplicate section heading: the file is rejected'] }
    const { selected } = runProgram([
      {
        type: 'shell_request_result',
        detail: { id: 'ui-design-scan', result: { status: 'completed', jsonData: rejected } },
      },
    ])
    const puts = selected.filter(
      (s) => s.type === 'store_request' && (s.detail as { op?: string } | undefined)?.op === 'put',
    )
    expect(puts).toHaveLength(1)
    expect((puts[0]?.detail as { input?: { key?: string } } | undefined)?.input?.key).toBe('context')
  })
})

// ─── The composition mount ────────────────────────────────────────────────────

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const waitForTraces = async (traces: Trace[], until: (selections: SelectionTrace[]) => boolean) => {
  const deadline = Date.now() + 8_000
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for traces; saw: ${JSON.stringify(traces.map((t) => t.kind))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * The hermetic composition fixtures — a temp home handed to the faculty
 * processes through their `env` overrides. Bun.spawn children see STARTUP env
 * only (the carried TUI finding), so a runtime-set BEHAVIORAL_HOME never
 * reaches a spawned worker; the override env is the one seam that does.
 */
const homeEnv = (home: string) => ({ BEHAVIORAL_HOME: home })

const tempHome = () => mkdtempSync(join(tmpdir(), 'behavioral-ui-home-'))

/** The shell faculty override: the default construction + the temp home env. */
const shellWithHome = (home: string) =>
  useFaculty({
    command: ['bun', 'run', '../actuators/shell.actuator.ts'],
    name: 'shell',
    threads: [],
    env: homeEnv(home),
    requestSchema: ShellRequestEventSchema,
    cancelSchema: ShellCancelEventSchema,
    resultSchema: ShellRequestResultEventSchema,
  })

/** The store faculty override: the default construction + the temp home env. */
const storeWithHome = (home: string) =>
  useFaculty({
    command: ['bun', 'run', '../actuators/store.actuator.ts'],
    name: 'store',
    threads: [],
    env: homeEnv(home),
    requestSchema: StoreRequestEventSchema,
    cancelSchema: StoreRequestEventSchema, // no cancel; the request schema is the gate
    resultSchema: StoreRequestResultEventSchema,
  })

describe('ui threads — the composition mount', () => {
  test('with systemTwo on, the boot scan self-starts through the composition and the tenant lands', async () => {
    const home = tempHome()
    try {
      writeFileSync(join(home, 'DESIGN.md'), '---\ncolors:\n  primary: "#0A0A0A"\n---\n\n## Overview\n\nMine.\n')
      const traces: Trace[] = []
      // Absent systemTwo = no generation lane = no mount, so the composition
      // test wires the stub endpoint (lazy spawn — no process starts without
      // a system_two_request). The shell/store overrides carry the temp home
      // to the faculty processes (the one env seam Bun.spawn honors mid-run).
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { default: { url: 'http://unused.local' } } }),
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      runtime.start()
      try {
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
              (t.selected.detail as { id?: string } | undefined)?.id === UI_DESIGN_SCAN_CALL_ID,
          ),
        )
        await waitForTraces(traces, (s) =>
          s.some((t) => {
            if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
            const detail = t.selected.detail as
              | { op?: string; input?: { collection?: string; key?: string } }
              | undefined
            return detail?.op === 'put' && detail.input?.collection === UI_DESIGN_COLLECTION
          }),
        )
        const put = selectionsOf(traces).find((t) => {
          if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
          const detail = t.selected.detail as { op?: string; input?: { collection?: string; key?: string } } | undefined
          return detail?.op === 'put' && detail.input?.collection === UI_DESIGN_COLLECTION
        })
        const input = (put?.selected.detail as { input?: { key?: string; value?: JsonObject } } | undefined)?.input
        expect(input?.key).toBe(UI_DESIGN_CONTEXT_KEY)
        expect(
          (input?.value as { tokens?: { colors?: { primary?: string } } } | undefined)?.tokens?.colors?.primary,
        ).toBe('#0A0A0A')
      } finally {
        runtime.terminate()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a ui_event render mints the per-trigger pipeline and drives it end-to-end through the serve dispatcher', async () => {
    const home = tempHome()
    try {
      const traces: Trace[] = []
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { default: { url: 'http://unused.local' } } }),
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      const out: string[] = []
      const host = createHost({
        runtime,
        input: new Response('').body as unknown as ReadableStream<Uint8Array>,
        write: (line) => out.push(line),
        home,
      })
      await host.rpc.done
      try {
        const generateSelected = () => selectionsOf(traces).some((t) => t.selected.type === UI_GENERATE_EVENT_TYPE)

        // The browser side of the pipeline is the dispatcher itself: the
        // ui_event's inner BPEvent is the render trigger — the pump mints the
        // pipeline, and the minted scale check carries a FRESH per-trigger id.
        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: {
            event: { type: 'render', detail: { message: 'a telemetry panel' } },
            timeStamp: 1,
          },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_scale_check'))
        const checkId = (
          selectionsOf(traces).find((t) => t.selected.type === 'ui_scale_check')?.selected.detail as
            | { id?: string }
            | undefined
        )?.id
        expect(typeof checkId === 'string' && checkId.startsWith('ui-') && checkId.endsWith('-scale')).toBe(true)
        // The scale check went OUT as its own client notification (egress).
        expect(out.some((line) => line.includes('"method":"ui_scale_check"'))).toBe(true)
        // No browser reply yet — no generation request.
        expect(generateSelected()).toBe(false)

        // A foreign-id result joins nothing — the per-trigger id isolates.
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: 'other-check', target: 'body', effectiveScale: 's2', timeStamp: 2 },
        })
        await Bun.sleep(150)
        expect(generateSelected()).toBe(false)

        // The correlated reply re-enters through the same seam — the
        // generation request carries the effective scale in its ctx AND the
        // trigger's own detail as the request (the blindness fix).
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: checkId, target: 'body', effectiveScale: 's3', timeStamp: 3 },
        })
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === UI_GENERATE_EVENT_TYPE &&
              (t.selected.detail as { ctx?: { scale?: string; target?: string } } | undefined)?.ctx?.scale === 's3',
          ),
        )
        const generate = selectionsOf(traces).find((t) => t.selected.type === UI_GENERATE_EVENT_TYPE)
        expect((generate?.selected.detail as { ctx?: { target?: string } } | undefined)?.ctx?.target).toBe('body')
        expect((generate?.selected.detail as { request?: { message?: string } } | undefined)?.request?.message).toBe(
          'a telemetry panel',
        )
      } finally {
        runtime.terminate()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 10_000)

  test('two rapid triggers mint two pipelines — both render, each under its own id', async () => {
    const home = tempHome()
    try {
      const server = await startOpenResponsesServer()
      const traces: Trace[] = []
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { default: { url: server.url } } }),
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      const out: string[] = []
      const host = createHost({
        runtime,
        input: new Response('').body as unknown as ReadableStream<Uint8Array>,
        write: (line) => out.push(line),
        home,
      })
      await host.rpc.done
      try {
        const scaleChecks = () => selectionsOf(traces).filter((t) => t.selected.type === 'ui_scale_check')

        // Trigger A, then trigger B BEFORE any browser reply — the dropped
        // trigger of the standing pipeline is now a second live pipeline.
        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: { event: { type: 'render', detail: { message: 'view A' } }, timeStamp: 1 },
        })
        await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === 'ui_scale_check').length >= 1)
        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: { event: { type: 'render', detail: { message: 'view B' } }, timeStamp: 2 },
        })
        await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === 'ui_scale_check').length >= 2)

        // Both scale checks are live with DISTINCT per-trigger ids.
        const ids = scaleChecks().map((t) => (t.selected.detail as { id?: string } | undefined)?.id)
        expect(new Set(ids).size).toBe(2)

        // Reply to both — A first, B after (the replies interleave).
        const [a, b] = ids
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: a, target: 'body', effectiveScale: 's3', timeStamp: 3 },
        })
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: b, target: 'body', effectiveScale: 's4', timeStamp: 4 },
        })

        // BOTH renders compose and egress — each under its own pipeline id.
        await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === 'ui_render').length >= 2)
        const renderIds = selectionsOf(traces)
          .filter((t) => t.selected.type === 'ui_render')
          .map((t) => (t.selected.detail as { id?: string } | undefined)?.id)
        expect(new Set(renderIds).size).toBe(2)
        expect(out.filter((line) => line.includes('"method":"ui_render"')).length).toBe(2)

        // Each model call carries ITS OWN trigger's content — the recorded
        // bodies prove the two pipelines never crossed.
        const contents = server.requests.map((r) => {
          const input = (r.body as { input?: Array<{ content?: string }> }).input
          return input?.[0]?.content ?? ''
        })
        expect(contents.some((c) => c.includes('view A'))).toBe(true)
        expect(contents.some((c) => c.includes('view B'))).toBe(true)
      } finally {
        runtime.terminate()
        await server.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  test('the artifact serving seam: ui_style egresses before ui_render with a tenant, never plain', async () => {
    const home = tempHome()
    try {
      writeFileSync(join(home, 'DESIGN.md'), '---\ncolors:\n  primary: "#0A0A0A"\n---\n\n## Overview\n\nMine.\n')
      const server = await startOpenResponsesServer()
      const traces: Trace[] = []
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { default: { url: server.url } } }),
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      const out: string[] = []
      const host = createHost({
        runtime,
        input: new Response('').body as unknown as ReadableStream<Uint8Array>,
        write: (line) => out.push(line),
        home,
      })
      await host.rpc.done
      try {
        // Boot: wait for the design tenant to land before driving.
        await waitForTraces(traces, (s) =>
          s.some((t) => {
            if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
            const detail = t.selected.detail as
              | { op?: string; input?: { collection?: string; key?: string } }
              | undefined
            return detail?.op === 'put' && detail.input?.collection === UI_DESIGN_COLLECTION
          }),
        )
        // The tenant-bearing pipeline emits ui_style BEFORE ui_render.
        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: { event: { type: 'render', detail: { message: 'a panel' } }, timeStamp: 1 },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_scale_check'))
        const checkId = (
          selectionsOf(traces).find((t) => t.selected.type === 'ui_scale_check')?.selected.detail as
            | { id?: string }
            | undefined
        )?.id
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: checkId, target: 'body', effectiveScale: 's3', timeStamp: 2 },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_render'))
        const styleLine = out.findIndex((line) => line.includes('"method":"ui_style"'))
        const renderLine = out.findIndex((line) => line.includes('"method":"ui_render"'))
        expect(styleLine).toBeGreaterThan(-1)
        expect(renderLine).toBeGreaterThan(styleLine)
        expect(out[styleLine]).toContain('@scope')
      } finally {
        runtime.terminate()
        await server.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 10_000)

  test('the composition config seam: named ui provider/modelId reach the recorded model call', async () => {
    const home = tempHome()
    try {
      const server = await startOpenResponsesServer()
      const traces: Trace[] = []
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { named: { url: server.url } } }),
        ui: { provider: 'named', modelId: 'named-model' },
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      const out: string[] = []
      const host = createHost({
        runtime,
        input: new Response('').body as unknown as ReadableStream<Uint8Array>,
        write: (line) => out.push(line),
        home,
      })
      await host.rpc.done
      try {
        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: { event: { type: 'render', detail: { message: 'a panel' } }, timeStamp: 1 },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_scale_check'))
        const checkId = (
          selectionsOf(traces).find((t) => t.selected.type === 'ui_scale_check')?.selected.detail as
            | { id?: string }
            | undefined
        )?.id
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: checkId, target: 'body', effectiveScale: 's3', timeStamp: 2 },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_render'))
        // The named values reached the recorded call — provider label AND
        // model id, threaded through the pump's mint.
        const body = server.requests.at(-1)?.body as { model?: string } | undefined
        expect(body?.model).toBe('named-model')
      } finally {
        runtime.terminate()
        await server.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 10_000)

  test('absent systemTwo a render ingress mints no pipeline — the pump guard holds', async () => {
    const home = tempHome()
    try {
      const traces: Trace[] = []
      const runtime = bProgram({ shell: shellWithHome(home), store: storeWithHome(home) })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      runtime.start()
      try {
        // The raw ingress trigger — what serve's ui_event unwrap delivers to
        // the engine. Without systemTwo there is no generation lane: no
        // standing set, no pump mint.
        runtime.trigger({ type: 'render', detail: { message: 'a panel' } })
        await Bun.sleep(150)
        expect(selectionsOf(traces).some((t) => t.selected.type === 'ui_scale_check')).toBe(false)
        expect(selectionsOf(traces).some((t) => t.selected.type === 'ui_render')).toBe(false)
      } finally {
        runtime.terminate()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 10_000)

  test('the no-lock lane end-to-end: the USER’s vocabulary rides the model call; the reply renders', async () => {
    const home = tempHome()
    try {
      writeFileSync(
        join(home, 'DESIGN.md'),
        '---\ncolors:\n  primary: "#0A0A0A"\nrounded:\n  md: 8px\n---\n\n## Overview\n\nMine.\n',
      )
      const server = await startOpenResponsesServer()
      const traces: Trace[] = []
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { default: { url: server.url } } }),
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      const out: string[] = []
      const host = createHost({
        runtime,
        input: new Response('').body as unknown as ReadableStream<Uint8Array>,
        write: (line) => out.push(line),
        home,
      })
      await host.rpc.done
      try {
        // Boot: the tenant AND the compiled artifact land in the store.
        await waitForTraces(
          traces,
          (s) =>
            s.filter((t) => {
              if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
              const detail = t.selected.detail as
                | { op?: string; input?: { collection?: string; key?: string } }
                | undefined
              return detail?.op === 'put' && detail.input?.collection === UI_DESIGN_COLLECTION
            }).length >= 2,
        )
        const artifactPut = selectionsOf(traces).find((t) => {
          if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
          const detail = t.selected.detail as { input?: { key?: string; value?: { css?: string } } } | undefined
          return detail?.input?.key === UI_DESIGN_ARTIFACT_KEY
        })
        expect(artifactPut).toBeDefined()
        expect(
          (artifactPut?.selected.detail as { input?: { value?: { css?: string } } } | undefined)?.input?.value?.css,
        ).toContain('--design-colors-primary: #0A0A0A;')

        // Drive: the render trigger carries the user's view request, then
        // the browser's scale reply (with the MINTED per-trigger id).
        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: {
            event: { type: 'render', detail: { message: 'a telemetry panel for agent traces' } },
            timeStamp: 1,
          },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_scale_check'))
        const checkId = (
          selectionsOf(traces).find((t) => t.selected.type === 'ui_scale_check')?.selected.detail as
            | { id?: string }
            | undefined
        )?.id
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: checkId, target: 'body', effectiveScale: 's3', timeStamp: 2 },
        })

        // The generation request reaches the real endpoint; the reply
        // composes a conforming render, and the serve egress emits it.
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_render'))
        expect(out.some((line) => line.includes('"method":"ui_render"') && line.includes(ASSISTANT_TEXT))).toBe(true)

        // The recorded model call carries the USER's vocabulary (never the
        // shipped defaults) AND the trigger's own content (the blindness fix)
        // — inspected after the pipeline settles.
        const body = server.requests.at(-1)?.body as
          | { instructions?: string; model?: string; input?: Array<{ content?: string }> }
          | undefined
        expect(body?.model).toBe('gpt-5.1')
        expect(body?.instructions).toContain('--design-colors-primary')
        expect(body?.instructions).toContain('--design-rounded-md')
        expect(body?.instructions).toContain('Mine.')
        expect(body?.instructions?.includes('--design-typography')).toBe(false)
        expect(body?.input?.[0]?.content).toContain('a telemetry panel for agent traces')
      } finally {
        runtime.terminate()
        await server.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 10_000)

  test('no DESIGN.md at all — the pipeline still renders, plain, no artifact', async () => {
    const home = tempHome()
    try {
      const server = await startOpenResponsesServer()
      const traces: Trace[] = []
      const runtime = bProgram({
        shell: shellWithHome(home),
        store: storeWithHome(home),
        systemTwo: useSystemTwo({ endpoints: { default: { url: server.url } } }),
      })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      const out: string[] = []
      const host = createHost({
        runtime,
        input: new Response('').body as unknown as ReadableStream<Uint8Array>,
        write: (line) => out.push(line),
        home,
      })
      await host.rpc.done
      try {
        // Boot: the scan finds no DESIGN.md — no tenant, no artifact, quiet.
        await Bun.sleep(500)
        expect(
          selectionsOf(traces).some(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.store_request &&
              (t.selected.detail as { op?: string; input?: { collection?: string } } | undefined)?.input?.collection ===
                UI_DESIGN_COLLECTION,
          ),
        ).toBe(false)

        dispatchToRuntime(runtime, {
          method: 'ui_event',
          params: { event: { type: 'render', detail: { message: 'a plain panel' } }, timeStamp: 1 },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_scale_check'))
        const plainCheckId = (
          selectionsOf(traces).find((t) => t.selected.type === 'ui_scale_check')?.selected.detail as
            | { id?: string }
            | undefined
        )?.id
        dispatchToRuntime(runtime, {
          method: 'ui_scale_check_result',
          params: { id: plainCheckId, target: 'body', effectiveScale: 's4', timeStamp: 2 },
        })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_render'))
        expect(out.some((line) => line.includes('"method":"ui_render"') && line.includes(ASSISTANT_TEXT))).toBe(true)
        // Plain degradation emits no style — the design lane is optional,
        // never a gate, and never a phantom message.
        expect(out.some((line) => line.includes('"method":"ui_style"'))).toBe(false)
        const body = server.requests.at(-1)?.body as { instructions?: string } | undefined
        expect(body?.instructions?.includes('--design-')).toBe(false)
      } finally {
        runtime.terminate()
        await server.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 10_000)

  test('absent systemTwo there is no generation lane — the ui threads do not mount', async () => {
    const home = tempHome()
    try {
      writeFileSync(join(home, 'DESIGN.md'), '---\ncolors:\n  primary: "#0A0A0A"\n---\n\n## Overview\n\nMine.\n')
      const traces: Trace[] = []
      const runtime = bProgram({ shell: shellWithHome(home), store: storeWithHome(home) })
      runtime.useTrace((trace) => {
        traces.push(trace)
      })
      runtime.start()
      try {
        await Bun.sleep(300)
        expect(
          selectionsOf(traces).some(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
              (t.selected.detail as { id?: string } | undefined)?.id === UI_DESIGN_SCAN_CALL_ID,
          ),
        ).toBe(false)
      } finally {
        runtime.terminate()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
