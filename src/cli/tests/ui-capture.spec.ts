/**
 * The ui autoresearch loop — the in-process raw capture consumer (the eval
 * ruling's canonical path: in-process = raw, a second `useTrace` subscriber
 * coexisting with the redacted lane) plus the minimal frontier-analysis pass
 * over a captured run (`frontier_request { op: replay }` — the divergence
 * view: where requests blocked, what the frontier looked like when the hold
 * happened). The graders are consumer-authored; this pins the wiring.
 *
 * The capture is PIPELINE-KEYED (the per-trigger pipeline's lineage): a run
 * is keyed by the minted pipeline id parsed from the thread labels, the
 * correlation ids, and the ctx lineage — never by a time window — so
 * interleaved pipelines attribute correctly and unrelated faculty traffic
 * stays out of the runs.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import {
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  StoreRequestEventSchema,
  StoreRequestResultEventSchema,
} from '../../faculties/faculties.types.ts'
import { useSystemTwo } from '../../faculties/system-two/config.ts'
import { startOpenResponsesServer } from '../../faculties/system-two/tests/fixtures/model-server.ts'
import { useFaculty } from '../../faculties/use-faculty.ts'
import { bProgram } from '../b-program.ts'
import { createHost, dispatchToRuntime } from '../serve.ts'
import { createUiCapture, type UiRun, uiReplayRequest } from '../ui-capture.ts'

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

const homeEnv = (home: string) => ({ BEHAVIORAL_HOME: home })

const shellWithHome = (home: string) =>
  useFaculty({
    command: ['bun', 'run', '../actuators/shell/faculty.ts'],
    name: 'shell',
    threads: [],
    env: homeEnv(home),
    requestSchema: ShellRequestEventSchema,
    cancelSchema: ShellCancelEventSchema,
    resultSchema: ShellRequestResultEventSchema,
  })

const storeWithHome = (home: string) =>
  useFaculty({
    command: ['bun', 'run', '../actuators/store/faculty.ts'],
    name: 'store',
    threads: [],
    env: homeEnv(home),
    requestSchema: StoreRequestEventSchema,
    cancelSchema: StoreRequestEventSchema, // no cancel; the request schema is the gate
    resultSchema: StoreRequestResultEventSchema,
  })

/**
 * One scripted pipeline session against the real composition — real faculty
 * processes, the fixture Open Responses endpoint, the serve dispatcher —
 * with the raw capture consumer mounted beside the redacted lane. Each drive
 * mints a FRESH per-trigger pipeline; the replies use the minted ids read
 * back from the traces.
 */
