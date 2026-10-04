// TEMPORARY reverse import on dying code (the transform-faculty ruling): the
// evaluation types moved to the wire home; this bridge and its import die
// together at the engine switch (slice 2).
import { type TransformEvaluation, validateTransformEvaluation } from '../faculties/faculties.types.ts'
import { deepEqual } from '../utils.ts'
import { FRONTIER_STATUS, IDIOMS, TRACE_MESSAGE_KINDS } from './behavioral.constants.ts'
import type {
  BPEvent,
  CandidateBid,
  Frontier,
  Idioms,
  JsonObject,
  PendingBid,
  RegisteredBPListener,
  RegisteredIdioms,
  RegisteredTransformListener,
  RulesFunction,
  RunningBid,
  SendTrace,
  Transformer,
  UseThread,
} from './behavioral.types.ts'
import { ajv } from './behavioral.types.ts'

/**
 * @internal
 * Creates a checker function to determine if a given BPListener matches a CandidateBid.
 *
 * Space matching is ROOT AUTHORITY: an unstamped (root) listener matches
 * candidates in EVERY space — visibility flows UP only — while a
 * space-stamped listener stays confined to its own space, never matching
 * root events or siblings. A thread governing several spaces is admitted
 * (or wired) per space explicitly, each mount stamped.
 */
export const isListeningFor = ({ type, detail, space, ingress }: CandidateBid) => {
  return (listener: RegisteredBPListener | RegisteredTransformListener): boolean => {
    const spaceMatches = listener.space === undefined ? true : space === listener.space
    const schemaMatches = listener.detailSchema ? detailValidators.get(listener)!(detail) : true
    const detailMatches = listener.detailMatch === false ? !schemaMatches : schemaMatches
    const ingressMatches = listener.ingressMatch === undefined || listener.ingressMatch === (ingress === true)
    return listener.type === type && spaceMatches && detailMatches && ingressMatches
  }
}

/**
 * Compiles and caches an Ajv validator per registered listener's
 * `detailSchema` (WeakMap-keyed so looped threads recompile nothing).
 */
const detailValidators = new WeakMap<RegisteredBPListener | RegisteredTransformListener, (detail: unknown) => boolean>()

/** @internal — called from generateRulesFunctions when a listener is registered. */
const compileListenerValidator = (listener: RegisteredBPListener | RegisteredTransformListener): void => {
  if (listener.detailSchema && !detailValidators.has(listener)) {
    try {
      detailValidators.set(listener, ajv.compile(listener.detailSchema))
    } catch (error) {
      throw new Error(`un-compilable detailSchema for listener "${listener.type}": ${(error as Error).message}`)
    }
  }
}
/**
 * @internal
 * Computes the execution frontier from pending bids.
 *
 * The frontier captures:
 * - all requested candidates
 * - the subset enabled after applying block listeners
 * - a scheduler-facing status classification
 */
export const computeFrontier = (pending: Map<string, PendingBid>): Frontier => {
  const blocked: RegisteredBPListener[] = []
  const candidates: CandidateBid[] = []

  for (const { request, priority, block, ingress, space } of pending.values()) {
    block && blocked.push(...block)
    request &&
      candidates.push({
        priority,
        ingress,
        space,
        ...request,
      })
  }

  const enabled: CandidateBid[] = []
  const length = candidates.length
  for (let i = 0; i < length; i++) {
    const candidate = candidates[i]!
    if (!blocked.some(isListeningFor(candidate))) {
      enabled.push(candidate)
    }
  }

  if (enabled.length > 0) {
    return { candidates, enabled, status: FRONTIER_STATUS.ready }
  }
  if (candidates.length > 0) {
    return { candidates, enabled, status: FRONTIER_STATUS.deadlock }
  }
  return { candidates, enabled, status: FRONTIER_STATUS.idle }
}

export const advanceRunningToPending = (running: Map<string, RunningBid>, pending: Map<string, PendingBid>) => {
  for (const [key, bid] of running) {
    const { generator, priority, name, ingress, space, thread } = bid
    const { value, done } = generator.next()
    if (!done)
      pending.set(key, {
        priority,
        ingress,
        name,
        generator,
        space,
        key,
        ...(thread === undefined ? {} : { thread }),
        ...value,
      })
    running.delete(key)
  }
}

const eventMatchesCandidate = (request: BPEvent, selectedEvent: CandidateBid) => {
  if (selectedEvent.type !== request.type) return false
  if (selectedEvent.space && selectedEvent.space !== request.space) return false
  return deepEqual(request.detail, selectedEvent.detail)
}

