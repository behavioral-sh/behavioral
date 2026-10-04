import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { validateThread } from '../behavioral/behavioral.types.ts'
import { eventGuardEntries, facultiesThreads, guardThreads } from '../faculties/faculties.threads.ts'
import {
  SystemOneCancelEventSchema,
  SystemOneRequestEventSchema,
  SystemOneRequestResultEventSchema,
  SystemTwoCancelEventSchema,
  SystemTwoRequestEventSchema,
  SystemTwoRequestResultEventSchema,
  TransformRequestEventSchema,
  TransformRequestResultEventSchema,
  validateFrontierAnalysisRequestEvent,
  validateSystemOneCancelEvent,
  validateSystemOneRequestEvent,
  validateSystemTwoCancelEvent,
  validateSystemTwoRequestEvent,
  validateTransformRequestEvent,
} from '../faculties/faculties.types.ts'
import {
  admissionCandidateMintThreads,
  admissionStructuralOutcomeThreads,
} from '../faculties/frontier-analysis.threads.ts'
import {
  ADMISSION_EVENT_TYPES,
  ADMISSION_MAX_JUDGE_RETRIES,
  admissionJudgmentThreads,
  validateAdmissionVerdict,
} from '../faculties/system-one.threads.ts'
import { deepEqual, jitteredBackoffMs, uuid } from '../utils.ts'
import { RECONCILE_EVENT_TYPES } from './plugin-threads.reconcile.ts'
import { pluginThreadInstanceHash } from './plugin-threads.registry.ts'
import { PLUGIN_THREADS_EVENT_TYPES } from './plugin-threads.threads.ts'
import { UI_RENDER_TRIGGER_TYPE, uiPipelineThreads } from './ui-threads.ts'
import { useWorker } from './use-worker.ts'

/*
 * The runtime composition — IN-PROCESS (the browser bProgram worker entry
 * boots the same graph over postMessage at the rewire). The engine is
 * behavioral(): addThread/trigger/step called directly, traces through
 * useTrace. The FIXED faculties — frontierAnalysis, systemOne, systemTwo — are web
 * workers wired HERE through useWorker (factory at the call site, the
 * bundler-visible `new Worker` literal): never optional, never overrides —
 * endpoints/models are data riding the INIT FRAME (`models`). The actuator
 * lanes arrive as PRE-BUILT curried builders (the host entry's useActuator /
 * socket-lane returns — reachability is construction, never config), and the
 * composition invokes each with its addThreads, owning the lifecycles.
 *
 * The surface is the ruled two-key-plus-lanes shape: `threads` (host-minted
 * policy packs — shell, rpc-auth, remote-mcp, plugin-threads, supervision,
 * ui_*; the root guards stay internal, always-mounted), `models` (the
 * faculties' init-frame payloads + the ui generation target), and
 * `actuators`. No override legs, no allow-list, no supervision/ui keys.
 *
 * The in-process re-entry law: addThread alone is inert — every re-entry
 * (satellite results, crash synthesis, thread mounts) pumps one super-step.
 *
 * The lifecycle is explicit: construction wires the engine, faculties, and
 * routes but does NOT flush the deferred thread mounts. The host subscribes
 * (`runtime.useTrace`) first, then calls `runtime.start()` — the boot
 * cascade runs after subscribers attach, so boot traces are observable.
 * `runtime.trigger` admits events only; start/terminate are the host's
 * lifecycle, never the event lane's.
 */

// The ruled lane types live in the wire home (the socket lane is the third
// lane beside spawn and worker); the composition re-exports them.
export type { FacultyLane, LaneBuilder } from '../faculties/faculties.types.ts'

import type { LaneBuilder } from '../faculties/faculties.types.ts'

/** The in-run decided key — the registry key's dimensions joined (a separator the data can't contain). */
const decidedKey = (meta: { plugin: string; file: string; hash: string; umwelt?: string }): string =>
  `${meta.plugin}\u0000${meta.file}\u0000${meta.hash}\u0000${meta.umwelt ?? ''}`

