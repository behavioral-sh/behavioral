/**
 * The frontierAnalysis faculty worker entry — the reachability analysis engine: replays,
 * explores, and verifies behavioral thread sets off the host thread.
 *
 * @remarks
 * One file, one faculty: the analysis engine (the former fleet tool
 * implementation, moved wholesale — only the boundary changed) behind the
 * top-level `createWorker` bootstrap. It speaks the behavioral event wire —
 * `frontier_analysis_request` events in (dispatched by `detail.op`: replay / explore /
 * verify / add_thread), one `frontier_analysis_request_result` out with the request
 * `umwelt` echoed. It needs no cancel event and no timeout: analyses are
 * synchronous, nothing is in flight to abort.
 *
 * Self-analysis is safe by construction: the trace a caller passes is a frozen
 * structured-clone payload, this faculty's simulation state is private, and
 * its own calls in the host trace are logical breakpoints.
 *
 * MINIMAL: results are synchronous analyses; an analysis call blocks this
 * worker only, never the host — no stream lane needed.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { FRONTIER_STATUS, TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type {
  BPEvent,
  CandidateBid,
  Frontier,
  FrontierTrace,
  JsonObject,
  PendingBid,
  RegisteredBPListener,
  RegisteredIdioms,
  RegisteredTransformListener,
  ReplayToFrontierResult,
  RunningBid,
  SelectionTrace,
  Thread,
  Trace,
} from '../behavioral/behavioral.types.ts'
import { ajv, BPEventSchema, SerializedThreadSchema, ThreadSchema } from '../behavioral/behavioral.types.ts'
import {
  advanceRunningToPending,
  computeFrontier,
  generateRulesFunctions,
  isListeningFor,
  resumePendingThreadsForSelectedEvent,
  useThread,
} from '../behavioral/behavioral.utils.ts'
import { deepEqual } from '../utils/deep-equal.ts'
import { uuid } from '../utils/uuid.ts'
import { createWorker, type FacultyRespond } from './create-worker.ts'
import { FACULTY_MESSAGE_KINDS } from './faculties.constants.ts'
import { type FrontierAnalysisOp, validateFrontierAnalysisRequestEvent } from './faculties.types.ts'

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const countSelectionTraces = ({ messages }: { messages: Trace[] }) =>
  messages.reduce((count, msg) => count + (msg.kind === 'selection' ? 1 : 0), 0)

const createFrontierTrace = ({
  frontier,
  step,
  instanceId,
  sessionId,
}: {
  frontier: Frontier
  step: number
  instanceId: string
  sessionId: string
}): FrontierTrace => ({
  kind: 'frontier',
  timestamp: Date.now(),
  instanceId,
  sessionId,
  step,
  status: frontier.status,
  candidates: frontier.candidates.map((candidate) => ({
    priority: candidate.priority,
    type: candidate.type,
    ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
    ...(candidate.ingress === undefined ? {} : { ingress: candidate.ingress }),
    ...(candidate.umwelt === undefined ? {} : { umwelt: candidate.umwelt }),
  })),
  enabled: frontier.enabled.map((candidate) => ({
    priority: candidate.priority,
    type: candidate.type,
    ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
    ...(candidate.ingress === undefined ? {} : { ingress: candidate.ingress }),
    ...(candidate.umwelt === undefined ? {} : { umwelt: candidate.umwelt }),
  })),
})

const createSelectionTrace = ({
  selected,
  step,
  instanceId,
  sessionId,
}: {
  selected: CandidateBid
  step: number
  instanceId: string
  sessionId: string
}): SelectionTrace => ({
  kind: TRACE_MESSAGE_KINDS.selection,
  timestamp: Date.now(),
  instanceId,
  sessionId,
  step,
  selected,
})

const createDeadlockTrace = ({
  step,
  instanceId,
  sessionId,
}: {
  step: number
  instanceId: string
  sessionId: string
}): Trace => ({
  kind: TRACE_MESSAGE_KINDS.deadlock,
  timestamp: Date.now(),
  instanceId,
  sessionId,
  step,
})

const matchesSelectedEvent = ({ candidate, selected }: { candidate: CandidateBid; selected: CandidateBid }) =>
  candidate.type === selected.type &&
  candidate.umwelt === selected.umwelt &&
  deepEqual(candidate.detail, selected.detail)

/**
 * Mints an ephemeral identity key for a replay-constructed bid — the engine's
 * running/pending maps are identity-keyed; replay threads have no instance
 * hash, so they mint uuid keys (never removal-addressable).
 */
const bidKey = (): string => uuid('u_')

/**
 * @internal
 * Add a synthetic once-thread requesting the selected event so replay can
 * match it. With `ingress: true` this reconstructs an external trigger
 * admission; omitting it reconstructs an internal re-entry — the bridge or
 * transform-daemon once-thread that is not part of the candidate thread set.
 */
const addSyntheticRequestThread = ({
  pending,
  selected,
  ingress,
}: {
  pending: Map<string, PendingBid>
  selected: CandidateBid
  ingress?: true
}) => {
  const triggerThread = function* () {
    yield {
      request: {
        type: selected.type,
        ...(selected.detail === undefined ? {} : { detail: selected.detail }),
        ...(selected.umwelt === undefined ? {} : { umwelt: selected.umwelt }),
      },
    }
  }
  const generator = triggerThread()
  const yielded = generator.next()

  if (!yielded.done) {
    const key = bidKey()
    pending.set(key, {
      priority: 0,
      generator,
      ...(ingress === true ? { ingress: true as const } : {}),
      name: selected.type,
      ...(ingress === true
        ? { description: `Ingress event thread — minted for the trigger-arrived ${selected.type} event.` }
        : {}),
      key,
      ...yielded.value,
    })
  }
}

/**
 * @internal
 * Whether a selected event is consumed by a pending bid's wait/interrupt/
 * transform listener. A request-origin selection that is not enabled by the
 * candidate set is reconstructed as an internal re-entry only when some
 * pending bid actually consumes it; otherwise the selection is invalid.
 */
const pendingBidConsumes = ({ pendingBid, selected }: { pendingBid: PendingBid; selected: CandidateBid }) => {
  const listeners = [...(pendingBid.waitFor ?? []), ...(pendingBid.interrupt ?? []), ...(pendingBid.transform ?? [])]
  return listeners.some(isListeningFor(selected))
}