export const resumePendingThreadsForSelectedEvent = ({
  running,
  pending,
  selectedEvent,
  sendTrace,
  instanceId,
  sessionId,
  step,
}: {
  running: Map<string, RunningBid>
  pending: Map<string, PendingBid>
  selectedEvent: CandidateBid
  sendTrace?: SendTrace
  instanceId: string
  sessionId: string
  step: number
}) => {
  const transformers: Transformer[] = []
  for (const bid of pending.values()) {
    const { waitFor, request, generator, interrupt, transform, name, key } = bid
    const isInterrupted = interrupt?.some(isListeningFor(selectedEvent))
    const isWaitedFor = waitFor?.some(isListeningFor(selectedEvent))
    const isTransform = transform?.flatMap((listener) =>
      isListeningFor(selectedEvent)(listener)
        ? // Direction/R: the target once-thread re-enters stamped with the
          // SOURCE event's space — the root transformer's output stays in
          // the space it observed. A stamped listener's space equals the
          // event's space anyway (stamped confinement).
          {
            target: listener.target,
            query: listener.query,
            thread: name,
            space: listener.space ?? selectedEvent.space,
          }
        : [],
    )
    const hasPendingRequest = request && eventMatchesCandidate(request, selectedEvent)
    if (isInterrupted) {
      generator.return?.()
      pending.delete(key)
      sendTrace?.({
        kind: TRACE_MESSAGE_KINDS.interrupt,
        timestamp: Date.now(),
        step,
        instanceId,
        sessionId,
        selected: selectedEvent,
        threadLabel: name,
      })
      continue
    }
    if (hasPendingRequest || isWaitedFor || isTransform?.length) {
      running.set(key, { ...bid })
      pending.delete(key)
    }
    if (isTransform?.length) {
      transformers.push(...isTransform)
    }
  }
  return transformers
}

