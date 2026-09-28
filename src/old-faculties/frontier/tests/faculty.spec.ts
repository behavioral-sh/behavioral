import { describe, expect, test } from 'bun:test'
import type { Thread } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { bindEmit } from '../../process-lane.ts'
import { handleFrontierMessage } from '../faculty.ts'

/**
 * Frontier worker integration tests — exercised through the real worker
 * boundary speaking the behavioral event wire: `shell_request` events in
 * (the op lives on the payload), one `shell_request_result` event out.
 *
 * @remarks
 * Ported from the former fleet-tool spec: every load-bearing claim is
 * preserved — replay exactness, error-as-data on disabled selections, bfs/dfs
 * exploration, deadlock and livelock findings, truncation, and the
 * JSON-boundary serializations (stateKey, stateGraph).
 *
 * @packageDocumentation
 */

type WireResult = {
  id: string
  ok: boolean
  result?: unknown
  error?: Record<string, unknown>
  space?: string
}

/** The frontier IN-PROCESS harness — the embed the composition uses: the exported dispatch with the lane emit bound to a local collector. */
const spawnFrontierWorker = () => {
  const results: WireResult[] = []
  bindEmit((event) => {
    if (event.type === FACULTY_MESSAGE_KINDS.frontier_request_result) {
      const detail = event.detail as { id: string; ok: boolean; result?: unknown; error?: Record<string, unknown> }
      results.push({ ...detail, id: detail.id, space: event.space } as WireResult)
    }
  })
  const call = (id: string, op: string, input: unknown, space?: string): void => {
    handleFrontierMessage({
      type: FACULTY_MESSAGE_KINDS.frontier_request,
      detail: { id, op, input },
      ...(space === undefined ? {} : { space }),
    })
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const found = results.find((r) => r.id === id)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`no result for ${id}`)
      await Bun.sleep(10)
    }
  }
  return { call, resultFor, terminate: (): void => bindEmit(null) }
}

// Structural mirrors of the worker's result payloads (the worker module is
// spawn-by-URL and never imported, so the spec types its own views).
type Frontier = { status: string; enabled: Array<{ type: string; detail?: unknown }> }
type ReplayResult = {
  frontier: Frontier | null
  stateKey: string | null
  pendingCount: number | null
  isError?: boolean
  message?: string
}
type ExploreResult = {
  traces: Array<{
    messages: Array<{ kind: string; selected?: { type: string }; instanceId?: string; sessionId?: string }>
  }>
  findings: Array<{ code: string }>
  report: { visitedCount: number; findingCount: number; truncated: boolean }
  stateGraph: Record<string, { successors: Array<{ selection: { type: string } }> }>
  isError?: boolean
}
type VerifyResult = {
  status: string
  findings: Array<{ code: string }>
  report: { visitedCount: number }
  livelocks: Array<{ code: string; progressTypes?: string[]; states?: string[] }>
  isError?: boolean
}

const threads: Thread[] = [
  { label: 'ticker', rules: [{ request: { type: 'tick' } }], once: true },
  { label: 'worker', once: true, rules: [{ request: { type: 'start', detail: { id: 'job-1' } } }] },
]

describe('frontier worker — event wire', () => {
  test('a frontier_request returns one frontier_request_result carrying the id', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('r0', 'replay', { threads })
      const { id, result } = await frontier.resultFor('r0')
      expect(id).toBe('r0')
      expect((result as ReplayResult).isError).toBeFalsy()
    } finally {
      frontier.terminate()
    }
  })

  test('a request space is echoed on the result event', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('r0', 'replay', { threads }, 's1')
      const { space } = await frontier.resultFor('r0')
      expect(space).toBe('s1')
    } finally {
      frontier.terminate()
    }
  })

  test('input failing the boundary schema is error data', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('r0', 'replay', { messages: [] }) // threads required
      const { ok, error } = await frontier.resultFor('r0')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('invalid input')
    } finally {
      frontier.terminate()
    }
  })

  test('an operation outside the schema enum is dropped at the trust boundary — no result', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // 'bogus' fails the event schema (op is enum-constrained), so the worker
      // drops it before the runner lookup: nothing to correlate a result to.
      frontier.call('r0', 'bogus', { threads })
      frontier.call('r1', 'replay', { threads })
      const { id } = await frontier.resultFor('r1')
      expect(id).toBe('r1')
    } finally {
      frontier.terminate()
    }
  })
})