const getSelectedEvents = ({ messages }: { messages: Trace[] }) =>
  messages.flatMap((msg) => (msg.kind === TRACE_MESSAGE_KINDS.selection ? [msg.selected] : []))

/**
 * Compiles an array of {@link Thread} tuples into the generator representations
 * needed by the frontier engine.
 *
 * @param threads - Thread tuples ({ name, description, rules, once? }).
 * @param umwelt - Optional umwelt stamp to pass into {@link generateRulesFunctions}.
 * @returns Compiled entries each with the authored `name` and a started generator.
 */
const compileThreads = (
  threads: Thread[],
  umwelt?: string,
): Array<{ name: string; description?: string; generator: IterableIterator<RegisteredIdioms> }> =>
  threads.map(({ name, description, rules, once }) => ({
    name,
    ...(description === undefined ? {} : { description }),
    generator: useThread(generateRulesFunctions(rules, umwelt), once)(),
  }))

/**
 * One explored history: trace messages including the final frontier.
 *
 * @public
 */
type TraceRecord = {
  messages: Trace[]
}

/**
 * A deadlock finding discovered during exploration.
 *
 * @public
 */
type DeadlockFinding = {
  code: 'deadlock'
  messages: Trace[]
}

/**
 * Replays a concrete sequence of selection trace messages against a thread
 * set and returns the resulting frontier.
 *
 * @param args.threads - Thread tuples to replay.
 * @param args.messages - Selection trace to replay. Each selection is
 *   checked for enablement at the corresponding step.
 * @param args.umwelt - Optional umwelt stamp applied to all thread rules.
 * @param args.instanceId - Instance id stamped on synthetic interrupt/transform
 *   traces emitted during resumption. Defaults to a minted `bp_` UUIDv7.
 * @param args.sessionId - Host session id stamped on the same traces alongside
 *   `instanceId`. Defaults to the `instanceId` — the faculty never mints one.
 * @returns The replay result containing the pending set and final frontier.
 *
 * @throws If a selection event is not enabled at its replay step.
 *
 * @public
 */
const replayToFrontierRaw = ({
  threads,
  messages = [],
  umwelt,
  instanceId = uuid('bp_'),
  sessionId,
}: {
  threads: Thread[]
  messages?: Trace[]
  umwelt?: string
  instanceId?: string
  sessionId?: string
}): ReplayToFrontierResult => {
  const resolvedSessionId = sessionId ?? instanceId
  const pending = new Map<string, PendingBid>()
  const running = new Map<string, RunningBid>()

  const entries = compileThreads(threads, umwelt)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const key = bidKey()
    running.set(key, {
      priority: i + 1,
      generator: entry.generator,
      name: entry.name,
      key,
      ...(entry.description === undefined ? {} : { description: entry.description }),
    })
  }

  advanceRunningToPending(running, pending)

  for (const [step, selected] of getSelectedEvents({ messages }).entries()) {
    // The transform faculty's wire traffic — the engine's mint and the
    // faculty's answer — is NOT engine-candidate vocabulary: the replay's
    // thread set never consumes it. The LOGGED result carries the evaluated
    // detail (the id join), and the target re-entry reconstructs through the
    // request-origin path below — frozen, never re-evaluated.
    if (
      selected.type === FACULTY_MESSAGE_KINDS.transform_request ||
      selected.type === FACULTY_MESSAGE_KINDS.transform_request_result
    )
      continue
    if (selected.ingress === true) {
      addSyntheticRequestThread({ pending, selected, ingress: true })
    }

    const findMatch = () =>
      [...computeFrontier(pending).enabled]
        .sort((left, right) => left.priority - right.priority)
        .find((candidate) => matchesSelectedEvent({ candidate, selected }))

    let matched = findMatch()
    if (
      !matched &&
      selected.ingress !== true &&
      [...pending.values()].some((pendingBid) => pendingBidConsumes({ pendingBid, selected }))
    ) {
      // Request-origin re-entry whose producer (bridge/transform daemon) is a
      // harness thread absent from the candidate set: reconstruct the
      // once-thread it added and retry the enablement check.
      addSyntheticRequestThread({ pending, selected })
      matched = findMatch()
    }

    if (!matched) {
      throw new Error(`Selected event "${selected.type}" was not enabled at replay step ${step}.`)
    }

    const resumed = new Map<string, RunningBid>()
    resumePendingThreadsForSelectedEvent({
      running: resumed,
      pending,
      selectedEvent: matched,
      instanceId,
      sessionId: resolvedSessionId,
      step,
    })
    advanceRunningToPending(resumed, pending)
  }

  return {
    pending,
    frontier: computeFrontier(pending),
  }
}

/**
 * @internal
 * How a trigger event would affect a pending bid, split by provenance channel.
 *
 * External admission (`ingress: true`) wakes listeners with `ingressMatch`
 * absent or `true`; internal re-entry (request-origin, `ingress` absent) wakes
 * listeners with `ingressMatch` absent or `false`. A bid's own matching
 * `request` is channel-independent. `requestOnly` flags that some listener is
 * exclusively internal, so an external admission alone would leave it parked.
 */
const triggerChannelMatch = ({ pendingBid, trigger }: { pendingBid: PendingBid; trigger: BPEvent }) => {
  if (pendingBid.ingress === true) {
    return { external: false, request: false, requestOnly: false }
  }

  const base = {
    priority: 0,
    type: trigger.type,
    ...(trigger.detail === undefined ? {} : { detail: trigger.detail }),
    ...(trigger.umwelt === undefined ? {} : { umwelt: trigger.umwelt }),
  }
  const externalCandidate: CandidateBid = { ...base, ingress: true }
  const requestCandidate: CandidateBid = base
  const listeners = [...(pendingBid.waitFor ?? []), ...(pendingBid.interrupt ?? []), ...(pendingBid.transform ?? [])]
  const matches = (candidate: CandidateBid) => listeners.some(isListeningFor(candidate))
  const requestMatches =
    pendingBid.request !== undefined &&
    pendingBid.request.type === trigger.type &&
    pendingBid.request.umwelt === trigger.umwelt &&
    deepEqual(pendingBid.request.detail, trigger.detail)

  return {
    external: requestMatches || matches(externalCandidate),
    request: matches(requestCandidate),
    requestOnly: listeners.some((listener) => listener.ingressMatch === false),
  }
}