/** The actuator names the composition routes (the trio) — the registry lives in the wire home. */
import { ACTUATOR_ROUTE, FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'

/**
 * The composition-owned admission thread names — the orchestration packs are
 * composition-INTERNAL thread data, never host-passable (the orchestration
 * ruling): the double-mount hazard dies by dissolution, and this set is the
 * construction-time belt (a host passing any of these throws below).
 */
const OWNED_ADMISSION_THREAD_NAMES = new Set(
  [...admissionCandidateMintThreads, ...admissionStructuralOutcomeThreads, ...admissionJudgmentThreads].map(
    (thread) => thread.name,
  ),
)

export const bProgram = ({
  threads: hostThreads = [],
  models = {},
  actuators = [],
  scheduler: hostSchedulerConfig,
}: {
  /**
   * The host-minted policy packs: shell threads, rpc-auth, remote-mcp,
   * plugin-threads, supervision, ui_* — reachability conditions are the
   * host's (it built the lanes). The root guard threads mount internally,
   * always. The ADMISSION orchestration packs are composition-internal —
   * a host passing one throws at construction (the ownership guard).
   */
  threads?: Thread[]
  /**
   * Model config — the faculties' INIT FRAME payloads plus the ui generation
   * target. `systemOne`: the SystemOneEndpointConfig; `systemTwo`: the
   * SystemTwoEndpoints map (per-provider `transport: 'rest' | 'webgpu'`);
   * `ui`: the generation provider label + model id within the systemTwo map
   * (defaults to the ui-threads conventions). Identifiers today, catalog ids
   * when the download resolver lands — the shape does not change.
   */
  models?: {
    systemOne?: JsonObject
    systemTwo?: JsonObject
    ui?: { provider?: string; modelId?: string }
  }
  /** The pre-built actuator lanes — reachability is construction, never config. */
  actuators?: LaneBuilder[]
  /**
   * The OUTAGE SHAPE's timer host (the composition is the engine's FIRST
   * timer — the engine has no timer event source): schedules the admission
   * judge re-issues on the capped-exponential full-jitter backoff. Defaults
   * to the globals; the specs inject a deterministic scheduler and drive the
   * timers by hand, asserting the jitter bounds.
   */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}) => {
  const hostScheduler = hostSchedulerConfig ?? {
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  // The ownership guard (the orchestration ruling, belt not load-bearing):
  // the admission orchestration packs are composition-internal thread data.
  // A host passing one double-mounts it beside the composition's own mount
  // (the per-listener mint doubles, thread_admission fires twice) — so the
  // collision fails fast at CONSTRUCTION, naming every colliding thread.
  const ownedCollisions = hostThreads
    .filter((thread) => OWNED_ADMISSION_THREAD_NAMES.has(thread.name))
    .map((thread) => thread.name)
  if (ownedCollisions.length > 0) {
    throw new Error(
      `composition-owned admission threads are never host-passable: ${ownedCollisions.join(', ')} — ` +
        'hosts never mount admission threads (the orchestration packs mount internally, keyed on the model config)',
    )
  }

  // ── The engine, in-process ────────────────────────────────────────────────

  const { addThread, removeThread, step, trigger, useTrace, instanceId } = behavioral()
  /**
   * The identity handoff: the engine's self-minted per-process id, with the
   * resolved session id. The composition supplies no host session id today,
   * so the engine's `sessionId ?? instanceId` default makes the two equal —
   * when a host session id reaches this composition it must flow into
   * `behavioral({ sessionId })` AND into this pair (one home for the id
   * handshake).
   */
  const identity = { instanceId, sessionId: instanceId }

  /** The in-process re-entry law: addThread + the trailing step. */
  const addThreads = (threads: Thread[]): void => {
    for (const thread of threads) addThread(thread)
    step()
  }

  // Boot-order law: thread mounts (and any faculty construction's thread
  // additions) are DEFERRED until the pump is subscribed and the routes are
  // registered — the Worker world got this for free (the engine subscribed at
  // spawn, before any add_threads); in-process, the first step's selections
  // would land on a pump that doesn't route yet. RE-ENTRIES (satellite
  // results, crash synthesis) go live immediately after the flush.
  const pendingThreads: Thread[] = []
  let mounting = true
  const facultyAddThreads = (threads: Thread[]): void => {
    if (mounting) pendingThreads.push(...threads)
    else addThreads(threads)
  }

  // ── Faculty wiring: the fixed three as workers; the actuators pre-built ────

  // The frontierAnalysis faculty (the reachability analysis engine —
  // replay/explore/verify/
  // add_thread): a worker (the deepened wire — `op` beside `input` in the
  // correlated detail). No cancel contract, no config — it boots bare.
  const frontierAnalysis = useWorker({
    name: 'frontier_analysis',
    worker: () => new Worker(new URL('../faculties/frontier-analysis.faculty.ts', import.meta.url)),
    validateRequest: validateFrontierAnalysisRequestEvent,
    resultKind: FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
  })(facultyAddThreads)

  // The system faculties: fixed workers; their config rides the INIT FRAME
  // (`models`). An absent payload leaves the faculty mounted but
  // endpoint-less — its calls answer the typed error, fail-visible.
  const systemOne = useWorker({
    name: 'systemOne',
    worker: () => new Worker(new URL('../faculties/system-one.faculty.ts', import.meta.url)),
    validateRequest: validateSystemOneRequestEvent,
    validateCancel: validateSystemOneCancelEvent,
    resultKind: FACULTY_MESSAGE_KINDS.system_one_request_result,
    ...(models.systemOne === undefined ? {} : { initData: models.systemOne }),
  })(facultyAddThreads)

  const systemTwo = useWorker({
    name: 'systemTwo',
    worker: () => new Worker(new URL('../faculties/system-two.faculty.ts', import.meta.url)),
    validateRequest: validateSystemTwoRequestEvent,
    validateCancel: validateSystemTwoCancelEvent,
    resultKind: FACULTY_MESSAGE_KINDS.system_two_request_result,
    ...(models.systemTwo === undefined ? {} : { initData: models.systemTwo }),
  })(facultyAddThreads)

  // The transform faculty — the FIXED FOURTH lane: the engine's transform
  // mints ride here. The init frame carries the faculty's OWN url (classic
  // worker bundles cannot touch `import.meta`; the per-request nested eval
  // worker re-executes the same artifact from it) — the bundler-visible
  // literal lives at THIS call site, one home with the spawn factory.
  const transformFacultyUrl = new URL('../faculties/transform.faculty.ts', import.meta.url)
  const transform = useWorker({
    name: 'transform',
    worker: () => new Worker(transformFacultyUrl),
    validateRequest: validateTransformRequestEvent,
    resultKind: FACULTY_MESSAGE_KINDS.transform_request_result,
    initData: { selfUrl: transformFacultyUrl.href },
  })(facultyAddThreads)

  // The actuator lanes: the host's pre-built builders, invoked with OUR
  // addThreads — the composition owns every lane lifecycle it completes.
  const actuatorLanes = actuators.map((build) => build(facultyAddThreads))

  // ── Routing: event type → faculty lane (the only faculty knowledge) ────────

  // The root guard threads are always mounted, independent of the host packs.
  facultyAddThreads(facultiesThreads)

  // The fixed faculties' schema guards derive from the wire home's schemas —
  // a malformed system event is blocked (visible in the traces), not silently
  // dropped. (The actuators route through their lanes' own gates — the old
  // wiring mounted no per-actuator guards either.)
  facultyAddThreads(
    guardThreads(
      'guard:systemOne-schema',
      'Blocks every systemOne wire message whose detail fails its event schema.',
      eventGuardEntries({
        request: SystemOneRequestEventSchema,
        cancel: SystemOneCancelEventSchema,
        result: SystemOneRequestResultEventSchema,
      }),
    ),
  )
  facultyAddThreads(
    guardThreads(
      'guard:systemTwo-schema',
      'Blocks every systemTwo wire message whose detail fails its event schema.',
      eventGuardEntries({
        request: SystemTwoRequestEventSchema,
        cancel: SystemTwoCancelEventSchema,
        result: SystemTwoRequestResultEventSchema,
      }),
    ),
  )
  facultyAddThreads(
    guardThreads(
      'guard:transform-schema',
      'Blocks every transform wire message whose detail fails its event schema.',
      eventGuardEntries({
        request: TransformRequestEventSchema,
        result: TransformRequestResultEventSchema,
      }),
    ),
  )

  // The host-minted policy packs.
  facultyAddThreads(hostThreads)

  // The admission orchestration is COMPOSITION-INTERNAL thread data (the
  // orchestration ruling; hosts never pass these — the ownership guard pins
  // it). The candidate mint is ALWAYS-mounted: a both-legs-ok add_thread
  // verdict mints thread_candidate (the judgment pack's issue waits on it;
  // the structural outcome maps it). The OUTCOME STAGE is mode-exclusive:
  // without the systemOne payload the structural outcome IS the BP-native
  // admission gate — livelocked proposals reject visibly, as events; with
  // it the judged path mounts (block-then-judge over the Decisions lane).
  // NEVER stacked — a stacked structural outcome + judgment gate is the
  // reject-then-admit bug.
  facultyAddThreads(admissionCandidateMintThreads)
  if (models.systemOne === undefined) {
    facultyAddThreads(admissionStructuralOutcomeThreads)
  } else {
    facultyAddThreads(admissionJudgmentThreads)
  }

  // The pending plugin-threads admissions: candidate id → the proposal key's
  // dimensions (plugin, file, hash, umwelt) + the captured failure reason.
  // The candidate events carry everything; the composition joins at the
  // outcome. A decided key never re-adjudicates WITHIN the run (the durable
  // record is the host entry's registry — its boot fold is the cross-run
  // half; the cross-run skip mechanism is the open rewire finding).
  const pluginAdmissions = new Map<
    string,
    { plugin: string; file: string; hash: string; umwelt?: string; reason?: string }
  >()
  /** In-run decided keys — the skip leg's within-run half. */
  const decidedKeys = new Map<string, { status: 'admitted' | 'rejected'; reason?: string }>()

  /**
   * The transform parks: the minted request id → the reshape contract. The
   * composition parks at the mint-time `transform` trace (the thread label's
   * only carrier — the route leg's event carries id/query/target but not the
   * source thread name the mint name needs), and joins at the result leg.
   * A park entry is consumed by its result; an orphaned entry (a crashed
   * lane, a stray id) stays — bounded by transform volume, never a hang.
   */
  const transformParks = new Map<string, { thread: string; target: string; umwelt?: string }>()

  /**
   * The mounted instance identities — the mount leg's idempotence floor: a
   * boot/reload reconciliation never double-mounts a live instance (the
   * engine's duplicate-identity guard stays a fail-visible backstop).
   */
  const mountedInstances = new Set<number>()

  // ── The OUTAGE SHAPE (the 2026-10-03 ruling) — the composition-hosted
  // judge re-issue: the engine has no timer event source, so the backoff
  // schedule lives HERE (the composition's first timer), the algorithm the
  // websocket-transport `#retry` shape — capped exponential with full
  // jitter, the one shared home (`jitteredBackoffMs`). A judge-unavailable
  // outcome (the typed-error result or a systemOne lane death) holds the
  // candidate's admission — the gate never lifts on the hold event — and
  // re-issues the SAME Decision, bounded at the pack's retry budget. The
  // re-issue is the candidate RE-EMISSION: it rides the issue thread's jq
  // (the Decision-input policy stays in the pack) and re-arms the gate.
  // NO decided record writes on any outage leg; exhaustion leaves the
  // candidate UNDECIDED (held, fail-visible — the next boot/reload
  // re-adjudicates for free), the gate lifts, an explicit judged NO stays
  // durable.
  /** The outage bookkeeping: candidate id → the re-issues fired (bounded). */
  const judgeRetries = new Map<string, number>()
  /** The live re-issue timers — terminate clears them (the composition owns every lifecycle). */
  const judgeTimers = new Map<string, unknown>()
  const judgeUnavailable = (id: string, reason: string): void => {
    if (!pendingAdmissions.has(id)) return
    const attempt = (judgeRetries.get(id) ?? 0) + 1
    judgeRetries.set(id, attempt)
    if (attempt > ADMISSION_MAX_JUDGE_RETRIES) {
      judgeRetries.delete(id)
      // Exhaustion: the candidate stands UNDECIDED — the undecided event
      // lifts the gate (the lane never wedges), no record writes, the held
      // admission is visible. The pending id stays (an undecided candidate
      // is not a decision).
      addThreads([
        {
          name: `system-one/admission-undecided:${id}:${uuid()}`,
          description: 'Marks the admission candidate UNDECIDED — the judge retry budget is exhausted.',
          once: true,
          rules: [
            {
              request: {
                type: ADMISSION_EVENT_TYPES.undecided,
                detail: { id, attempts: ADMISSION_MAX_JUDGE_RETRIES, reason },
              },
            },
          ],
        },
      ])
      return
    }
    judgeTimers.set(
      id,
      hostScheduler.setTimeout(
        () => {
          judgeTimers.delete(id)
          const thread = pendingAdmissions.get(id)
          if (thread === undefined || thread === null) return
          addThreads([
            {
              name: `system-one/admission-reissue:${id}:${uuid()}`,
              description: 'Re-issues the admission Decision for an outage-held candidate (the same correlation).',
              once: true,
              rules: [
                {
                  request: {
                    type: ADMISSION_EVENT_TYPES.candidate,
                    detail: { id, thread } as unknown as JsonObject,
                  },
                },
              ],
            },
          ])
        },
        jitteredBackoffMs(attempt - 1),
      ),
    )
  }

  type FacultyPort = { send: (event: BPEvent) => void; gate: (event: BPEvent) => boolean }
  const lanes: Record<string, FacultyPort> = {}
  const route = (types: string[], faculty: FacultyPort): void => {
    for (const type of types) lanes[type] = faculty
  }

  route([FACULTY_MESSAGE_KINDS.system_one_request, FACULTY_MESSAGE_KINDS.system_one_cancel], {
    send: (event: BPEvent): void => systemOne.send(event),
    gate: (event: BPEvent): boolean => systemOne.invalidEventGate(event),
  })
  route([FACULTY_MESSAGE_KINDS.system_two_request, FACULTY_MESSAGE_KINDS.system_two_cancel], {
    send: (event: BPEvent): void => systemTwo.send(event),
    gate: (event: BPEvent): boolean => systemTwo.invalidEventGate(event),
  })
  route([FACULTY_MESSAGE_KINDS.transform_request], {
    send: (event: BPEvent): void => transform.send(event),
    gate: (event: BPEvent): boolean => transform.invalidEventGate(event),
  })
  for (const lane of actuatorLanes) {
    const kinds = ACTUATOR_ROUTE[lane.name]
    if (kinds === undefined) {
      // A lane the composition cannot route is a construction bug — fail fast
      // at wiring time, never as a silently-unrouted faculty.
      throw new Error(
        `unknown actuator lane name: "${lane.name}" — expected one of: ${Object.keys(ACTUATOR_ROUTE).join(', ')}`,
      )
    }
    route(kinds, {
      send: (event: BPEvent): void => lane.send(event),
      gate: (event: BPEvent): boolean => lane.invalidEventGate(event),
    })
  }

  // The admission path — pending add_thread ids. An id registers when its
  // request routes through the frontier lane (the request leg below); the
  // correlated frontier_analysis_request_result carries the verdict. The map is the
  // authorization: only results correlated to requests this composition
  // itself routed can ever admit. A null thread (the proposal failed the
  // Thread-schema gate at registration) never admits. The id survives until
  // the verdict resolves: the verdict is the CANDIDATE record — the judged
  // outcome events below are the write legs.
  const pendingAdmissions = new Map<string, Thread | null>()

  route([FACULTY_MESSAGE_KINDS.frontier_analysis_request], {
    send: (event: BPEvent): void => {
      // The request leg: register the id against the proposed thread, then
      // route through the frontierAnalysis dispatch. The analysis stays
      // analysis-shaped — it validates and returns; the composition owns the
      // write (the verdict leg, in the pump below).
      const detail = event.detail as { id?: string; op?: string; input?: { thread?: unknown } } | undefined
      if (detail?.op === 'add_thread' && typeof detail.id === 'string') {
        // The in-run registry gate: a decided (plugin, file, hash, umwelt) key
        // never re-adjudicates within the run — an admitted key is already
        // live (the boot fold mounted the snapshot; a live admission mounted
        // it this run), a rejected key stays out. The skip surfaces as its
        // own event, never a silent drop. (The CROSS-run half rides the
        // host entry's registry — its boot fold is the durable half; the
        // cross-run skip mechanism is the open rewire finding.)
        const pluginMeta = pluginAdmissions.get(detail.id)
        if (pluginMeta !== undefined) {
          const decided = decidedKeys.get(decidedKey(pluginMeta))
          if (decided !== undefined) {
            addThreads([
              {
                name: `plugin-threads-skip:${detail.id}`,
                description: 'Signals the skipped verdict for an already-decided plugin-thread candidate.',
                once: true,
                rules: [
                  {
                    request: {
                      type: PLUGIN_THREADS_EVENT_TYPES.skipped,
                      detail: {
                        id: detail.id,
                        input: {
                          plugin: pluginMeta.plugin,
                          file: pluginMeta.file,
                          hash: pluginMeta.hash,
                          ...(pluginMeta.umwelt === undefined ? {} : { umwelt: pluginMeta.umwelt }),
                          status: decided.status,
                          ...(decided.status === 'rejected' ? { reason: decided.reason } : {}),
                        },
                      } as unknown as JsonObject,
                    },
                  },
                ],
              },
            ])
            return
          }
        }
        pendingAdmissions.set(
          detail.id,
          validateThread(detail.input?.thread) ? (detail.input as { thread: Thread }).thread : null,
        )
        // The add_thread request passes through UNCHANGED — the admission
        // policy (progress + the clamped budget) is thread data composed at
        // the mint (the proposal carry's dispatch jq, the orchestration
        // ruling); the op's own validation is the boundary. Livelock
        // detection is part of adding threads (the ruling): a self-
        // sustaining loop proposal comes back a failed verdict and never
        // reaches the write.
        frontierAnalysis.send(event)
        return
      }
      frontierAnalysis.send(event)
    },
    gate: frontierAnalysis.invalidEventGate,
  })

  // ── The engine pump: traces out, gated events to their faculty lanes ─────

  // The verdict leg: a frontier_analysis_request_result correlated to a pending
  // add_thread id. Both verdict legs must be ok for the thread to admit under
  // the re-entry law (addThread + step): the outer envelope (the analysis ran)
  // and the inner verdict (it verified). The rejection is data — the
  // requester reads the why from the verdict trace. The durable registry
  // record rides the HOST ENTRY's trace subscription (the entry-side
  // watcher); the composition only mounts + skips.
  useTrace((trace: Trace) => {
    // The transform park leg (the MINT-TIME trace — the thread label's only
    // carrier): every minted request's contract parks by id. The result leg
    // below joins by the same id.
    if (trace.kind === TRACE_MESSAGE_KINDS.transform) {
      for (const t of trace.transformers) {
        transformParks.set(t.id, {
          thread: t.thread,
          target: t.target,
          ...(t.umwelt === undefined ? {} : { umwelt: t.umwelt }),
        })
      }
      return
    }
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const candidate = (trace as SelectionTrace).selected
    // The plugin-threads candidate record: the composition joins the proposal
    // key's dimensions to the add_thread id.
    if (candidate.type === PLUGIN_THREADS_EVENT_TYPES.candidate) {
      const detail = candidate.detail as
        | { id?: string; input?: { plugin?: string; file?: string; hash?: string; umwelt?: string } }
        | undefined
      if (
        typeof detail?.id === 'string' &&
        typeof detail.input?.plugin === 'string' &&
        typeof detail.input.file === 'string' &&
        typeof detail.input.hash === 'string'
      ) {
        pluginAdmissions.set(detail.id, {
          plugin: detail.input.plugin,
          file: detail.input.file,
          hash: detail.input.hash,
          ...(detail.input.umwelt === undefined ? {} : { umwelt: detail.input.umwelt }),
        })
      }
      return
    }
    // The judgment's outcome legs — the admission judgment threads' road back
    // to the pump. Only a conforming verdict with admit === true admits; a
    // rejection (or anything malformed — fail-closed) drops the pending id,
    // the rejection visible in the traces. The in-run decided map records the
    // key's outcome (the durable record is the entry's).
    if (candidate.type === ADMISSION_EVENT_TYPES.admitted || candidate.type === ADMISSION_EVENT_TYPES.rejected) {
      const detail = candidate.detail as { id?: string } | undefined
      const id = detail?.id
      if (typeof id === 'string' && pendingAdmissions.has(id)) {
        const thread = pendingAdmissions.get(id)
        pendingAdmissions.delete(id)
        const verdictOk =
          candidate.type === ADMISSION_EVENT_TYPES.admitted && validateAdmissionVerdict(candidate.detail)
        if (thread && verdictOk) {
          // The instance identity stamps at the MOUNT (post-sourceHash — the
          // mount path's job, never the author's): the live thread becomes
          // removal-addressable, and the recorded snapshot matches it.
          const pluginMetaForStamp = pluginAdmissions.get(id)
          const stamped =
            pluginMetaForStamp === undefined
              ? thread
              : {
                  ...thread,
                  instanceHash: pluginThreadInstanceHash({
                    plugin: pluginMetaForStamp.plugin,
                    umwelt: pluginMetaForStamp.umwelt,
                    name: thread.name,
                  }),
                }
          if (typeof stamped.instanceHash === 'number') {
            // The remove-then-remount wave: a live same-identity instance
            // (the reload's re-adjudication) stages its teardown — the
            // engine's staged-removal overwrite lets the new mount through.
            if (mountedInstances.has(stamped.instanceHash)) removeThread({ instanceHash: stamped.instanceHash })
            mountedInstances.add(stamped.instanceHash)
          }
          addThreads([stamped])
        }
        const pluginMeta = pluginAdmissions.get(id)
        if (pluginMeta !== undefined) {
          pluginAdmissions.delete(id)
          decidedKeys.set(
            decidedKey(pluginMeta),
            verdictOk
              ? { status: 'admitted' }
              : {
                  status: 'rejected',
                  reason:
                    (candidate.detail as { reason?: string } | undefined)?.reason ??
                    pluginMeta.reason ??
                    'admission rejected',
                },
          )
        }
      }
      return
    }
    // The OUTAGE legs: the judged hold event drives the composition-hosted
    // re-issue; a systemOne lane death leaves every in-flight Decision
    // unanswered — each pending candidate holds and re-issues on the same
    // budget. Other faculties' errors do not correlate to admissions.
    if (candidate.type === ADMISSION_EVENT_TYPES.judgeUnavailable) {
      const detail = candidate.detail as { id?: string; reason?: string } | undefined
      if (typeof detail?.id === 'string') judgeUnavailable(detail.id, detail.reason ?? 'judge unavailable')
      return
    }
    if (candidate.type === FACULTY_MESSAGE_KINDS.faculty_error) {
      const detail = candidate.detail as { faculty?: string; message?: string } | undefined
      if (detail?.faculty === 'systemOne') {
        for (const [id, thread] of pendingAdmissions) {
          if (thread === null) continue
          judgeUnavailable(id, detail.message ?? 'systemOne unavailable')
        }
      }
      return
    }
    if (candidate.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result) {
      const detail = candidate.detail as { id?: string; ok?: boolean; result?: { ok?: boolean } } | undefined
      const id = detail?.id
      if (typeof id === 'string' && pendingAdmissions.has(id)) {
        const thread = pendingAdmissions.get(id)
        // A plugin-threads candidate whose structural verdict failed captures
        // the why — the in-run decided map's rejected entry carries it.
        const pluginMeta = pluginAdmissions.get(id)
        if (pluginMeta !== undefined && !(detail?.ok === true && detail.result?.ok === true)) {
          pluginMeta.reason =
            detail?.ok === false
              ? ((detail as { error?: { message?: string } } | undefined)?.error?.message ?? 'invalid proposal')
              : `structural verdict: ${(detail?.result as { status?: string } | undefined)?.status ?? 'failed'}`
        }
        if (!(detail?.ok === true && thread && detail.result?.ok === true)) {
          // The rejection is data — the requester reads the why from the
          // verdict trace. A plugin-threads candidate's in-run decided key
          // records here (the durable record is the entry's). An OK verdict
          // mints NOTHING here: the candidate is the ALWAYS-mounted
          // candidate-mint thread's selection (the orchestration ruling:
          // thread data, not a composition mint) — the composition keeps
          // only the authorization (the pending id) and the outcome stage's
          // write legs consume it.
          pendingAdmissions.delete(id)
          if (pluginMeta !== undefined) {
            decidedKeys.set(decidedKey(pluginMeta), {
              status: 'rejected',
              reason: pluginMeta.reason ?? 'admission rejected',
            })
          }
        }
      }
      return
    }
    // The ui pipeline dispatcher (the HOST LEG — branch (a) of the ruling):
    // a render INGRESS mints the per-trigger pipeline. The factory composes
    // pure data (jq strings, no closures) from trusted host code — the
    // admission-path precedent; addThread's ThreadSchema gate is the
    // backstop, no frontierAnalysis judgment needed for host-authored threads. The
    // mint is the re-entry: addThreads pumps the super-step, so the minted
    // scale-issue request runs in the same wave as the ingress. The switch
    // is the host's ui pack itself: the mint fires iff a `ui/`-labeled pack
    // is among the mounted threads (the ui key dissolved into the array).
    // ── The reconciliation verdict legs (the HOST-LEG MINT — the ui-dispatcher
    // precedent): the composition acts on the reconciliation's events; the
    // record writes ride the entry-side watcher (the carried/removed
    // selections reach it directly).
    // The transform RESULT leg: the faculty's answer joins its parked
    // contract. ok:true mints the target once-thread (`detail = result.value`,
    // the re-entry law intact, the umwelt carried per Direction/R); ok:false —
    // and any malformed result — mints NOTHING: the failure surfaces as this
    // result selection itself, fail-visible. An unknown id (a stray result
    // this composition never routed) selects and matches nothing — the park
    // is the authorization, the pluginAdmissions precedent.
    if (candidate.type === FACULTY_MESSAGE_KINDS.transform_request_result) {
      const detail = candidate.detail as { id?: string; ok?: boolean; value?: JsonObject } | undefined
      const id = detail?.id
      if (typeof id === 'string' && transformParks.has(id)) {
        const park = transformParks.get(id)!
        transformParks.delete(id)
        if (detail?.ok === true && detail.value !== undefined) {
          addThreads([
            {
              name: `Transform(${park.thread} => ${park.target})`,
              description: `Transform re-entry: applies the ${park.thread} transform and re-emits as ${park.target}.`,
              once: true,
              rules: [{ request: { type: park.target, detail: detail.value } }],
              ...(park.umwelt === undefined ? {} : { umwelt: park.umwelt }),
            },
          ])
        }
      }
      return
    }
    if (candidate.type === RECONCILE_EVENT_TYPES.mount) {
      const thread = (candidate.detail as { input?: { thread?: unknown } } | undefined)?.input?.thread
      if (!validateThread(thread)) return
      const t = thread as Thread
      if (typeof t.instanceHash === 'number') {
        // Mount idempotence: a live same-identity instance never double-mounts
        // (a reload's unchanged pass is a no-op; the engine's duplicate guard
        // stays the fail-visible backstop).
        if (mountedInstances.has(t.instanceHash)) return
        mountedInstances.add(t.instanceHash)
      }
      addThreads([t])
      return
    }
    if (candidate.type === RECONCILE_EVENT_TYPES.removed) {
      const input = (candidate.detail as { input?: { instanceHash?: unknown } } | undefined)?.input
      if (typeof input?.instanceHash === 'number') {
        // LIVE teardown: the removal is the engine's staged teardown, the
        // next super-step. The identity leaves the mounted set — a later
        // pass may remount it fresh.
        mountedInstances.delete(input.instanceHash)
        removeThread({ instanceHash: input.instanceHash })
        // The re-entry law: the teardown's pump — the staged removal applies
        // at the next super-step, which this empty re-entry is.
        addThreads([])
      }
      return
    }
    if (candidate.type === RECONCILE_EVENT_TYPES.importDiff) {
      const input = (
        candidate.detail as
          | {
              input?: {
                plugin?: string
                file?: string
                hash?: string
                umwelt?: string
                carriedFrom?: string
                exports?: Array<{ name?: string } & JsonObject>
                snapshot?: { status?: string; thread?: Thread; reason?: string }
              }
            }
          | undefined
      )?.input
      if (
        input === undefined ||
        typeof input.plugin !== 'string' ||
        typeof input.file !== 'string' ||
        typeof input.hash !== 'string' ||
        !Array.isArray(input.exports) ||
        input.snapshot === undefined
      )
        return
      const snap = input.snapshot
      const compare = snap.thread
      // deepEqual vs the snapshot stripped of its engine-stamped identity
      // fields (instanceHash, sourceHash) — CONTENT is the comparison, never
      // identity.
      const stripped =
        compare === undefined || compare === null
          ? undefined
          : (({ instanceHash: _ih, sourceHash: _sh, ...rest }) => rest)(compare)
      const match = stripped === undefined ? undefined : input.exports.find((e) => e?.name === compare?.name)
      const carried =
        stripped !== undefined && match !== undefined && deepEqual(match as JsonObject, stripped as JsonObject)
      const umweltFields = input.umwelt === undefined ? {} : { umwelt: input.umwelt }
      if (carried) {
        // The verdict CARRIES forward — never silent: the watcher writes the
        // new record under the new file-hash key with carriedFrom provenance;
        // an admitted carry also mounts the (content-identical) snapshot.
        const legs: Thread[] = []
        if (snap.status === 'admitted' && compare !== undefined && compare !== null) {
          legs.push({
            name: `plugin-threads-carry-mount:${uuid()}`,
            description: 'Carries an admitted snapshot across a cosmetic rewrite: mounts it.',
            once: true,
            rules: [
              {
                request: {
                  type: RECONCILE_EVENT_TYPES.mount,
                  detail: { input: { thread: compare as unknown as JsonObject } } as unknown as JsonObject,
                },
              },
            ],
          })
        }
        legs.push({
          name: `plugin-threads-carry:${uuid()}`,
          description: 'Carries the reconciliation verdict forward across a cosmetic rewrite.',
          once: true,
          rules: [
            {
              request: {
                type: RECONCILE_EVENT_TYPES.carried,
                detail: {
                  input: {
                    plugin: input.plugin,
                    file: input.file,
                    hash: input.hash,
                    ...umweltFields,
                    status: snap.status === 'admitted' ? 'admitted' : 'rejected',
                    ...(compare !== undefined && compare !== null ? { thread: compare as unknown as JsonObject } : {}),
                    ...(snap.reason === undefined ? {} : { reason: snap.reason }),
                    ...(input.carriedFrom === undefined ? {} : { carriedFrom: input.carriedFrom }),
                  } as unknown as JsonObject,
                },
              },
            },
          ],
        })
        addThreads(legs)
      } else {
        // A semantic change re-adjudicates through the full landed path —
        // the explicit proposal act, the admission judgment gating every
        // changed candidate.
        addThreads([
          {
            name: `plugin-threads-re-adjudicate:${uuid()}`,
            description: 'Re-adjudicates a semantically changed plugin thread through the proposal path.',
            once: true,
            rules: [
              {
                request: {
                  type: PLUGIN_THREADS_EVENT_TYPES.proposal,
                  detail: {
                    id: `reconcile-${uuid()}`,
                    input: { plugin: input.plugin, file: input.file, ...umweltFields },
                  } as unknown as JsonObject,
                },
              },
            ],
          },
        ])
      }
      return
    }
    if (
      hostThreads.some((t) => t.name.startsWith('ui/')) &&
      candidate.type === UI_RENDER_TRIGGER_TYPE &&
      candidate.ingress === true
    ) {
      addThreads(
        uiPipelineThreads({
          id: `ui-${uuid()}`,
          detail: (candidate.detail ?? {}) as JsonObject,
          ...(models.ui?.provider === undefined ? {} : { provider: models.ui.provider }),
          ...(models.ui?.modelId === undefined ? {} : { modelId: models.ui.modelId }),
        }),
      )
      return
    }
    const event = { type: candidate.type, detail: candidate.detail, umwelt: candidate.umwelt } as BPEvent
    const faculty = lanes[event.type]
    if (faculty === undefined) return
    // The trust boundary for events crossing into faculty workers: only
    // events passing the owning faculty's own gate route.
    if (faculty.gate(event)) return
    faculty.send(event)
  })

  // ── The explicit start: flush the deferred thread mounts ────────────────

  // Construction wires the pump and routes but does not flush. The host
  // subscribes (useTrace) FIRST, then calls start() — the boot cascade
  // (scan boots → shell_requests → faculty workers) runs in a world whose
  // subscribers are attached, so boot traces are observable. Idempotent;
  // start/terminate are the host's lifecycle, never the event lane's.
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    mounting = false
    addThreads(pendingThreads)
  }

  // ── The runtime handle ────────────────────────────────────────────────────

  // The composition owns every faculty worker it wired and every actuator
  // lane it completed: the host hands over builders, the composition holds
  // the only `terminate` handle. (The engine is in-process: nothing to
  // terminate there — it ends with the host process.)
  return {
    trigger,
    useTrace,
    start,
    identity,
    terminate: (): void => {
      // The composition-hosted re-issue timers die with the runtime.
      for (const handle of judgeTimers.values()) hostScheduler.clearTimeout(handle)
      judgeTimers.clear()
      frontierAnalysis.terminate()
      systemOne.terminate()
      systemTwo.terminate()
      transform.terminate()
      for (const lane of actuatorLanes) lane.terminate()
    },
  }
}