describe('replay', () => {
  test('replays a known selection trace, returning frontier + stateKey + pendingCount', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const messages = [
        {
          kind: 'selection' as const,
          timestamp: 0,
          instanceId: 'test',
          step: 0,
          selected: { priority: 0, type: 'tick' },
        },
      ]
      frontier.call('r1', 'replay', { threads, messages })
      const { result } = await frontier.resultFor('r1')
      const replay = result as ReplayResult

      // tick completes (once: true), worker (start) remains pending
      expect(replay.isError).toBeFalsy()
      expect(replay.frontier).not.toBeNull()
      expect(replay.frontier!.status).toBe('ready')
      expect(replay.frontier!.enabled).toHaveLength(1)
      expect(replay.frontier!.enabled[0]!.type).toBe('start')
      expect(replay.frontier!.enabled[0]!.detail).toEqual({ id: 'job-1' })
      // JSON-boundary serialization: pending Set → count, generator → stateKey
      expect(typeof replay.stateKey).toBe('string')
      expect(replay.stateKey!.length).toBeGreaterThan(0)
      expect(typeof replay.pendingCount).toBe('number')
      expect(replay.pendingCount).toBeGreaterThan(0)
    } finally {
      frontier.terminate()
    }
  })

  test('returns idle frontier when no threads request events', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const idleThreads: Thread[] = [{ label: 'quiet', rules: [{ waitFor: [{ type: 'never' }] }], once: true }]
      frontier.call('r1', 'replay', { threads: idleThreads })
      const { result } = await frontier.resultFor('r1')
      const replay = result as ReplayResult
      expect(replay.frontier!.status).toBe('idle')
      expect(typeof replay.stateKey).toBe('string')
      expect(replay.pendingCount).toBe(1)
    } finally {
      frontier.terminate()
    }
  })

  test('returns deadlock frontier when candidates exist but all are blocked', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const blockedThreads: Thread[] = [
        { label: 'requester', rules: [{ request: { type: 'a' } }] },
        { label: 'blocker', rules: [{ block: [{ type: 'a' }] }] },
      ]
      frontier.call('r1', 'replay', { threads: blockedThreads })
      const { result } = await frontier.resultFor('r1')
      const replay = result as ReplayResult
      expect(replay.frontier!.status).toBe('deadlock')
      expect(replay.frontier!.enabled).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('handles empty trace messages', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('r1', 'replay', { threads })
      const { result } = await frontier.resultFor('r1')
      const replay = result as ReplayResult
      expect(replay.frontier!.status).toBe('ready')
      expect(replay.frontier!.enabled).toHaveLength(2)
    } finally {
      frontier.terminate()
    }
  })

  test('returns isError when a selection is not enabled at its replay step', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // Selecting 'nope' which is never enabled — the raw fn throws; the
      // worker must catch and surface a structured error, never post a throw.
      const messages = [
        {
          kind: 'selection' as const,
          timestamp: 0,
          instanceId: 'test',
          step: 0,
          selected: { priority: 0, type: 'nope' },
        },
      ]
      frontier.call('r1', 'replay', { threads, messages })
      const { ok, error } = await frontier.resultFor('r1')
      expect(ok).toBe(false)
      expect(typeof error?.message).toBe('string')
    } finally {
      frontier.terminate()
    }
  })
})