const getRequestSuccessors = ({
  frontier,
  selectionPolicy,
  step,
  instanceId,
  sessionId,
}: {
  frontier: Frontier
  selectionPolicy: 'all-enabled' | 'scheduler'
  step: number
  instanceId: string
  sessionId: string
}) => {
  if (frontier.status !== FRONTIER_STATUS.ready) {
    return []
  }

  const enabled =
    selectionPolicy === 'scheduler'
      ? [...frontier.enabled].sort((left, right) => left.priority - right.priority).slice(0, 1)
      : frontier.enabled

  return enabled.map((candidate) => createSelectionTrace({ selected: candidate, step, instanceId, sessionId }))
}

const getTriggerSuccessors = ({
  pending,
  messages,
  threads,
  step,
  triggers,
  umwelt,
  instanceId,
  sessionId,
}: {
  pending: Map<string, PendingBid>
  messages: Trace[]
  threads: Thread[]
  step: number
  triggers: BPEvent[]
  umwelt?: string
  instanceId: string
  sessionId: string
}) => {
  const successors: SelectionTrace[] = []

  for (const trigger of triggers) {
    let external = false
    let request = false
    let requestOnly = false
    for (const pendingBid of pending.values()) {
      const match = triggerChannelMatch({ pendingBid, trigger })
      external ||= match.external
      request ||= match.request
      requestOnly ||= match.requestOnly
    }

    // External admission first (backward compatible). A request-origin
    // successor is added only when needed: when no external listener matched,
    // or when an `ingressMatch: false` listener would otherwise stay parked.
    const channels: (true | undefined)[] = []
    if (external) channels.push(true)
    if (request && (requestOnly || !external)) channels.push(undefined)

    for (const ingress of channels) {
      const selection = createSelectionTrace({
        step,
        instanceId,
        sessionId,
        selected: {
          priority: 0,
          type: trigger.type,
          ...(trigger.detail === undefined ? {} : { detail: trigger.detail }),
          ...(trigger.umwelt === undefined ? {} : { umwelt: trigger.umwelt }),
          ...(ingress === true ? { ingress: true as const } : {}),
        },
      })

      try {
        replayToFrontierRaw({
          threads,
          messages: [...messages, selection],
          umwelt,
          instanceId,
          sessionId,
        })
        successors.push(selection)
      } catch {
        // selection not valid for this frontier — skip
      }
    }
  }

  return successors
}

/**
 * @internal
 * Canonicalizes a listener set into a content-sorted array of JSON strings.
 *
 * Each listener (`waitFor`/`block`/`interrupt`/`transform`) is projected to its
 * JSON-only form — the `detailSchema` JSON Schema is taken as-is
 * — and serialized. The resulting strings are sorted so two listener sets that
 * differ only by declaration order produce the same array. This is what lets
 * {@link frontierStateKey} treat structurally-equal pending sets as the same
 * state.
 *
 * @param listener - Listeners to canonicalize.
 * @returns A sorted array of JSON strings, one per projected listener.
 */
const normalizeListeners = (listener: RegisteredBPListener[] | RegisteredTransformListener[]) =>
  // Raw-JSON-Schema listeners serialize without conversion.
  listener.map((l) => JSON.stringify(l)).sort()

/**
 * Derive a canonical string key for a BP pending set.
 *
 * Two pending sets collapse to the same key when they are structurally
 * identical — same threads parked at the same sync points, yielding the same
 * idioms with the same constraints — regardless of bid insertion order or the
 * identity of the underlying generator closures. This is the abstraction that
 * lets `exploreFrontiersRaw` close the state graph for looping programs instead
 * of chasing ever-growing traces.
 *
 * @remarks
 * - Drops instance-identity and non-serializable artifacts: the `generator`
 *   closure and each listener's `detailSchema` (JSON Schema, taken as-is
 *   in its place).
 * - `request` is projected to `{ type, detail, umwelt }`. Bid order and listener
 *   order are canonicalized by sorting on serialized content, yielding a total
 *   order independent of input order.
 *
 * MINIMAL: relies on object-key insertion order being stable across paths
 * (true while `advanceRunningToPending` constructs bids consistently). A
 * reordered-keys `detail`/`detailSchema` would produce a different key for a
 * semantically-equal state. Upgrade path: swap `JSON.stringify` for a
 * recursive canonical-JSON serializer (an in-progress `canonicalJsonStringify`
 * is referenced by `src/utils/tests/canonical-json.spec.ts`).
 *
 * @param pending - The pending bid set to canonicalize.
 * @returns A stable string key; equal keys imply structurally-equal states.
 *
 * @public
 */
const frontierStateKey = ({ pending }: { pending: Map<string, PendingBid> }): string =>
  JSON.stringify(
    [...pending.values()]
      .map(({ waitFor, block, interrupt, request, transform, generator: _gen, key: _key, thread: _thread, ...rest }) =>
        JSON.stringify({
          ...rest,
          // request is field-picked to { type, detail, umwelt } so non-trace
          // fields never enter the state key (frontier invariant).
          ...(request && {
            request: {
              umwelt: request.umwelt,
              type: request.type,
              ...(request.detail === undefined ? {} : { detail: request.detail }),
            },
          }),
          ...(waitFor && { waitFor: normalizeListeners(waitFor) }),
          ...(block && { block: normalizeListeners(block) }),
          ...(interrupt && { interrupt: normalizeListeners(interrupt) }),
          ...(transform && { transform: normalizeListeners(transform) }),
        }),
      )
      .sort(),
  )

type StateNode = {
  stateKey: string
  /** The frontier at this state; Step 3 reads enabled/candidates here. */
  frontier: Frontier
  /** Selection depth at first discovery (BFS-shortest under bfs; arbitrary under dfs). */
  step: number
  /** Labeled outgoing edges: the event selected to reach each successor state. */
  successors: Array<{ selection: CandidateBid; to: string }>
}

