import { uuid } from '../utils/uuid.ts'
import { FRONTIER_STATUS, TRACE_MESSAGE_KINDS } from './behavioral.constants.ts'
import {
  type AddThread,
  type CandidateBid,
  type PendingBid,
  type RemoveThread,
  type RunningBid,
  type SendTrace,
  type Thread,
  type Trace,
  type Trigger,
  type UseTrace,
  validateBPEvent,
  validateThread,
} from './behavioral.types.ts'
import {
  advanceRunningToPending,
  computeFrontier,
  evaluateTransform,
  generateRulesFunctions,
  resumePendingThreadsForSelectedEvent,
  useThread,
} from './behavioral.utils.ts'

const createSubject = (): SendTrace => {
  const listeners = new Set<(value: Trace) => void | Promise<void>>()
  function publisher(value: Trace) {
    for (const cb of listeners) {
      try {
        // Promise.resolve passes native promises through unchanged and absorbs
        // non-native thenables, so every listener return value gets a rejection
        // handler without awaiting or yielding the event loop.
        void Promise.resolve(cb(value)).catch((error) =>
          console.error('[behavioral] trace listener rejected:', value.kind, error),
        )
      } catch (error) {
        console.error('[behavioral] trace listener threw:', value.kind, error)
      }
    }
  }
  publisher.subscribe = (listener: (msg: Trace) => void | Promise<void>) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return publisher
}

/**
 * Creates and manages a behavioral program instance, orchestrating the execution of b-threads.
 * This function implements the core logic of the Behavioral Programming execution model (super-steps).
 *
 * The behavioral program is the central coordination mechanism that manages a collection of
 * behavioral threads (b-threads) and orchestrates their synchronized execution according to
 * the BP paradigm. It maintains the state of all active threads, processes their synchronization
 * statements, selects events, and handles the publication of events to external subscribers.
 *
 * @template Details - Type map for event payloads, mapping event types to detail payload types.
 * @returns Immutable API for interacting with the behavioral program.
 *
 * @remarks
 * The execution follows these general steps (super-step):
 *
 * 1. **Run Active Threads:** Advance all threads currently in the 'running' state to their next `yield`.
 *    This is where threads actually execute their code until they reach a synchronization point.
 *
 * 2. **Collect Bids:** Gather `request`, `waitFor`, and `block` declarations (`Idioms`) from all
 *    threads now in the 'pending' state. These declarations represent what each thread wants to
 *    do next.
 *
 * 3. **Select Event:** Identify candidate events (from `request` declarations). Filter out any
 *    candidates blocked by `block` declarations. Select the highest priority candidate event
 *    among the remaining ones.
 *
 * 4. **Notify & Update:**
 *    - If an event is selected:
 *      - Publish a trace if a listener is attached (for debugging/monitoring).
 *      - Identify threads waiting for, requesting, or interrupted by the selected event.
 *        Move these threads back to the 'running' state.
 *      - Publish the selected event via the `actionPublisher` (for `useFeedback` handlers).
 *      - Start the next super-step (`run()`).
 *    - If no event is selected (deadlock or program end), the execution halts until a new
 *      event is triggered externally.
 *
 * The program's execution is driven by events - either requested by threads or triggered
 * externally. It will continue executing super-steps as long as there are events to select
 * and threads to run. If no events can be selected (either because all requests are blocked
 * or there are no requests), the program will pause until an event is admitted via `trigger`.
 *
 * @param options - Optional factory options.
 * @param options.sessionId - Host-supplied session identity stamped on every
 *   trace alongside `instanceId`. The engine never mints or returns session
 *   ids — the host layer owns session identity policy.
 *   Defaults to the self-minted `instanceId` when omitted.
 *
 * **Channel invariant:** a selected event carries `ingress: true` iff it was admitted
 * externally through `trigger`; everything internal (dispatch-bridge results, transform
 * targets, `threads.registered`) arrives as a thread request added through `useAddThread`.
 * Re-entering code adds a `once` thread requesting the event, then starts the
 * super-step — engine-internal code (the transform executor) calls the internal
 * `step()` directly; `addThread` alone is inert. Listeners restrict themselves to a
 * channel with the optional `ingressMatch` flag (`true` = external only, `false` = internal only,
 * absent = either). `trigger` is therefore external admission plus one super-step,
 * nothing else.
 */
