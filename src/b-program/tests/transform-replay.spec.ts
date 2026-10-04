import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { JsonObject, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { spawnFacultyWorker } from '../../faculties/tests/faculty-harness.ts'
import { type UiRun, uiReplayRequest } from '../ui-capture.ts'

/**
 * The replay pins (slice 3): the frontier replay NEVER re-evaluates a
 * transform — the LOG carries the answers. Two proofs:
 *
 * 1. A REAL pre-switch capture (fixtures/preswitch-capture/ — generated at
 *    the pre-switch commit by the in-engine jq evaluator, one full ui
 *    pipeline with six transform re-entries) replays BIT-IDENTICAL under
 *    the new semantics: the same stateKey, pendingCount, and frontier the
 *    pre-switch replay produced (the recorded baselines). The frozen
 *    evaluated details ride the captured re-entry threads; the replay
 *    reconstructs the targets through the request-origin path.
 * 2. A post-switch trace prefix carries the faculty wire's own selections
 *    (`transform_request` / `transform_request_result`) — the replay's
 *    thread set never consumes them; they SKIP (the logged result is the
 *    answer, the target reconstructs), never a "not enabled" throw.
 */

const fixture = (name: string): string => new URL(`./fixtures/preswitch-capture/${name}`, import.meta.url).pathname

const loadRun = async (): Promise<UiRun> => {
  const line = await Bun.file(fixture('ui-runs.jsonl')).text()
  return JSON.parse(line.trim()) as UiRun
}

type ReplayResult = {
  stateKey: string | null
  pendingCount: number | null
  frontier: unknown
  isError?: boolean
  message?: string
}

/** Replay a built request through the REAL frontier faculty worker. */
const replayThrough = async (request: ReturnType<typeof uiReplayRequest>): Promise<ReplayResult> => {
  const faculty = spawnFacultyWorker({
    url: new URL('../../faculties/frontier-analysis.faculty.ts', import.meta.url),
    requestType: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
    resultType: FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
  })
  try {
    const detail = request.detail as { id: string } & JsonObject
    faculty.call(detail as unknown as JsonObject)
    const result = await faculty.resultFor(detail.id)
    return (
      (result.detail as { ok: boolean; result?: ReplayResult }).result ?? {
        stateKey: null,
        pendingCount: null,
        frontier: null,
        isError: true,
        message: 'no result payload',
      }
    )
  } finally {
    faculty.terminate()
  }
}

describe('the transform replay — the log answers, never re-evaluation', () => {
  test('a REAL pre-switch capture replays bit-identical — the full run', async () => {
    const run = await loadRun()
    const result = await replayThrough(uiReplayRequest(run))
    const expected = (await Bun.file(fixture('replay-expected-full.json')).json()) as ReplayResult
    // The pre-switch replay's output — the same stateKey, pending count, and
    // frontier — reproduced under the mint semantics.
    expect(result.isError).toBeUndefined()
    expect(result.pendingCount).toBe(expected.pendingCount)
    expect(result.stateKey).toBe(expected.stateKey)
    expect(result.frontier).toEqual(expected.frontier)
  })

  test('the prefix replay holds at the scale reply — position-tag ordering intact', async () => {
    const run = await loadRun()
    // The first two messages: the render ingress + the scale check — the
    // scale-join parks on its transform (the hold the prefix exposes).
    const result = await replayThrough(uiReplayRequest(run, 2))
    const expected = (await Bun.file(fixture('replay-expected-prefix.json')).json()) as ReplayResult
    expect(result.isError).toBeUndefined()
    expect(result.pendingCount).toBe(expected.pendingCount)
    expect(result.stateKey).toBe(expected.stateKey)
    expect(result.frontier).toEqual(expected.frontier)
  })

  test('a post-switch prefix skips the faculty wire selections — the logged result is the answer', async () => {
    // The shaper's reshape contract: evt → ship. The waiter consumes the
    // target. The wire selections (the engine's mint + the faculty's
    // answer) ride the prefix BETWEEN the source and the target — the
    // replay's thread set never consumes them.
    const threads = [
      {
        name: 'shaper',
        description: 'Test thread.',
        rules: [{ transform: [{ type: 'evt', query: '.v', target: 'ship' }] }],
      },
      {
        name: 'waiter',
        description: 'Test thread.',
        once: true,
        rules: [{ waitFor: [{ type: 'ship' }] }, { request: { type: 'done' } }],
      },
    ] as unknown as JsonObject[]
    const sel = (type: string, detail?: JsonObject): Trace =>
      ({
        kind: TRACE_MESSAGE_KINDS.selection,
        timestamp: 0,
        instanceId: 'replay-spec',
        sessionId: 'replay-spec',
        selected: { type, ...(detail === undefined ? {} : { detail }) },
      }) as unknown as Trace
    const messages = [
      sel('evt', { v: 1 }),
      // The engine's mint — a request-origin re-entry no thread consumes.
      sel(FACULTY_MESSAGE_KINDS.transform_request, { id: 'tr-1', query: '.v', target: 'ship', detail: { v: 1 } }),
      // The faculty's answer — the logged result IS the evaluation.
      sel(FACULTY_MESSAGE_KINDS.transform_request_result, { id: 'tr-1', ok: true, value: { v: 1 } }),
      // The composition's target mint — reconstructed on the request-origin path.
      sel('ship', { v: 1 }),
      sel('done'),
    ]
    const result = await replayThrough({
      type: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
      detail: {
        id: 'wire-prefix',
        op: 'replay',
        input: { threads, messages: messages as unknown as JsonObject[] },
      } as unknown as JsonObject,
    } as unknown as ReturnType<typeof uiReplayRequest>)
    expect(result.isError).toBeUndefined()
    // The waiter completed (its once rules exhausted) — the replay reached
    // the end of the prefix through the wire selections.
    expect(result.pendingCount).toBe(1)
  })
})