/**
 * An SCC is a cycle iff it has more than one node, or a single node with a
 * self-edge. Single-node SCCs without a self-edge are DAG leaves, not cycles.
 *
 * @param scc - One strongly connected component (array of state keys).
 * @param graph - The graph the SCC came from, used to detect self-edges.
 * @returns `true` when the SCC represents a reachable cycle.
 *
 * @public
 */
const isCycle = (scc: string[], graph: Map<string, StateNode>): boolean =>
  scc.length > 1 || (scc.length === 1 && graph.get(scc[0]!)!.successors.some((e) => e.to === scc[0]!))

/**
 * Partition a labeled state graph into its strongly connected components via
 * iterative Tarjan.
 *
 * Returns EVERY SCC, including trivial single-node components that are not
 * cycles (a DAG yields one trivial SCC per node). Cycle interpretation is a
 * separate concern handled by {@link isCycle}; this finder deliberately does
 * not filter, so callers can inspect raw component structure and so the SCC
 * algorithm stays independently testable.
 *
 * @remarks
 * Iterative (explicit work stack) rather than recursive, so a large single
 * cycle does not overflow the JS stack. Depends only on node adjacency
 * (`successors: Array<{ to }>`), so it accepts the state graph built by
 * `exploreFrontiersRaw` as well as hand-constructed fake graphs for testing.
 *
 * @param graph - Graph keyed by state key; each node carries its successor edges.
 * @returns One array per SCC, each containing the state keys in that component.
 *
 * @public
 */
const findStronglyConnectedComponents = (graph: Map<string, StateNode>): string[][] => {
  let index = 0
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  const work: { node: string; cursor: number }[] = [] // explicit recursion stack

  for (const root of graph.keys()) {
    if (indices.has(root)) continue // already processed by an earlier DFS

    // DISCOVER root: assign index, lowlink, push onto SCC stack, push work frame
    indices.set(root, index)
    lowlinks.set(root, index)
    onStack.add(root)
    stack.push(root)
    work.push({ node: root, cursor: 0 })

    index++
    while (work.length > 0) {
      const frame = work[work.length - 1]! // peek, don't pop yet
      const succ = graph.get(frame.node)!.successors

      if (frame.cursor < succ.length) {
        const w = succ[frame.cursor]!.to
        frame.cursor++

        if (!indices.has(w)) {
          // Case 1: descend. (cursor already advanced)
          indices.set(w, index)
          lowlinks.set(w, index)
          index++
          onStack.add(w)
          stack.push(w)
          work.push({ node: w, cursor: 0 })
        } else if (onStack.has(w)) {
          // Case 2: back-edge to an ancestor — use INDEX (this rule is now only
          // ever reached for genuine back-edges, never for child-returns, because
          // child-returns no longer revisit the edge).
          lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node)!, indices.get(w)!))
        }
        continue
      }

      // CURSOR EXHAUSTED
      if (lowlinks.get(frame.node) === indices.get(frame.node)) {
        const scc: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          scc.push(w)
        } while (w !== frame.node)
        sccs.push(scc)
      }
      work.pop()

      // ← CHILD-RETURN PROPAGATION: the frame we just popped is a child of the new
      // top frame. Propagate the child's LOWLINK (not its index) into the parent.
      if (work.length > 0) {
        const parent = work[work.length - 1]!
        lowlinks.set(parent.node, Math.min(lowlinks.get(parent.node)!, lowlinks.get(frame.node)!))
      }
    }
  }
  return sccs
}

/**
 * A livelock finding: a reachable cycle in which no progress event is ever
 * selected. The program can spin forever inside the cycle without
 * accomplishing anything the caller declared meaningful.
 *
 * @remarks
 * `states` is the set of state keys in the cycle (a strongly connected
 * component). `progressTypes` records the caller-supplied progress set, so a
 * consumer replaying or reporting the finding knows what was being checked.
 *
 * @public
 */
type LivelockFinding = {
  code: 'livelock'
  states: string[]
  progressTypes: string[]
}

/**
 * Detect livelocks in a labeled state graph.
 *
 * A livelock is a cycle (per {@link isCycle}) in which no edge is labeled by a
 * progress event. "Progress" is whatever the caller declares meaningful — this
 * is the specification pillar: the caller supplies the property, and this
 * function checks that every reachable cycle selects at least one progress
 * event. A cycle that never does can spin forever without accomplishing
 * anything.
 *
 * @remarks
 * Only edges whose endpoints both lie in the SCC count toward progress — an
 * edge that *leaves* the cycle is an escape, not progress made *inside* the
 * cycle, and is not credited. This is the non-obvious correctness condition:
 * escapes don't redeem a livelock.
 *
 * `sccs` is expected to come from {@link findStronglyConnectedComponents} over
 * the same `graph`.
 *
 * @param args.graph - The labeled state graph (as built by `exploreFrontiersRaw`).
 * @param args.sccs - Strongly connected components of `graph`.
 * @param args.progress - Event types that count as progress (the specification).
 * @returns One {@link LivelockFinding} per cycle that never selects a progress event.
 *
 * @public
 */
const findLivelocks = ({
  graph,
  sccs,
  progress,
}: {
  graph: Map<string, StateNode>
  sccs: string[][]
  progress: string[]
}): LivelockFinding[] => {
  const findings: LivelockFinding[] = []
  for (const scc of sccs) {
    if (!isCycle(scc, graph)) continue
    const stateKeys = new Set<string>(scc)
    const cycleEventTypes = new Set<string>()
    for (const stateKey of scc) {
      const node = graph.get(stateKey)!
      for (const edge of node.successors) {
        if (stateKeys.has(edge.to)) {
          cycleEventTypes.add(edge.selection.type)
        }
      }
    }
    const makesProgress = [...cycleEventTypes].some((t) => progress.includes(t))
    if (!makesProgress) {
      findings.push({
        code: 'livelock',
        states: [...scc],
        progressTypes: [...progress],
      })
    }
  }
  return findings
}

/**
 * Arguments for {@link exploreFrontiersRaw} and {@link verifyFrontiersRaw}.
 *
 * @public
 */