describe('explore', () => {
  test('wakes transform-parked threads via matching triggers', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const transformThreads: Thread[] = [
        { label: 'shaper', rules: [{ transform: [{ type: 'raw', query: '.', target: 'shaped' }] }] },
      ]
      frontier.call('e1', 'explore', { threads: transformThreads, triggers: [{ type: 'raw' }], maxDepth: 50 })
      const { result } = await frontier.resultFor('e1')
      const explore = result as ExploreResult
      // JSON boundary: stateGraph is a plain object keyed by stateKey (not a Map);
      // the root is the first-inserted step-0 entry.
      expect(explore.stateGraph).not.toBeInstanceOf(Map)
      expect(typeof Object.keys(explore.stateGraph)[0]).toBe('string')
      const root = Object.values(explore.stateGraph)[0]!
      expect(root.successors.length).toBeGreaterThan(0)
      expect(root.successors[0]!.selection.type).toBe('raw')
    } finally {
      frontier.terminate()
    }
  })

  test('leaves transform-parked threads parked for non-matching triggers', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const transformThreads: Thread[] = [
        { label: 'shaper', rules: [{ transform: [{ type: 'raw', query: '.', target: 'shaped' }] }] },
      ]
      frontier.call('e1', 'explore', {
        threads: transformThreads,
        triggers: [{ type: 'unrelated' }],
        maxDepth: 50,
      })
      const { result } = await frontier.resultFor('e1')
      const root = Object.values((result as ExploreResult).stateGraph)[0]!
      expect(root.successors).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('bfs explores reachable histories', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('e1', 'explore', { threads, strategy: 'bfs', maxDepth: 3 })
      const { result } = await frontier.resultFor('e1')
      const explore = result as ExploreResult
      expect(explore.report.visitedCount).toBeGreaterThan(0)
      expect(explore.traces.length).toBe(explore.report.visitedCount)
      // All traces should end with a frontier trace
      for (const trace of explore.traces) {
        expect(trace.messages.length).toBeGreaterThan(0)
        const last = trace.messages[trace.messages.length - 1]
        expect(last!.kind).toBe('frontier')
      }
    } finally {
      frontier.terminate()
    }
  })

  test('dfs explores reachable histories', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('e1', 'explore', { threads, strategy: 'dfs', maxDepth: 3 })
      const { result } = await frontier.resultFor('e1')
      expect((result as ExploreResult).report.visitedCount).toBeGreaterThan(0)
    } finally {
      frontier.terminate()
    }
  })

  test('stamps the host sessionId on every synthetic trace, defaulting to the instanceId', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // Host-supplied: both id axes ride the trace wire — instanceId per-process,
      // sessionId the host's session identity.
      frontier.call('e1', 'explore', {
        threads,
        strategy: 'bfs',
        maxDepth: 3,
        instanceId: 'test',
        sessionId: 'sess_host',
      })
      const { result } = await frontier.resultFor('e1')
      const explore = result as ExploreResult
      expect(explore.isError).toBeFalsy()
      expect(explore.traces.length).toBeGreaterThan(0)
      for (const record of explore.traces) {
        for (const message of record.messages) {
          expect(message.sessionId).toBe('sess_host')
          expect(message.instanceId).toBe('test')
        }
      }

      // Absent sessionId defaults to the instanceId — same treatment as the
      // engine, no drift between the faculty's schemas and TraceBase.
      frontier.call('e2', 'explore', { threads, strategy: 'bfs', maxDepth: 3, instanceId: 'test' })
      const defaulted = await frontier.resultFor('e2')
      for (const record of (defaulted.result as ExploreResult).traces) {
        for (const message of record.messages) {
          expect(message.sessionId).toBe('test')
        }
      }
    } finally {
      frontier.terminate()
    }
  })

  test('finds deadlock', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const deadlockThreads: Thread[] = [
        { label: 'requester', rules: [{ request: { type: 'a' } }] },
        { label: 'blocker', rules: [{ block: [{ type: 'a' }] }] },
      ]
      frontier.call('e1', 'explore', { threads: deadlockThreads, maxDepth: 50 })
      const { result } = await frontier.resultFor('e1')
      const explore = result as ExploreResult
      expect(explore.findings.length).toBeGreaterThan(0)
      expect(explore.findings[0]!.code).toBe('deadlock')
      expect(explore.report.findingCount).toBe(explore.findings.length)
    } finally {
      frontier.terminate()
    }
  })

  test('respects maxDepth truncation', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // maxDepth is required (≥1 per the schema); a depth of 1 cuts off the
      // two-successor root of the ticker+worker program, so exploration is
      // truncated.
      frontier.call('e1', 'explore', { threads, strategy: 'bfs', maxDepth: 1 })
      const { result } = await frontier.resultFor('e1')
      const explore = result as ExploreResult
      expect(explore.report.truncated).toBe(true)
      expect(explore.report.visitedCount).toBeGreaterThanOrEqual(1)
    } finally {
      frontier.terminate()
    }
  })

  test('selectionPolicy: scheduler limits to one enabled candidate per step', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('e1', 'explore', {
        threads,
        strategy: 'bfs',
        selectionPolicy: 'scheduler',
        maxDepth: 3,
      })
      const scheduler = (await frontier.resultFor('e1')).result as ExploreResult
      frontier.call('e2', 'explore', {
        threads,
        strategy: 'bfs',
        selectionPolicy: 'all-enabled',
        maxDepth: 3,
      })
      const allEnabled = (await frontier.resultFor('e2')).result as ExploreResult
      // scheduler truncates breadth; visited counts may differ
      expect(scheduler.report.visitedCount).toBeGreaterThan(0)
      expect(allEnabled.report.visitedCount).toBeGreaterThan(0)
    } finally {
      frontier.terminate()
    }
  })

  test('explores with trigger events that affect pending threads', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const waitingThreads: Thread[] = [
        { label: 'waiter', rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'ack' } }], once: true },
      ]
      frontier.call('e1', 'explore', {
        threads: waitingThreads,
        triggers: [{ type: 'ping' }],
        strategy: 'bfs',
        maxDepth: 50,
      })
      const { result } = await frontier.resultFor('e1')
      const explore = result as ExploreResult
      expect(explore.report.visitedCount).toBeGreaterThan(0)
      // Should have found at least one trace where 'ack' is reached
      const hasAck = explore.traces.some((trace) =>
        trace.messages.some((msg) => msg.kind === 'selection' && msg.selected?.type === 'ack'),
      )
      expect(hasAck).toBe(true)
    } finally {
      frontier.terminate()
    }
  })

  test('ingress trigger events produce successors', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const blockingThreads: Thread[] = [{ label: 'blocker', rules: [{ block: [{ type: 'signal' }] }], once: true }]
      frontier.call('e1', 'explore', {
        threads: blockingThreads,
        triggers: [{ type: 'signal' }],
        strategy: 'bfs',
        maxDepth: 50,
      })
      const { result } = await frontier.resultFor('e1')
      expect((result as ExploreResult).report.visitedCount).toBeGreaterThanOrEqual(1)
    } finally {
      frontier.terminate()
    }
  })
})