export const generateRulesFunctions = (rules: Idioms[], space?: string): RulesFunction[] => {
  const syncs: RulesFunction[] = []
  for (const { request, waitFor, block, interrupt, transform } of rules) {
    const registeredIdioms: RegisteredIdioms = {}
    if (request) {
      registeredIdioms[IDIOMS.request] = {
        type: request.type,
        space,
        detail: request.detail,
      }
    }
    if (block) {
      registeredIdioms[IDIOMS.block] = block.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    if (waitFor) {
      registeredIdioms[IDIOMS.waitFor] = waitFor.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    if (interrupt) {
      registeredIdioms[IDIOMS.interrupt] = interrupt.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    if (transform) {
      registeredIdioms[IDIOMS.transform] = transform.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    syncs.push(function* () {
      yield registeredIdioms
    })
  }
  return syncs
}

/**
 * Composes an ordered array of rule generators into a single behavioral thread generator.
 *
 * @param rules - Rule generators (each yielding one `RegisteredIdioms`) to compose.
 * @param once - When `true`, the thread runs through the rules once and completes.
 *               When omitted, the thread loops the rules indefinitely.
 * @returns A generator function yielding the idioms from each rule in sequence.
 *
 * @remarks
 * - The `once` flag controls repetition semantics for the behavioral scheduler.
 * - Empty rule arrays complete immediately (the generator is `done` on first call).
 *
 * @see {@link generateRulesFunctions} for building the rule array from author-facing `Idioms`.
 */
export const useThread: UseThread = (rules: RulesFunction[], once?: true) =>
  once
    ? function* () {
        const length = rules.length
        for (let i = 0; i < length; i++) {
          yield* rules[i]!()
        }
      }
    : function* () {
        while (true) {
          const length = rules.length
          for (let i = 0; i < length; i++) {
            yield* rules[i]!()
          }
        }
      }

const JQ_STARTUP_TIMEOUT_MS = 30_000
const JQ_EVAL_TIMEOUT_MS = 1000
const JQ_RESULT_CAP = 64 * 1024
const jqResultDecoder = new TextDecoder()

// The warm pool of one. The worker and its shared buffer persist across
// evaluations, so a transform pays worker boot + jq.wasm compile once per
// process, not per eval. The worker is `unref`'d — it must never hold the
// host process open (the runtime is `bun run`, which blocks on a live
// worker). A timeout terminates the worker and the pool respawns lazily on
// the next evaluation.
/** The jq pool's worker — the DOM `Worker` plus Bun's optional `unref`. */
type PoolWorker = Worker & { unref?: () => void }
let jqWorker: PoolWorker | undefined
let jqBuffer: SharedArrayBuffer | undefined
let jqHeader: Int32Array | undefined

/**
 * Whether the SAB bridge can exist in this host: a realm without
 * `SharedArrayBuffer` (not crossOriginIsolated — a non-COI browser worker or
 * an Android WebView) can neither construct the shared buffer nor park in
 * `Atomics.wait` against it. The pool stays down there and
 * `evaluateTransform` degrades to `jq_unavailable` errors-as-data — a
 * visible transform_error, never a crashed worker.
 */
const jqBridgeAvailable = (): boolean => typeof SharedArrayBuffer !== 'undefined'

const spawnJqWorker = () => {
  jqBuffer = new SharedArrayBuffer(8 + JQ_RESULT_CAP)
  jqHeader = new Int32Array(jqBuffer, 0, 2)
  // The jq worker is CLASSIC-safe (no top-level await — a nested module
  // worker fails silently in the WebView's Chromium); only `unref` is
  // Bun-shaped (a browser worker holds nothing open), hence the optional
  // call on the structural `PoolWorker` type.
  const worker = new Worker(new URL('./jq.worker.ts', import.meta.url)) as PoolWorker
  worker.unref?.()
  jqWorker = worker
}

const timeoutJqWorker = (): TransformEvaluation => {
  jqWorker?.terminate()
  jqWorker = undefined
  jqBuffer = undefined
  jqHeader = undefined
  // Respawn deferred to a task turn: a fresh nested worker's boot window
  // (~10-50ms in the WebView's Chromium) must pass while THIS worker's event
  // loop is alive, or the first postMessage never reaches the nested worker
  // (the nested-boot deadlock finding). MINIMAL: two evaluateTransform calls
  // inside ONE task after a timeout still spawn-park inside the boot window —
  // the startup budget degrades that to a 30s timeout, not a hang; the
  // upgrade is a ready-handshake + async bridge.
  setTimeout(spawnJqWorker, 0)
  return { ok: false, reason: 'jq_timeout' }
}

/**
 * The jq eval bridge — drives the persistent `jq.worker.ts` pool and blocks the
 * calling thread on `Atomics.wait` (a synchronous syscall, not an async yield —
 * the engine-never-awaits invariant holds). The result travels through the
 * shared buffer, never postMessage: a caller parked in `Atomics.wait` has a
 * frozen event loop and could not receive a message. Two waits bound the call:
 * a startup budget covers worker boot + wasm compile (status 0 → 1), then the
 * eval timeout covers evaluation (status 1 → 2). A never-terminating query is
 * killed by `terminate()` at the eval timeout — the only interrupt primitive
 * that exists for a spinning wasm program — and becomes `jq_timeout`
 * errors-as-data, like every other transform failure.
 */
export const evaluateTransform = (query: string, detail: JsonObject | undefined): TransformEvaluation => {
  if (detail === undefined || detail === null) return { ok: false, reason: 'no_detail' }
  if (!jqBridgeAvailable()) return { ok: false, reason: 'jq_unavailable' }
  if (!jqWorker) spawnJqWorker()
  const worker = jqWorker!
  const sab = jqBuffer!
  const header = jqHeader!
  Atomics.store(header, 0, 0) // idle — reset the slot for this round
  worker.postMessage({ sab, query, detail })
  // Boot + compile — a generous budget so a slow CI runner is not a jq timeout.
  if (Atomics.load(header, 0) === 0) {
    const booted = Atomics.wait(header, 0, 0, JQ_STARTUP_TIMEOUT_MS)
    if (booted === 'timed-out') return timeoutJqWorker()
  }
  // Evaluation — the query itself is bounded here.
  if (Atomics.load(header, 0) === 1) {
    const evaluated = Atomics.wait(header, 0, 1, JQ_EVAL_TIMEOUT_MS)
    if (evaluated === 'timed-out') return timeoutJqWorker()
  }
  const bytes = new Uint8Array(sab, 8, Atomics.load(header, 1))
  try {
    // JSON.parse proves syntax; validateTransformEvaluation proves shape —
    // the two-guards pattern at the worker trust boundary.
    const evaluation: unknown = JSON.parse(jqResultDecoder.decode(bytes))
    if (!validateTransformEvaluation(evaluation)) {
      return { ok: false, reason: 'jq_error', stderr: 'invalid evaluation frame from jq worker' }
    }
    return evaluation
  } catch (err) {
    return { ok: false, reason: 'jq_error', stderr: err instanceof Error ? err.message : String(err) }
  }
}