type ExploreFrontiersArgs = {
  /** Thread tuples to analyze. */
  threads: Thread[]
  /** Prior trace prefix to replay before exploring. */
  messages?: Trace[]
  /** External trigger events that may wake pending threads. */
  triggers?: BPEvent[]
  /** Exploration strategy: `'bfs'` (breadth-first) or `'dfs'` (depth-first). Default: `'bfs'`. */
  strategy?: 'bfs' | 'dfs'
  /** How to select among enabled candidates: `'all-enabled'` (all branches) or `'scheduler'` (priority order, one at a time). Default: `'all-enabled'`. */
  selectionPolicy?: 'all-enabled' | 'scheduler'
  /** Maximum selection depth before truncating exploration. */
  maxDepth?: number
  /** Umwelt stamp applied to all thread rules. */
  umwelt?: string
  /** Instance id stamped on synthetic traces. Defaults to a minted `bp_` UUIDv7 — pass the analyzed kernel's id to make joins natural. */
  instanceId?: string
  /** Host session id stamped on synthetic traces alongside `instanceId`. Defaults to the `instanceId` — the faculty never mints one. */
  sessionId?: string
}

/**
 * Result of an {@link exploreFrontiersRaw} call.
 *
 * @public
 */
type ExploreFrontiersResult = {
  traces: TraceRecord[]
  findings: DeadlockFinding[]
  report: {
    strategy: 'bfs' | 'dfs'
    selectionPolicy: 'all-enabled' | 'scheduler'
    visitedCount: number
    findingCount: number
    truncated: boolean
    maxDepth?: number
  }
  stateGraph: Map<string, StateNode>
}

type WorkItem = {
  messages: Trace[] // what you already push
  from?: string // stateKey of the state this item was pushed FROM
  via?: CandidateBid // the selection that was appended to get here
}

/**
 * Explores reachable frontiers from an initial trace prefix, collecting
 * traces and deadlock findings.
 *
 * @param args - {@link ExploreFrontiersArgs}
 * @returns {@link ExploreFrontiersResult}
 *
 * @public
 */
const exploreFrontiersRaw = ({
  threads,
  messages = [],
  triggers = [],
  strategy = 'bfs',
  selectionPolicy = 'all-enabled',
  maxDepth,
  umwelt,
  instanceId = uuid('bp_'),
  sessionId,
}: ExploreFrontiersArgs): ExploreFrontiersResult => {
  if (strategy !== 'bfs' && strategy !== 'dfs') {
    throw new Error(`Unsupported frontier exploration strategy "${String(strategy)}".`)
  }

  const resolvedSessionId = sessionId ?? instanceId

  const pending: WorkItem[] = [{ messages }]
  const visited = new Set<string>()
  const stateGraph = new Map<string, StateNode>()
  const traces: TraceRecord[] = []
  const findings: DeadlockFinding[] = []
  let truncated = false

  while (pending.length > 0) {
    const current = strategy === 'bfs' ? pending.shift()! : pending.pop()!
    const { frontier, pending: currentPending } = replayToFrontierRaw({
      threads,
      messages: current.messages,
      umwelt,
      instanceId,
      sessionId: resolvedSessionId,
    })

    const stateKey = frontierStateKey({ pending: currentPending })

    if (current.from !== undefined && current.via !== undefined) {
      const parent = stateGraph.get(current.from)
      if (parent) {
        parent.successors.push({ selection: current.via, to: stateKey })
      }
    }

    if (visited.has(stateKey)) continue
    visited.add(stateKey)
    const step = countSelectionTraces({ messages: current.messages })

    stateGraph.set(stateKey, {
      stateKey,
      frontier,
      step,
      successors: [],
    })

    const frontierTrace = createFrontierTrace({ frontier, step, instanceId, sessionId: resolvedSessionId })

    traces.push({
      messages: [...current.messages, frontierTrace],
    })

    const requestSuccessors = getRequestSuccessors({
      frontier,
      selectionPolicy,
      step,
      instanceId,
      sessionId: resolvedSessionId,
    })
    const triggerSuccessors = getTriggerSuccessors({
      pending: currentPending,
      messages: current.messages,
      threads,
      step,
      triggers,
      umwelt,
      instanceId,
      sessionId: resolvedSessionId,
    })
    const successors = [...requestSuccessors, ...triggerSuccessors]

    if (frontier.status === FRONTIER_STATUS.deadlock && triggerSuccessors.length === 0) {
      findings.push({
        code: 'deadlock',
        messages: [
          ...current.messages,
          frontierTrace,
          createDeadlockTrace({ step, instanceId, sessionId: resolvedSessionId }),
        ],
      })
    }

    if (maxDepth !== undefined && step >= maxDepth) {
      if (successors.length > 0) {
        truncated = true
      }
      continue
    }

    for (const successor of successors) {
      pending.push({
        messages: [...current.messages, successor],
        from: stateKey,
        via: successor.selected,
      })
    }
  }

  return {
    traces,
    findings,
    report: {
      strategy,
      selectionPolicy,
      visitedCount: traces.length,
      findingCount: findings.length,
      truncated,
      ...(maxDepth === undefined ? {} : { maxDepth }),
    },
    stateGraph,
  }
}

/**
 * Result of a {@link verifyFrontiersRaw} call.
 *
 * @public
 */
type VerifyFrontiersResult = {
  status: 'verified' | 'failed' | 'truncated'
  findings: DeadlockFinding[]
  report: ExploreFrontiersResult['report']
  livelocks: LivelockFinding[]
}

type VerifyFrontiersArgs = ExploreFrontiersArgs & { progress?: string[] }

/**
 * Verifies a thread set by exploring its frontiers and deriving a
 * pass/fail/truncated status.
 *
 * @param args - {@link ExploreFrontiersArgs}
 * @returns {@link VerifyFrontiersResult}
 *
 * @public
 */