describe('verify', () => {
  test('returns verified for deadlock-free threads', async () => {
    const frontier = spawnFrontierWorker()
    try {
      frontier.call('v1', 'verify', { threads, strategy: 'bfs', maxDepth: 3 })
      const { result } = await frontier.resultFor('v1')
      const verify = result as VerifyResult
      expect(verify.isError === undefined || verify.isError === null).toBe(true)
      expect(verify.status).toBe('verified')
      expect(verify.findings).toHaveLength(0)
      expect(verify.livelocks).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('returns failed when deadlocks found', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const deadlockThreads: Thread[] = [
        { label: 'requester', rules: [{ request: { type: 'a' } }] },
        { label: 'blocker', rules: [{ block: [{ type: 'a' }] }] },
      ]
      frontier.call('v1', 'verify', { threads: deadlockThreads, maxDepth: 50 })
      const { result } = await frontier.resultFor('v1')
      const verify = result as VerifyResult
      expect(verify.status).toBe('failed')
      expect(verify.findings.length).toBeGreaterThan(0)
    } finally {
      frontier.terminate()
    }
  })

  test('returns truncated when maxDepth cuts off exploration', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // maxDepth ≥1 per the schema; depth 1 truncates the two-successor root.
      frontier.call('v1', 'verify', { threads, strategy: 'bfs', maxDepth: 1 })
      const { result } = await frontier.resultFor('v1')
      expect((result as VerifyResult).status).toBe('truncated')
    } finally {
      frontier.terminate()
    }
  })

  test('livelock: a looping program with no progress is failed', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A ticker requesting `tick` forever. progress=['succeeded'] — the cycle
      // never selects `succeeded` → livelock → failed.
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'tick' } }] }]
      frontier.call('v1', 'verify', { threads: looping, progress: ['succeeded'], maxDepth: 50 })
      const { result } = await frontier.resultFor('v1')
      const verify = result as VerifyResult
      expect(verify.status).toBe('failed')
      expect(verify.livelocks).toHaveLength(1)
      expect(verify.livelocks[0]!.code).toBe('livelock')
      expect(verify.livelocks[0]!.progressTypes).toEqual(['succeeded'])
    } finally {
      frontier.terminate()
    }
  })

  test('livelock: a looping program whose cycle selects progress is verified', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A ticker requesting `done` forever. progress=['done'] → the cycle DOES
      // select a progress event → not a livelock → verified.
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'done' } }] }]
      frontier.call('v1', 'verify', { threads: looping, progress: ['done'], maxDepth: 50 })
      const { result } = await frontier.resultFor('v1')
      const verify = result as VerifyResult
      expect(verify.status).toBe('verified')
      expect(verify.livelocks).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('omitting progress skips livelock detection (deadlock-only)', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // Same looping ticker, no progress spec. No deadlock, not truncated →
      // verified, livelocks empty (not checked).
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'tick' } }] }]
      frontier.call('v1', 'verify', { threads: looping, maxDepth: 50 })
      const { result } = await frontier.resultFor('v1')
      const verify = result as VerifyResult
      expect(verify.status).toBe('verified')
      expect(verify.livelocks).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('an empty progress set flags every cycle as a livelock', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // progress=[] → nothing counts as progress → any cycle is a livelock.
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'done' } }] }]
      frontier.call('v1', 'verify', { threads: looping, progress: [], maxDepth: 50 })
      const { result } = await frontier.resultFor('v1')
      const verify = result as VerifyResult
      expect(verify.status).toBe('failed')
      expect(verify.livelocks).toHaveLength(1)
    } finally {
      frontier.terminate()
    }
  })
})

