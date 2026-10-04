import { deepEqual } from '../utils.ts'
import { FRONTIER_STATUS, IDIOMS, TRACE_MESSAGE_KINDS } from './behavioral.constants.ts'
import type {
  BPEvent,
  CandidateBid,
  Frontier,
  Idioms,
  PendingBid,
  RegisteredBPListener,
  RegisteredIdioms,
  RegisteredTransformListener,
  RulesFunction,
  RunningBid,
  SendTrace,
  TransformContract,
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
  const transformers: TransformContract[] = []
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