const verifyFrontiersRaw = ({ progress, ...args }: VerifyFrontiersArgs): VerifyFrontiersResult => {
  const { findings, report, stateGraph } = exploreFrontiersRaw(args)
  const livelocks: LivelockFinding[] = []
  if (progress !== undefined) {
    livelocks.push(
      ...findLivelocks({
        progress,
        graph: stateGraph,
        sccs: findStronglyConnectedComponents(stateGraph),
      }),
    )
  }
  if (findings.length > 0 || livelocks.length > 0) {
    return {
      status: 'failed',
      findings,
      report,
      livelocks,
    }
  }

  if (report.truncated) {
    return {
      status: 'truncated',
      findings,
      report,
      livelocks,
    }
  }

  return {
    status: 'verified',
    findings,
    report,
    livelocks,
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Input boundary — the three operations' input schemas (moved from the
// fleet wrapper; the worker compiles them and validates `detail.input` here)
// ---------------------------------------------------------------------------
// threads — the serialized authored-thread shape, derived from the ONE
// schema home in behavioral.types.ts (SerializedThreadSchema — rules as
// plain JSON vs idiom tuples; the engine's ThreadSchema gate re-validates
// at add_thread). No hand-mirrored thread shape.
const threadsJsonSchema = {
  type: 'array',
  items: SerializedThreadSchema,
} as const

// messages — a selection-trace prefix. Validated as array-of-object; the
// runtime discriminates by `kind` and reads `selected`. CandidateBid's
// `ingress?: true` literal exceeds JSONSchemaType's static power.
const messagesJsonSchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
  description: 'selection-trace prefix: { kind: "selection", timestamp, instanceId, step, selected: CandidateBid }[]',
} as const

export type FrontierReplayInput = {
  threads: Thread[]
  messages?: SelectionTrace[]
  umwelt?: string
  instanceId?: string
  sessionId?: string
}

export type FrontierReplayOutput = {
  frontier: Frontier | null
  stateKey: string | null
  pendingCount: number | null
  isError?: boolean
  message?: string
}

export const FrontierReplayInputSchema = {
  type: 'object',
  properties: {
    threads: threadsJsonSchema,
    messages: { ...messagesJsonSchema, nullable: true },
    umwelt: { type: 'string', nullable: true, description: 'umwelt stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted bp_ UUID v7',
    },
    sessionId: {
      type: 'string',
      nullable: true,
      description: 'host session id stamped on synthetic traces; defaults to the instanceId',
    },
  },
  required: ['threads'],
  additionalProperties: false,
  description: 'Replay one concrete event-selection trace against a thread set and return the resulting frontier.',
} as unknown as JSONSchemaType<FrontierReplayInput>

/**
 * Replay one concrete event-selection trace and return the resulting frontier.
 *
 * Wraps the raw replay: the pending `Set` (with generator closures) is
 * serialized to `stateKey` (canonical) + `pendingCount`; the frontier crosses
 * verbatim. If a selection was not enabled at its replay step the raw fn
 * throws — the tool catches it and returns `{ isError: true, message }` so the
 * throw never crosses the model channel.
 */

// Serialized reachable state in the explored graph. StateNode (module-private)
// has the identical shape; this is the JSON-public mirror so consumers don't
// depend on an internal type. StateNode fields are JSON-safe (stateKey, the
// frontier, step, and successor edges labeled by CandidateBid — no generator
// or compiled validator).
export type FrontierStateNode = {
  stateKey: string
  frontier: Frontier
  step: number
  successors: Array<{ selection: CandidateBid; to: string }>
}

// Exploration report — shared by the frontier-explore and frontier-verify
// outputs.
export type FrontierReport = {
  strategy: 'bfs' | 'dfs'
  selectionPolicy: 'all-enabled' | 'scheduler'
  visitedCount: number
  findingCount: number
  truncated: boolean
  maxDepth?: number
}

// Serialize the internal Map<string, StateNode> to a plain object keyed by
// stateKey for JSON output. Object.fromEntries preserves Map insertion order
// (root first), so the step-0 state is Object.values(graph)[0].
const serializeStateGraph = (graph: Map<string, StateNode>): Record<string, FrontierStateNode> =>
  Object.fromEntries(graph)

export type FrontierExploreInput = {
  threads: Thread[]
  messages?: SelectionTrace[]
  triggers?: BPEvent[]
  strategy?: 'bfs' | 'dfs'
  selectionPolicy?: 'all-enabled' | 'scheduler'
  maxDepth: number
  umwelt?: string
  instanceId?: string
  sessionId?: string
}

export type FrontierExploreOutput = {
  traces: Array<{ messages: Trace[] }>
  findings: Array<{ code: 'deadlock'; messages: Trace[] }>
  report: FrontierReport
  stateGraph: Record<string, FrontierStateNode>
  isError?: boolean
  message?: string
}

export const FrontierExploreInputSchema = {
  type: 'object',
  properties: {
    threads: threadsJsonSchema,
    messages: { ...messagesJsonSchema, nullable: true },
    triggers: {
      type: 'array',
      items: BPEventSchema,
      nullable: true,
      description: 'external trigger events that may wake pending threads',
    },
    strategy: {
      type: 'string',
      enum: ['bfs', 'dfs'],
      nullable: true,
      default: 'bfs',
      description: "exploration strategy: 'bfs' (breadth-first) or 'dfs' (depth-first). Default 'bfs'.",
    },
    selectionPolicy: {
      type: 'string',
      enum: ['all-enabled', 'scheduler'],
      nullable: true,
      default: 'all-enabled',
      description:
        "'all-enabled' branches on every enabled candidate; 'scheduler' takes only the highest-priority one. Default 'all-enabled'.",
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      description:
        'Required. Maximum selection depth. Finite-state programs close their state graph and terminate before this; unbounded-state programs (e.g. a counter whose detail grows each loop) never close — maxDepth bounds them and sets report.truncated when it cuts off. Never treat truncated as a pass.',
    },
    umwelt: { type: 'string', nullable: true, description: 'umwelt stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted bp_ UUID v7',
    },
    sessionId: {
      type: 'string',
      nullable: true,
      description: 'host session id stamped on synthetic traces; defaults to the instanceId',
    },
  },
  required: ['threads', 'maxDepth'],
  additionalProperties: false,
  description:
    'Enumerate every reachable frontier of a thread set, collecting traces, deadlock findings, and the labeled state graph (serialized to a plain object keyed by stateKey).',
} as unknown as JSONSchemaType<FrontierExploreInput>

/**
 * Enumerate every reachable frontier of a thread set.
 *
 * Wraps the raw explorer: the internal `Map<string, StateNode>` is serialized
 * to a plain object keyed by stateKey; traces, findings, and report cross
 * verbatim (all JSON-safe). State-keyed deduplication means finite-state
 * looping programs terminate without relying on maxDepth. Any throw (an
 * unsupported strategy slipping past the enum, etc.) is caught into
 * `{ isError, message }` with empty structural defaults.
 */

export type FrontierVerifyInput = {
  threads: Thread[]
  messages?: SelectionTrace[]
  triggers?: BPEvent[]
  strategy?: 'bfs' | 'dfs'
  selectionPolicy?: 'all-enabled' | 'scheduler'
  maxDepth: number
  progress?: string[]
  umwelt?: string
  instanceId?: string
  sessionId?: string
}

export type FrontierVerifyOutput = {
  status: 'verified' | 'failed' | 'truncated'
  findings: Array<{ code: 'deadlock'; messages: Trace[] }>
  report: FrontierReport
  livelocks: Array<{ code: 'livelock'; states: string[]; progressTypes: string[] }>
  isError?: boolean
  message?: string
}

export const FrontierVerifyInputSchema = {
  type: 'object',
  properties: {
    threads: threadsJsonSchema,
    messages: { ...messagesJsonSchema, nullable: true },
    triggers: {
      type: 'array',
      items: BPEventSchema,
      nullable: true,
      description: 'external trigger events that may wake pending threads',
    },
    strategy: {
      type: 'string',
      enum: ['bfs', 'dfs'],
      nullable: true,
      default: 'bfs',
      description: "exploration strategy: 'bfs' (breadth-first) or 'dfs' (depth-first). Default 'bfs'.",
    },
    selectionPolicy: {
      type: 'string',
      enum: ['all-enabled', 'scheduler'],
      nullable: true,
      default: 'all-enabled',
      description:
        "'all-enabled' branches on every enabled candidate; 'scheduler' takes only the highest-priority one. Default 'all-enabled'.",
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      description:
        'Required. Maximum selection depth. Finite-state programs close their state graph and terminate before this; unbounded-state programs never close — maxDepth bounds them and yields status "truncated" when it cuts off. Never treat truncated as a pass.',
    },
    progress: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description:
        'Event types that count as progress. When provided, a reachable cycle that never selects a progress event is a livelock (status "failed"). Omit to skip livelock detection (deadlock-only). An empty array flags every cycle as a livelock.',
    },
    umwelt: { type: 'string', nullable: true, description: 'umwelt stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted bp_ UUID v7',
    },
    sessionId: {
      type: 'string',
      nullable: true,
      description: 'host session id stamped on synthetic traces; defaults to the instanceId',
    },
  },
  required: ['threads', 'maxDepth'],
  additionalProperties: false,
  description:
    'Verify a thread set: explore every reachable frontier and derive a verified/failed/truncated status. With the progress spec, also detects livelocks (cycles that never select a progress event).',
} as unknown as JSONSchemaType<FrontierVerifyInput>