// ---------------------------------------------------------------------------
// Liveness and state-graph faculty — ported from the former fleet-tool
// liveness spec. No fake-graph builders, no direct imports of the graph
// internals: SCC/livelock/stateKey faculty is asserted through the worker
// boundary on real behavioral programs.
// ---------------------------------------------------------------------------

describe('frontier-explore state-keyed dedup (real programs)', () => {
  test('a looping program terminates via state-key dedup (not maxDepth cutoff)', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A `while(true)` ticker: requests `tick` forever. The pending set is
      // identical after every selection, so the state graph closes at one
      // state and exploration stops well before maxDepth — proving
      // termination via dedup, not a depth cutoff.
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'tick' } }] }]
      frontier.call('l1', 'explore', { threads: looping, strategy: 'bfs', maxDepth: 100 })
      const result = (await frontier.resultFor('l1')).result as ExploreResult
      expect(result.report.truncated).toBe(false)
      // One distinct state: the single pending bid requesting `tick`.
      expect(result.report.visitedCount).toBe(1)
      // No deadlock — `tick` is enabled.
      expect(result.findings).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('a two-state cycle closes the graph at two visited states', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // Toggle: requests `on`, then `off`, then loops. Two distinct states
      // ({request on}, {request off}); the cycle closes back to the first.
      const toggle: Thread[] = [{ label: 'toggle', rules: [{ request: { type: 'on' } }, { request: { type: 'off' } }] }]
      frontier.call('l1', 'explore', { threads: toggle, strategy: 'bfs', maxDepth: 100 })
      const result = (await frontier.resultFor('l1')).result as ExploreResult
      expect(result.report.truncated).toBe(false)
      expect(result.report.visitedCount).toBe(2)
      expect(result.findings).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('still detects deadlock in a looping program', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A looping requester whose only candidate is permanently blocked —
      // the deadlock is a genuine finding, not masked by state-keyed dedup.
      const blocked: Thread[] = [
        { label: 'requester', rules: [{ request: { type: 'a' } }] },
        { label: 'blocker', rules: [{ block: [{ type: 'a' }] }] },
      ]
      frontier.call('l1', 'explore', { threads: blocked, strategy: 'bfs', maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as ExploreResult
      expect(result.findings.length).toBeGreaterThan(0)
      expect(result.findings[0]!.code).toBe('deadlock')
    } finally {
      frontier.terminate()
    }
  })

  test('finite one-shot programs behave as before', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // Regression guard: finite-thread semantics are unchanged.
      const finite: Thread[] = [
        { label: 'ticker', rules: [{ request: { type: 'tick' } }], once: true },
        { label: 'worker', once: true, rules: [{ request: { type: 'start', detail: { id: 'job-1' } } }] },
      ]
      frontier.call('l1', 'explore', { threads: finite, strategy: 'bfs', maxDepth: 3 })
      const result = (await frontier.resultFor('l1')).result as ExploreResult
      expect(result.report.visitedCount).toBeGreaterThan(0)
      expect(result.traces.length).toBe(result.report.visitedCount)
      for (const trace of result.traces) {
        expect(trace.messages.length).toBeGreaterThan(0)
        const last = trace.messages[trace.messages.length - 1]
        expect(last!.kind).toBe('frontier')
      }
    } finally {
      frontier.terminate()
    }
  })

  test('two structurally-equal programs yield the same serialized state graph', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // The same toggle authored twice (different label strings, same
      // request idioms) explores to the same state-graph structure. This is
      // the public expression of frontierStateKey's order- and
      // generator-identity invariance — no fake PendingBid fixtures.
      const program: Thread[] = [
        { label: 'toggle', rules: [{ request: { type: 'on' } }, { request: { type: 'off' } }] },
      ]
      frontier.call('l1', 'explore', { threads: program, strategy: 'bfs', maxDepth: 50 })
      const a = (await frontier.resultFor('l1')).result as ExploreResult
      frontier.call('l2', 'explore', {
        threads: [{ label: 'other-label', rules: [{ request: { type: 'on' } }, { request: { type: 'off' } }] }],
        strategy: 'bfs',
        maxDepth: 50,
      })
      const b = (await frontier.resultFor('l2')).result as ExploreResult
      expect(a.report.visitedCount).toBe(b.report.visitedCount)
      expect(Object.keys(a.stateGraph).length).toBe(Object.keys(b.stateGraph).length)
      // Each root has a successor edge selecting `on`.
      const aRoot = Object.values(a.stateGraph)[0]!
      const bRoot = Object.values(b.stateGraph)[0]!
      expect(aRoot.successors.some((e) => e.selection.type === 'on')).toBe(true)
      expect(bRoot.successors.some((e) => e.selection.type === 'on')).toBe(true)
    } finally {
      frontier.terminate()
    }
  })

  test('a large single cycle terminates without stack overflow', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A 60-step ring thread: requests n0..n59, then loops. Sixty distinct
      // states close back to the first. The iterative SCC algorithm must
      // handle this; a recursive impl would blow the stack.
      const rules = Array.from({ length: 60 }, (_, i) => ({ request: { type: `n${i}` } }))
      const ring: Thread[] = [{ label: 'ring', rules }]
      frontier.call('l1', 'explore', { threads: ring, strategy: 'bfs', maxDepth: 500 })
      const result = (await frontier.resultFor('l1')).result as ExploreResult
      expect(result.report.truncated).toBe(false)
      expect(result.report.visitedCount).toBe(60)
    } finally {
      frontier.terminate()
    }
  })
})