export const behavioral = (options?: { sessionId?: string }) => {
  // The trace-identity axis: a CSPRNG, monotonic (sortable) UUID v7.
  const instanceId = uuid('bp_')
  /** @internal Host session identity — accepted at factory time, never minted. */
  const sessionId = options?.sessionId ?? instanceId
  /**
   * @internal
   * Map of threads that have yielded and are waiting for event selection,
   * keyed by thread identity (the instance hash when the thread carries one —
   * removal-addressable — else an engine-minted uuid; all other mints
   * unchanged in behavior).
   *
   * Each entry is a PendingBid containing the thread's generator and yielded idioms.
   * These threads have reached a synchronization point and declared their behavioral intentions.
   */
  const pending = new Map<string, PendingBid>()

  /**
   * @internal
   * Map of threads whose generators are ready to run (or have just been triggered),
   * keyed by thread identity as {@link pending}.
   *
   * Each entry is a RunningBid containing the thread's generator.
   * These threads are about to execute until they yield at their next synchronization point.
   */
  const running = new Map<string, RunningBid>()

  /**
   * @internal
   * Staged host-authority removals — `removeThread` requests, applied at the
   * top of the next super-step (the addThread re-entry-law mirror). Each
   * stage captures the removed thread's generator (stable identity across
   * the running↔pending transitions) and its definition record (the
   * `thread_removed` payload). A target displaced by a same-identity remount
   * before the pump still traces — the old instance terminated.
   */
  const stagedRemovals = new Map<
    string,
    { instanceHash: number; generator: IterableIterator<unknown>; thread: Thread }
  >()

  const threadKey = (instanceHash?: number): string =>
    instanceHash === undefined ? `u:${uuid()}` : `i:${instanceHash}`

  /**
   * @internal
   * Publisher for state traces, consumed by `useTrace`.
   * Always exists — subscribers are added/removed via `useTrace` which delegates to `subscribe`.
   */
  const sendTrace = createSubject()
  let stepId = 0

  /**
   * @internal
   * Applies the staged removals — the interrupt teardown (generator.return +
   * bid delete) with host authority. A removed thread's blocks DIE with its
   * bid: the pending entry is gone before the frontier is computed, so the
   * previously blocked type becomes selectable in the same super-step.
   */
  const applyStagedRemovals = (): void => {
    for (const [key, staged] of stagedRemovals) {
      stagedRemovals.delete(key)
      for (const map of [running, pending]) {
        const bid = map.get(key)
        if (bid !== undefined && bid.generator === staged.generator) {
          map.delete(key)
          bid.generator.return?.()
        }
      }
      // Traced even when the target was displaced before the pump (the
      // identity was remounted): the old instance terminated either way, and
      // replay = thread_added minus thread_removed must not resurrect it.
      sendTrace({
        kind: TRACE_MESSAGE_KINDS.thread_removed,
        timestamp: Date.now(),
        instanceId,
        sessionId,
        thread: staged.thread,
        instanceHash: staged.instanceHash,
      })
    }
  }

  const step = (ingress?: true) => {
    applyStagedRemovals()
    if (running.size) {
      sendTrace?.({
        kind: TRACE_MESSAGE_KINDS.step,
        timestamp: Date.now(),
        step: stepId,
        ingress,
        instanceId,
        sessionId,
      })
      advanceRunningToPending(running, pending)
      selectNextEvent()
    }
  }

  /**
   * @internal
   * Executes the event selection part of the super-step.
   *
   * This function:
   * 1. Collects all block declarations from pending threads
   * 2. Collects all request declarations as candidate events
   * 3. Filters out candidates that are blocked
   * 4. Selects the highest priority remaining candidate
   * 5. If an event is selected, publishes a trace and proceeds to the next step
   * 6. If no event is selected, the super-step ends (program pauses until external trigger)
   */
  function selectNextEvent() {
    const step = stepId++

    sendTrace({
      kind: TRACE_MESSAGE_KINDS.pending_bids,
      timestamp: Date.now(),
      step,
      instanceId,
      sessionId,
      threads: [...pending.values()].map(({ generator: _gen, key: _key, thread: _thread, ...rest }) => rest),
    })

    const frontier = computeFrontier(pending)
    sendTrace({
      kind: TRACE_MESSAGE_KINDS.frontier,
      timestamp: Date.now(),
      step,
      instanceId,
      sessionId,
      ...frontier,
    })

    if (frontier.status === FRONTIER_STATUS.ready) {
      /** @internal Priority Queue BPEvent Selection Strategy */
      const selected = frontier.enabled.sort(
        ({ priority: priorityA }, { priority: priorityB }) => priorityA - priorityB,
      )[0]!
      nextStep(selected, step)
      return
    }
    if (frontier.status === FRONTIER_STATUS.deadlock) {
      sendTrace({
        kind: TRACE_MESSAGE_KINDS.deadlock,
        timestamp: Date.now(),
        step,
        instanceId,
        sessionId,
      })
    }
    if (frontier.status === FRONTIER_STATUS.idle) {
      sendTrace({
        kind: TRACE_MESSAGE_KINDS.idle,
        timestamp: Date.now(),
        step,
        instanceId,
        sessionId,
      })
    }
  }

  const addThread: AddThread = (args) => {
    const attemptedSpace = args?.space
    if (validateThread(args)) {
      const { name, description, rules, once, space, instanceHash } = args
      try {
        const syncPoints = generateRulesFunctions(rules, space)
        const thread = useThread(syncPoints, once)
        const key = threadKey(instanceHash)
        // Identity integrity: a live same-identity thread is never silently
        // replaced. The one sanctioned overwrite is a staged removal — the
        // composition's remove-then-remount wave (the removal's captured
        // generator distinguishes the doomed instance from the remount).
        if (instanceHash !== undefined && !stagedRemovals.has(key) && (running.has(key) || pending.has(key))) {
          sendTrace({
            kind: TRACE_MESSAGE_KINDS.add_thread_error,
            timestamp: Date.now(),
            instanceId,
            sessionId,
            error: [`duplicate thread identity: instance hash ${instanceHash} is already mounted`],
            space,
          })
          return
        }
        running.set(key, {
          priority: running.size + 1,
          generator: thread(),
          name,
          key,
          thread: args,
          ...(description === undefined ? {} : { description }),
        })
        // The provision record — after registration, so thread_added means
        // registered. Makes the trace log self-contained (replay = these
        // minus thread_removed + ingress events).
        sendTrace({
          kind: TRACE_MESSAGE_KINDS.thread_added,
          timestamp: Date.now(),
          instanceId,
          sessionId,
          thread: args,
        })
      } catch (err) {
        sendTrace({
          kind: TRACE_MESSAGE_KINDS.add_thread_error,
          timestamp: Date.now(),
          instanceId,
          sessionId,
          error: [err instanceof Error ? err.message : String(err)],
          space,
        })
      }
    } else {
      sendTrace({
        kind: TRACE_MESSAGE_KINDS.add_thread_error,
        timestamp: Date.now(),
        instanceId,
        sessionId,
        error: validateThread.errors ?? [],
        ...(typeof attemptedSpace === 'string' && { space: attemptedSpace }),
      })
    }
  }

  /**
   * @internal
   * Processes the selected event, updates thread states, and triggers the next cycle.
   *
   * This function:
   * 1. Identifies threads waiting for, requesting, or interrupted by the selected event
   * 2. Terminates threads that were interrupted
   * 3. Moves affected threads from 'pending' back to 'running' state
   * 4. Publishes the selected event to feedback handlers
   * 5. Initiates the next super-step
   *
   * @param selectedEvent - Event candidate selected for this step.
   */
  function nextStep(selectedEvent: CandidateBid, stepId: number) {
    const transformers = resumePendingThreadsForSelectedEvent({
      selectedEvent,
      running,
      pending,
      sendTrace,
      instanceId,
      sessionId,
      step: stepId,
    })
    if (transformers.length) {
      sendTrace?.({
        kind: TRACE_MESSAGE_KINDS.transform,
        timestamp: Date.now(),
        step: stepId,
        instanceId,
        sessionId,
        transformers,
      })
      for (const { query, target, thread, space } of transformers) {
        const result = evaluateTransform(query, selectedEvent.detail)
        if (result.ok) {
          addThread({
            space,
            name: `Transform(${thread} => ${target})`,
            description: `Transform re-entry: applies the ${thread} transform and re-emits as ${target}.`,
            once: true,
            rules: [{ request: { type: target, detail: result.value } }],
          })
        } else {
          // Errors-as-data: the target never fires; the failure is traced.
          sendTrace?.({
            kind: TRACE_MESSAGE_KINDS.transform_error,
            timestamp: Date.now(),
            step: stepId,
            instanceId,
            sessionId,
            transformer: { query, target, thread, space },
            reason: result.reason,
            ...(result.stderr !== undefined && { stderr: result.stderr }),
            ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
          })
        }
      }
    }
    sendTrace({
      kind: TRACE_MESSAGE_KINDS.selection,
      timestamp: Date.now(),
      step: stepId,
      instanceId,
      sessionId,
      selected: selectedEvent,
    })
    /**
     * @internal
     * Executes one part of the super-step: advancing running threads to their next yield.
     *
     * This function:
     * 1. Iterates through all running threads
     * 2. Advances each thread's generator to its next yield point
     * 3. Captures the yielded Idioms (synchronization declarations)
     * 4. Moves the thread from 'running' to 'pending' state
     * 5. Proceeds to the event selection phase
     */
    step()
  }

  /**
   * @internal
   * Implementation of the public `trigger` function.
   */
  const trigger: Trigger = (event) => {
    // Read before validation: the Ajv type-guard narrows `event` to `never` in
    // the failure branch, so the attempted space must be captured up front.
    const attemptedSpace = event.space
    if (!validateBPEvent(event)) {
      return sendTrace({
        kind: TRACE_MESSAGE_KINDS.trigger_error,
        timestamp: Date.now(),
        instanceId,
        sessionId,
        error: validateBPEvent.errors ?? [],
        ...(typeof attemptedSpace === 'string' ? { space: attemptedSpace } : {}),
      })
    }
    const thread = function* () {
      yield {
        request: event,
      }
    }
    const key = threadKey()
    running.set(key, {
      space: event.space,
      priority: 0,
      generator: thread(),
      ingress: true,
      name: event.type,
      description: `Ingress event thread — minted for the trigger-arrived ${event.type} event.`,
      key,
    })

    /**
     * @internal
     * Executes one part of the super-step: advancing running threads to their next yield.
     *
     * This function:
     * 1. Iterates through all running threads
     * 2. Advances each thread's generator to its next yield point
     * 3. Captures the yielded Idioms (synchronization declarations)
     * 4. Moves the thread from 'running' to 'pending' state
     * 5. Proceeds to the event selection phase
     */
    step(true)
  }

  /**
   * @internal
   * Implementation of the public `useTrace` hook.
   * Delegates directly to the trace publisher's subscribe method.
   */
  const useTrace: UseTrace = (listener) => sendTrace.subscribe(listener)

  /**
   * @internal
   * Implementation of the public `removeThread` hook — stages the teardown of
   * the instance-hash-keyed thread. Resolved against the LIVE maps now: an
   * unknown or already-exhausted identity is a clean no-op (nothing staged,
   * nothing traced); a live thread stages its generator + record for the
   * next super-step.
   */
  const removeThread: RemoveThread = (args) => {
    const instanceHash = args?.instanceHash
    if (typeof instanceHash !== 'number') return
    const key = threadKey(instanceHash)
    const bid = running.get(key) ?? pending.get(key)
    if (bid === undefined) return
    stagedRemovals.set(key, {
      instanceHash,
      generator: bid.generator,
      thread: bid.thread ?? { name: bid.name, description: '', rules: [] },
    })
  }

  /**
   * @internal
   * Return the frozen public API object.
   *
   * Object.freeze ensures the API surface is immutable, preventing accidental
   * modification of the program's interface. This provides a stable and
   * predictable API for consumers of the behavioral program.
   */
  return Object.freeze({
    /** Add thread to program. */
    addThread,
    /** Remove an instance-hash-keyed thread (staged to the next super-step). */
    removeThread,
    /** Function to inject external events into the program. */
    trigger,
    /** Hook to subscribe to internal state traces for monitoring/debugging. */
    useTrace,
    step: () => step(),
    /**
     * The per-process identity the engine self-mints and stamps on every
     * trace. Exposed so a host can hand the identity to its clients (the
     * attach hello) without sniffing the trace wire — which on an idle
     * instance is silent. Session ids stay accept-only: never minted,
     * never returned (the host layer owns session identity policy).
     */
    instanceId,
  })
}