/**
 * Verify a thread set: explore every reachable frontier and derive a
 * pass/fail/truncated status.
 *
 * Wraps the raw verifier. The raw result — `{ status, findings, report,
 * livelocks }` — is already verdict-shaped and JSON-safe (no Set/Map/generator),
 * so it crosses the boundary verbatim. Any unexpected throw is caught into
 * `{ isError, message }` with a `failed` status (never throw into the model
 * channel).
 */

export type FrontierAddThreadInput = {
  /** The single proposed thread — validated against the engine's own ThreadSchema home. */
  thread: Thread
  /** The currently mounted thread set the proposal is analyzed against. Defaults to none. */
  threads?: Thread[]
  /** The current trace state — a selection-trace prefix the analysis replays. Defaults to none. */
  messages?: SelectionTrace[]
  maxDepth: number
  progress?: string[]
  umwelt?: string
  instanceId?: string
  sessionId?: string
}

export type FrontierAddThreadOutput = {
  /** The verdict: true iff the proposal verified. The op does NOT admit — the composition owns the write. */
  ok: boolean
  /** The proposed thread, echoed verbatim. */
  thread: Thread
  status: 'verified' | 'failed' | 'truncated'
  findings: FrontierVerifyOutput['findings']
  livelocks: FrontierVerifyOutput['livelocks']
  report: FrontierReport
  isError?: boolean
  message?: string
}

export const FrontierAddThreadInputSchema = {
  type: 'object',
  properties: {
    thread: ThreadSchema,
    threads: {
      ...threadsJsonSchema,
      nullable: true,
      description: 'the currently mounted thread set to analyze against',
    },
    messages: { ...messagesJsonSchema, nullable: true },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      description:
        'Required. Exploration bound. Finite-state programs close their state graph and terminate before this. Never treat truncated as a pass.',
    },
    progress: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: 'Event types that count as progress; cycles never selecting one are livelocks (status "failed").',
    },
    umwelt: { type: 'string', nullable: true, description: 'umwelt stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted bp_ UUID v7',
    },
    sessionId: {
      type: 'string',
      nullable: true,
      description: 'host session id stamped on synthetic traces; defaults to the instanceId',
    },
  },
  required: ['thread', 'maxDepth'],
  additionalProperties: false,
  description:
    'Validate a proposed thread for admission: schema-check the thread tuple (the engine ThreadSchema home), then structurally verify the proposal against the current thread set + trace state. Returns the verdict + analysis findings; does NOT admit — the composition owns the write.',
} as unknown as JSONSchemaType<FrontierAddThreadInput>

/**
 * Validate a proposed thread for admission — the structural layer of dynamic
 * thread addition.
 *
 * The `thread` tuple is schema-checked against the engine's own ThreadSchema
 * (derived, not mirrored); then `verifyFrontiersRaw` analyzes the proposal
 * joined to the current thread set over the trace prefix. The result is the
 * verdict + findings as data — the frontier stays analysis-shaped and never
 * writes to the engine; the composition admits on `ok`.
 */

// ---------------------------------------------------------------------------
// Event dispatch — the wire surface
// ---------------------------------------------------------------------------

const validateReplayInput = ajv.compile(FrontierReplayInputSchema)
const validateExploreInput = ajv.compile(FrontierExploreInputSchema)
const validateVerifyInput = ajv.compile(FrontierVerifyInputSchema)
const validateAddThreadInput = ajv.compile(FrontierAddThreadInputSchema)