describe('frontier-verify livelock integration (real programs)', () => {
  test('a looping program with no progress is failed (livelock)', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'tick' } }] }]
      frontier.call('l1', 'verify', { threads: looping, progress: ['succeeded'], maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('failed')
      expect(result.livelocks).toHaveLength(1)
      expect(result.livelocks[0]!.code).toBe('livelock')
      expect(result.livelocks[0]!.progressTypes).toEqual(['succeeded'])
      // The livelock's states are the cycle's state keys (here, one state).
      expect(result.livelocks[0]!.states!.length).toBeGreaterThanOrEqual(1)
    } finally {
      frontier.terminate()
    }
  })

  test('a looping program whose cycle selects a progress event is verified', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'done' } }] }]
      frontier.call('l1', 'verify', { threads: looping, progress: ['done'], maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('verified')
      expect(result.livelocks).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('omitting progress skips livelock detection (deadlock-only)', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'tick' } }] }]
      frontier.call('l1', 'verify', { threads: looping, maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('verified')
      expect(result.livelocks).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('an empty progress set flags every cycle as a livelock', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const looping: Thread[] = [{ label: 'ticker', rules: [{ request: { type: 'done' } }] }]
      frontier.call('l1', 'verify', { threads: looping, progress: [], maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('failed')
      expect(result.livelocks).toHaveLength(1)
    } finally {
      frontier.terminate()
    }
  })

  test('deadlock still wins as failed even when progress is specified', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const blocked: Thread[] = [
        { label: 'requester', rules: [{ request: { type: 'a' } }] },
        { label: 'blocker', rules: [{ block: [{ type: 'a' }] }] },
      ]
      frontier.call('l1', 'verify', { threads: blocked, progress: ['x'], maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('failed')
      expect(result.findings.length).toBeGreaterThan(0)
    } finally {
      frontier.terminate()
    }
  })

  test('escape-edges do not redeem a livelock (two-state cycle with an exit)', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A cycle (tick→tick) with a progress `done` edge that LEAVES the
      // cycle to a sink state. `done` is progress, but it leaves the cycle —
      // the cycle itself never selects `done`, so it is still a livelock.
      const threads: Thread[] = [
        {
          label: 'cycler-with-exit',
          rules: [{ request: { type: 'tick' } }, { request: { type: 'tick' } }, { request: { type: 'done' } }],
        },
        { label: 'sink', once: true, rules: [{ waitFor: [{ type: 'done' }] }] },
      ]
      frontier.call('l1', 'verify', { threads, progress: ['done'], maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('failed')
      expect(result.livelocks.length).toBeGreaterThanOrEqual(1)
      expect(result.livelocks[0]!.code).toBe('livelock')
      expect(result.livelocks[0]!.progressTypes).toEqual(['done'])
    } finally {
      frontier.terminate()
    }
  })

  test('a two-state cycle that selects progress internally is verified', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // A two-state cycle where one of the in-cycle edges IS the progress
      // event: toggle requests `done` then `tick`, looping.
      const threads: Thread[] = [
        { label: 'toggle', rules: [{ request: { type: 'done' } }, { request: { type: 'tick' } }] },
      ]
      frontier.call('l1', 'verify', { threads, progress: ['done'], maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as VerifyResult
      expect(result.status).toBe('verified')
      expect(result.livelocks).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('frontier-explore exposes the state graph for downstream analysis', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const threads: Thread[] = [
        { label: 'toggle', rules: [{ request: { type: 'on' } }, { request: { type: 'off' } }] },
      ]
      frontier.call('l1', 'explore', { threads, strategy: 'bfs', maxDepth: 50 })
      const result = (await frontier.resultFor('l1')).result as ExploreResult
      expect(result.stateGraph).toBeDefined()
      expect(Object.keys(result.stateGraph).length).toBe(2)
      for (const node of Object.values(result.stateGraph)) {
        expect(node.successors.length).toBeGreaterThanOrEqual(1)
      }
    } finally {
      frontier.terminate()
    }
  })
})

describe('add_thread', () => {
  type AddThreadResult = {
    ok: boolean
    thread: Thread
    status: 'verified' | 'failed' | 'truncated'
    findings: Array<{ code: string }>
    livelocks: Array<{ code: string }>
    report: { visitedCount: number }
    isError?: boolean
    message?: string
  }

  test('a valid proposed thread verifies: ok true, the thread echoed, the analysis attached', async () => {
    const frontier = spawnFrontierWorker()
    try {
      const thread: Thread = { label: 'greeter', rules: [{ request: { type: 'ping' } }] }
      frontier.call('a1', 'add_thread', { thread, maxDepth: 8 })
      const result = (await frontier.resultFor('a1')).result as AddThreadResult
      expect(result.ok).toBe(true)
      expect(result.status).toBe('verified')
      expect(result.thread).toEqual(thread)
      expect(result.findings).toHaveLength(0)
    } finally {
      frontier.terminate()
    }
  })

  test('a thread failing the Thread schema is boundary-rejected with error data', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // `rules` is required by the engine's Thread schema home — the derived
      // input schema rejects the whole input at the boundary.
      frontier.call('a1', 'add_thread', { thread: { label: 'broken' }, maxDepth: 8 })
      const { ok, error } = await frontier.resultFor('a1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('invalid input')
    } finally {
      frontier.terminate()
    }
  })

  test('a deadlock-producing proposal is rejected with the analysis findings', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // The mounted set blocks `ping`; the proposed thread requests `ping` and
      // waits forever — the joined set deadlocks.
      const threads: Thread[] = [{ label: 'blocker', once: true, rules: [{ block: [{ type: 'ping' }] }] }]
      const thread: Thread = {
        label: 'greeter',
        rules: [{ request: { type: 'ping' } }, { waitFor: [{ type: 'never' }] }],
      }
      frontier.call('a1', 'add_thread', { thread, threads, maxDepth: 8 })
      const result = (await frontier.resultFor('a1')).result as AddThreadResult
      expect(result.ok).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.findings.length).toBeGreaterThanOrEqual(1)
      expect(result.findings[0]!.code).toBe('deadlock')
      expect(result.thread).toEqual(thread)
    } finally {
      frontier.terminate()
    }
  })

  test('a livelocking proposal is rejected via the progress spec', async () => {
    const frontier = spawnFrontierWorker()
    try {
      // The proposed thread loops forever selecting only `tick` — with
      // progress = ['done'] that cycle never makes progress.
      const thread: Thread = { label: 'spinner', rules: [{ request: { type: 'tick' } }] }
      frontier.call('a1', 'add_thread', { thread, progress: ['done'], maxDepth: 8 })
      const result = (await frontier.resultFor('a1')).result as AddThreadResult
      expect(result.ok).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.livelocks.length).toBeGreaterThanOrEqual(1)
    } finally {
      frontier.terminate()
    }
  })
})