const runPipelineSession = async () => {
  const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-capture-'))
  writeFileSync(join(home, 'DESIGN.md'), '---\ncolors:\n  primary: "#0A0A0A"\n---\n\n## Overview\n\nMine.\n')
  const server = await startOpenResponsesServer()
  const traces: Trace[] = []
  const runs: UiRun[] = []
  const runtime = bProgram({
    shell: shellWithHome(home),
    store: storeWithHome(home),
    systemTwo: useSystemTwo({ endpoints: { default: { url: server.url } } }),
  })
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  runtime.useTrace(createUiCapture({ sink: (run) => runs.push(run) }))
  const out: string[] = []
  const host = createHost({
    runtime,
    input: new Response('').body as unknown as ReadableStream<Uint8Array>,
    write: (line) => out.push(line),
    home,
  })
  await host.rpc.done
  /** Trigger one render ingress and (unless held) reply to ITS minted scale check. */
  const drive = async (opts: { replyScale?: boolean; effectiveScale?: string } = {}): Promise<string> => {
    // The boot tenant must land before the trigger (the pipeline's store get
    // races the boot scan's put otherwise — a null tenant styles nothing).
    await waitForTraces(traces, (s) =>
      s.some((t) => {
        if (t.selected.type !== 'store_request') return false
        const detail = t.selected.detail as { op?: string; input?: { collection?: string } } | undefined
        return detail?.op === 'put' && detail.input?.collection === 'design'
      }),
    )
    const before = selectionsOf(traces).filter((t) => t.selected.type === 'ui_scale_check').length
    dispatchToRuntime(runtime, {
      method: 'ui_event',
      params: { event: { type: 'render', detail: {} }, timeStamp: Date.now() },
    })
    await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === 'ui_scale_check').length > before)
    const checkId = (
      selectionsOf(traces).findLast((t) => t.selected.type === 'ui_scale_check')?.selected.detail as
        | { id?: string }
        | undefined
    )?.id as string
    if (opts.replyScale === false) return checkId
    dispatchToRuntime(runtime, {
      method: 'ui_scale_check_result',
      params: {
        id: checkId,
        target: 'body',
        effectiveScale: opts.effectiveScale ?? 's3',
        timeStamp: Date.now(),
      },
    })
    await waitForTraces(traces, (s) => {
      const renders = s.filter((t) => t.selected.type === 'ui_render')
      return renders.some(
        (t) => (t.selected.detail as { id?: string } | undefined)?.id === `${checkId.slice(0, -6)}-render`,
      )
    })
    return checkId
  }
  return {
    runs,
    traces,
    runtime,
    drive,
    cleanup: async (): Promise<void> => {
      runtime.terminate()
      await server.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('ui capture — the pipeline-keyed raw run consumer', () => {
  test('a scripted run produces a lineage-keyed capture — mint threads visible, no unrelated traffic', async () => {
    const session = await runPipelineSession()
    try {
      await session.drive()
      expect(session.runs).toHaveLength(1)
      const run = session.runs[0]!
      // The run is keyed by the MINTED pipeline id — never a time window.
      expect(run.pipeline).toMatch(/^ui-[0-9a-f-]+$/)
      // The standing Thread set rides thread_added for free.
      const labels = run.threads.map((t) => t.label)
      expect(labels).toContain('ui/render-gate')
      // The minted once-thread set is IN the run (the pump's warp — the
      // mint traces arrive before the ingress selection trace — lands the
      // legs as reentries at 0).
      const reentryLabels = run.reentries.map((r) => r.thread.label)
      expect(reentryLabels.filter((l) => l.startsWith(`ui/pipeline:${run.pipeline}/`)).length).toBe(6)
      // Round-trips: pure data, JSON-serializable, structurally intact.
      expect(JSON.parse(JSON.stringify(run.threads)) as unknown[]).toEqual(run.threads)
      expect(JSON.parse(JSON.stringify(run.reentries)) as unknown[]).toEqual(run.reentries)
      // The run's messages span ingress → preflight → generation → render —
      // with the ingress FIRST despite the warp.
      const kinds = run.messages.map((m) => m.selected.type)
      expect(kinds[0]).toBe('render')
      expect(kinds).toContain('ui_scale_check')
      expect(kinds).toContain('ui_scale_check_result')
      expect(kinds).toContain('generate')
      expect(kinds).toContain('system_two_request')
      // The scoped style rides the run (the serving seam's egress, by
      // lineage: the `<pid>-style` id routes it).
      expect(kinds).toContain('ui_style')
      expect(kinds.at(-1)).toBe('ui_render')
      expect(kinds.indexOf('ui_style')).toBeLessThan(kinds.indexOf('ui_render'))
      // NO unrelated faculty traffic: the boot's design-store puts (tenant,
      // artifact) are NOT in the run — lineage, not time window.
      const storeKinds = run.messages
        .filter((m) => m.selected.type === 'store_request')
        .map((m) => (m.selected.detail as { op?: string } | undefined)?.op)
      expect(storeKinds).toEqual(['get'])
    } finally {
      await session.cleanup()
    }
  }, 15_000)

  test('two interleaved pipelines attribute correctly — each reply feeds its own run', async () => {
    const session = await runPipelineSession()
    try {
      // Trigger A, then trigger B BEFORE A's reply — the replies interleave.
      const aCheck = await session.drive({ replyScale: false })
      const bCheck = await session.drive({ replyScale: false })
      expect(aCheck).not.toBe(bCheck)
      dispatchToRuntime(session.runtime, {
        method: 'ui_scale_check_result',
        params: { id: bCheck, target: 'body', effectiveScale: 's4', timeStamp: Date.now() },
      })
      dispatchToRuntime(session.runtime, {
        method: 'ui_scale_check_result',
        params: { id: aCheck, target: 'body', effectiveScale: 's3', timeStamp: Date.now() },
      })
      await waitForTraces(session.traces, (s) => s.filter((t) => t.selected.type === 'ui_render').length >= 2)
      // Two COMPLETE runs — each ends at its own render, each carries its
      // own scale reply and exactly one of each pipeline kind.
      expect(session.runs).toHaveLength(2)
      for (const run of session.runs) {
        const kinds = run.messages.map((m) => m.selected.type)
        expect(kinds.filter((k) => k === 'ui_scale_check_result')).toHaveLength(1)
        expect(kinds.filter((k) => k === 'ui_render')).toHaveLength(1)
        expect(kinds.at(-1)).toBe('ui_render')
      }
      // The two runs are DISTINCT pipelines — no shared message.
      expect(session.runs[0]!.pipeline).not.toBe(session.runs[1]!.pipeline)
    } finally {
      await session.cleanup()
    }
  }, 15_000)

  test('a held run stays open — the quiescence flush is the parked ceiling', async () => {
    const session = await runPipelineSession()
    try {
      // The first drive never replies to the scale check: the run holds
      // (the no-browser park), and NO later trigger flushes it — interleaving
      // is normal now. The incomplete flush is the parked quiescence need.
      await session.drive({ replyScale: false })
      await session.drive()
      expect(session.runs).toHaveLength(1)
      expect(session.runs[0]!.messages.at(-1)?.selected.type).toBe('ui_render')
    } finally {
      await session.cleanup()
    }
  }, 15_000)
})

describe('ui capture — the frontier replay pass', () => {
  test('replay over the capture re-derives the blocking state — the full run ok, the hold visible at the prefix', async () => {
    const session = await runPipelineSession()
    try {
      await session.drive()
      const run = session.runs[0]!

      // The full-run replay through the real frontier lane: ok, the end
      // state re-derived.
      const fullResult = await replay(session.runtime, session.traces, uiReplayRequest(run))
      expect(fullResult.ok).toBe(true)
      expect(fullResult.result?.frontier).toBeDefined()

      // The prefix replay — the messages up to (not including) the browser's
      // scale reply — re-derives the HOLD: the frontier has no generation to
      // select (idle: no candidates, the pipeline parked on the external
      // scale fact) while threads remain pending.
      const holdIndex = run.messages.findIndex((m) => m.selected.type === 'ui_scale_check_result')
      expect(holdIndex).toBeGreaterThan(0)
      const holdResult = await replay(session.runtime, session.traces, uiReplayRequest(run, holdIndex))
      expect(holdResult.ok).toBe(true)
      const frontier = holdResult.result?.frontier as { status?: string } | undefined
      expect(frontier?.status).toBe('idle')
      expect(holdResult.result?.pendingCount ?? 0).toBeGreaterThan(0)
    } finally {
      await session.cleanup()
    }
  }, 15_000)
})

/** Trigger one replay request through the composition; poll for its re-entered result. */
const replay = async (
  runtime: { trigger: (event: BPEvent) => void },
  traces: Trace[],
  request: BPEvent,
): Promise<{ ok?: boolean; result?: { frontier?: JsonObject; pendingCount?: number } }> => {
  runtime.trigger(request)
  const deadline = Date.now() + 8_000
  for (;;) {
    const found = selectionsOf(traces).find(
      (t) =>
        t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result &&
        (t.selected.detail as { id?: string } | undefined)?.id === (request.detail as { id: string }).id,
    )
    if (found !== undefined)
      return found.selected.detail as { ok?: boolean; result?: { frontier?: JsonObject; pendingCount?: number } }
    if (Date.now() > deadline) throw new Error('replay result never re-entered')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