type ToolRunner = {
  validate: (input: unknown) => boolean
  errors: () => string | null
  run: (input: never) => unknown
}

const OP_RUNNERS: Record<string, ToolRunner> = {
  replay: {
    validate: validateReplayInput,
    errors: () => ajv.errorsText(validateReplayInput.errors),
    run: ({ threads, messages, umwelt, instanceId, sessionId }: FrontierReplayInput): FrontierReplayOutput => {
      try {
        const { pending, frontier } = replayToFrontierRaw({ threads, messages, umwelt, instanceId, sessionId })
        return { frontier, stateKey: frontierStateKey({ pending }), pendingCount: pending.size }
      } catch (err) {
        return {
          frontier: null,
          stateKey: null,
          pendingCount: null,
          isError: true,
          message: (err as Error).message,
        }
      }
    },
  },
  explore: {
    validate: validateExploreInput,
    errors: () => ajv.errorsText(validateExploreInput.errors),
    run: ({
      threads,
      messages,
      triggers,
      strategy,
      selectionPolicy,
      maxDepth,
      umwelt,
      instanceId,
      sessionId,
    }: FrontierExploreInput): FrontierExploreOutput => {
      try {
        const { traces, findings, report, stateGraph } = exploreFrontiersRaw({
          threads,
          messages,
          triggers,
          strategy,
          selectionPolicy,
          maxDepth,
          umwelt,
          instanceId,
          sessionId,
        })
        return { traces, findings, report, stateGraph: serializeStateGraph(stateGraph) }
      } catch (err) {
        return {
          traces: [],
          findings: [],
          report: {
            strategy: strategy ?? 'bfs',
            selectionPolicy: selectionPolicy ?? 'all-enabled',
            visitedCount: 0,
            findingCount: 0,
            truncated: false,
            maxDepth,
          },
          stateGraph: {},
          isError: true,
          message: (err as Error).message,
        }
      }
    },
  },
  verify: {
    validate: validateVerifyInput,
    errors: () => ajv.errorsText(validateVerifyInput.errors),
    run: ({
      threads,
      messages,
      triggers,
      strategy,
      selectionPolicy,
      maxDepth,
      progress,
      umwelt,
      instanceId,
      sessionId,
    }: FrontierVerifyInput): FrontierVerifyOutput => {
      try {
        const { status, findings, report, livelocks } = verifyFrontiersRaw({
          threads,
          messages,
          triggers,
          strategy,
          selectionPolicy,
          maxDepth,
          progress,
          umwelt,
          instanceId,
          sessionId,
        })
        return { status, findings, report, livelocks }
      } catch (err) {
        return {
          status: 'failed' as const,
          findings: [],
          report: {
            strategy: strategy ?? 'bfs',
            selectionPolicy: selectionPolicy ?? 'all-enabled',
            visitedCount: 0,
            findingCount: 0,
            truncated: false,
            maxDepth,
          },
          livelocks: [],
          isError: true,
          message: (err as Error).message,
        }
      }
    },
  },
  add_thread: {
    validate: validateAddThreadInput,
    errors: () => ajv.errorsText(validateAddThreadInput.errors),
    run: ({
      thread,
      threads,
      messages,
      maxDepth,
      progress,
      umwelt,
      instanceId,
      sessionId,
    }: FrontierAddThreadInput): FrontierAddThreadOutput => {
      try {
        const { status, findings, report, livelocks } = verifyFrontiersRaw({
          threads: [...(threads ?? []), thread],
          messages,
          maxDepth,
          progress,
          umwelt,
          instanceId,
          sessionId,
        })
        return { ok: status === 'verified', thread, status, findings, report, livelocks }
      } catch (err) {
        return {
          ok: false,
          thread,
          status: 'failed' as const,
          findings: [],
          report: {
            strategy: 'bfs' as const,
            selectionPolicy: 'all-enabled' as const,
            visitedCount: 0,
            findingCount: 0,
            truncated: false,
            maxDepth,
          },
          livelocks: [],
          isError: true,
          message: (err as Error).message,
        }
      }
    },
  },
}

// The per-op input validation lives in the runners (invalid input is error
// DATA through the same result shape, per op) — the bootstrap's input
// boundary mirrors the wire home's detail contract: the op enum and a loose
// input object.
type FrontierAnalysisRequestDetail = { op: FrontierAnalysisOp; input: JsonObject }

const FrontierAnalysisRequestDetailSchema: JSONSchemaType<FrontierAnalysisRequestDetail> = {
  type: 'object',
  properties: {
    // Mirrors the wire home's FrontierAnalysisRequestEventSchema.detail (op enum +
    // loose input) — per-op input validity is the runners' (error data).
    // `id` (and any bootstrap bookkeeping) rides along: additionalProperties
    // stays open — the wire home's event validator is the strict boundary.
    op: { type: 'string', enum: ['replay', 'explore', 'verify', 'add_thread'] },
    input: { type: 'object', required: [], additionalProperties: true },
  },
  required: ['op', 'input'],
  additionalProperties: true,
}

const frontierAnalysisRespond: FacultyRespond<FrontierAnalysisRequestDetail> = async (detail) => {
  const runner = OP_RUNNERS[detail.op]
  if (runner === undefined) return { isError: true, message: `unknown frontier operation: ${detail.op}` }
  if (!runner.validate(detail.input)) return { isError: true, message: `invalid input: ${runner.errors()}` }
  // The raw analysis functions throw; every throw is caught and returned as
  // { isError, message } data, so a throw never crosses the worker boundary.
  return runner.run(detail.input as never)
}

// The worker entry: wire only inside a worker global (an in-process import
// wires nothing). Analyses are synchronous — no cancel contract (the
// bootstrap's cancel routing stays unwired) and no in-flight timeout
// (timeoutMs 0): a long analysis answers when it answers, never a
// fabricated timeout.
export const wiring = createWorker<FrontierAnalysisRequestDetail>({
  respond: frontierAnalysisRespond,
  validateRequest: validateFrontierAnalysisRequestEvent,
  validateInput: ajv.compile(FrontierAnalysisRequestDetailSchema),
  resultKind: FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
  timeoutMs: 0,
})
