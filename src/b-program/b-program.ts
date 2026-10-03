import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { validateThread } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import { eventGuardEntries, facultiesThreads, guardThreads } from '../faculties/faculties.threads.ts'
import {
  SystemOneCancelEventSchema,
  SystemOneRequestEventSchema,
  SystemOneRequestResultEventSchema,
  SystemTwoCancelEventSchema,
  SystemTwoRequestEventSchema,
  SystemTwoRequestResultEventSchema,
  validateRemoteSystemTwoRequestEvent,
  validateSystemOneCancelEvent,
  validateSystemOneRequestEvent,
  validateSystemTwoCancelEvent,
  validateSystemTwoRequestEvent,
} from '../faculties/faculties.types.ts'
import { admissionAnalysisInput, admissionReviewThreads } from '../faculties/remote-system-two.threads.ts'
import {
  ADMISSION_EVENT_TYPES,
  admissionJudgmentThreads,
  validateAdmissionVerdict,
} from '../faculties/system-one.threads.ts'
import { uuid } from '../utils.ts'
import { PLUGIN_THREADS_EVENT_TYPES } from './plugin-threads.threads.ts'
import { UI_RENDER_TRIGGER_TYPE, uiPipelineThreads } from './ui-threads.ts'
import { useWorker } from './use-worker.ts'

/*
 * The runtime composition — IN-PROCESS (the browser bProgram worker entry
 * boots the same graph over postMessage at the rewire). The engine is
 * behavioral(): addThread/trigger/step called directly, traces through
 * useTrace. The FIXED faculties — remoteSystemTwo, systemOne, systemTwo — are web
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

/** The ruled four-key lane — what every faculty wiring returns. */
export type FacultyLane = {
  name: string
  send: (event: BPEvent) => void
  invalidEventGate: (event: BPEvent) => boolean
  terminate: () => void
}

/**
 * A pre-built actuator lane: the host entry's `useActuator(...)` /
 * socket-lane return. The composition invokes it with its addThreads —
 * binding the lane's re-entries to the re-entry law — and owns the
 * resulting lifecycle.
 */
export type LaneBuilder = (addThreads: (threads: Thread[]) => void) => FacultyLane

/** The in-run decided key — the registry key's dimensions joined (a separator the data can't contain). */
const decidedKey = (meta: { plugin: string; file: string; hash: string; space?: string }): string =>
  `${meta.plugin}\u0000${meta.file}\u0000${meta.hash}\u0000${meta.space ?? ''}`

/** The actuator names the composition routes (the trio; the registry of the faculty wire). */
const ACTUATOR_ROUTE: Record<string, string[]> = {
  shell: [FACULTY_MESSAGE_KINDS.shell_request, FACULTY_MESSAGE_KINDS.shell_cancel],
  store: [FACULTY_MESSAGE_KINDS.store_request],
  security: [FACULTY_MESSAGE_KINDS.credential_request, FACULTY_MESSAGE_KINDS.credential_cancel],
}

export const bProgram = ({
  threads: hostThreads = [],
  models = {},
  actuators = [],
}: {
  /**
   * The host-minted policy packs: shell threads, rpc-auth, remote-mcp,
   * plugin-threads, supervision, ui_* — reachability conditions are the
   * host's (it built the lanes). The root guard threads mount internally,
   * always.
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
}) => {
  // ── The engine, in-process ────────────────────────────────────────────────

  const { addThread, step, trigger, useTrace, instanceId } = behavioral()
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

  // The remoteSystemTwo faculty (the analysis engine — replay/explore/verify/
  // add_thread): a worker (the deepened wire — `op` beside `input` in the
  // correlated detail). No cancel contract, no config — it boots bare.
  const remoteSystemTwo = useWorker({
    name: 'remote_system_two',
    worker: () => new Worker(new URL('../faculties/remote-system-two.faculty.ts', import.meta.url)),
    validateRequest: validateRemoteSystemTwoRequestEvent,
    resultKind: FACULTY_MESSAGE_KINDS.remote_system_two_request_result,
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
      eventGuardEntries({
        request: SystemTwoRequestEventSchema,
        cancel: SystemTwoCancelEventSchema,
        result: SystemTwoRequestResultEventSchema,
      }),
    ),
  )

  // The host-minted policy packs.
  facultyAddThreads(hostThreads)

  // The admission packs: keyed on the model config (data, not faculty
  // presence — the systemOne faculty is fixed). With the systemOne payload
  // the judged path mounts (block-then-judge over the Decisions lane);
  // otherwise the structural review pack IS the BP-native admission gate —
  // livelocked proposals reject visibly, as events.
  if (models.systemOne === undefined) {
    facultyAddThreads(admissionReviewThreads)
  } else {
    facultyAddThreads(admissionJudgmentThreads)
  }

  // The pending plugin-threads admissions: candidate id → the proposal key's
  // dimensions (plugin, file, hash, space) + the captured failure reason.
  // The candidate events carry everything; the composition joins at the
  // outcome. A decided key never re-adjudicates WITHIN the run (the durable
  // record is the host entry's registry — its boot fold is the cross-run
  // half; the cross-run skip mechanism is the open rewire finding).
  const pluginAdmissions = new Map<
    string,
    { plugin: string; file: string; hash: string; space?: string; reason?: string }
  >()
  /** In-run decided keys — the skip leg's within-run half. */
  const decidedKeys = new Map<string, { status: 'admitted' | 'rejected'; reason?: string }>()

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
  // request routes through the remoteSystemTwo lane (the request leg below); the
  // correlated remote_system_two_request_result carries the verdict. The map is the
  // authorization: only results correlated to requests this composition
  // itself routed can ever admit. A null thread (the proposal failed the
  // Thread-schema gate at registration) never admits. The id survives until
  // the verdict resolves: the verdict is the CANDIDATE record — the judged
  // outcome events below are the write legs.
  const pendingAdmissions = new Map<string, Thread | null>()

  route([FACULTY_MESSAGE_KINDS.remote_system_two_request], {
    send: (event: BPEvent): void => {
      // The request leg: register the id against the proposed thread, then
      // route through the remoteSystemTwo dispatch. The analysis stays
      // analysis-shaped — it validates and returns; the composition owns the
      // write (the verdict leg, in the pump below).
      const detail = event.detail as { id?: string; op?: string; input?: { thread?: unknown } } | undefined
      if (detail?.op === 'add_thread' && typeof detail.id === 'string') {
        // The in-run registry gate: a decided (plugin, file, hash, space) key
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
                label: `plugin-threads-skip:${detail.id}`,
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
                          ...(pluginMeta.space === undefined ? {} : { space: pluginMeta.space }),
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
        // Livelock detection is part of adding threads (the ruling): the
        // analysis input rides the composition's policy — the progress spec
        // and the clamped exploration budget — never the requester's claim.
        // A self-sustaining loop proposal comes back a failed verdict and
        // never reaches the write.
        remoteSystemTwo.send({
          ...event,
          detail: { ...detail, input: admissionAnalysisInput(detail.input as JsonObject) },
        })
        return
      }
      remoteSystemTwo.send(event)
    },
    gate: remoteSystemTwo.invalidEventGate,
  })

  // ── The engine pump: traces out, gated events to their faculty lanes ─────

  // The verdict leg: a remote_system_two_request_result correlated to a pending
  // add_thread id. Both verdict legs must be ok for the thread to admit under
  // the re-entry law (addThread + step): the outer envelope (the analysis ran)
  // and the inner verdict (it verified). The rejection is data — the
  // requester reads the why from the verdict trace. The durable registry
  // record rides the HOST ENTRY's trace subscription (the entry-side
  // watcher); the composition only mounts + skips.
  useTrace((trace: Trace) => {
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const candidate = (trace as SelectionTrace).selected
    // The plugin-threads candidate record: the composition joins the proposal
    // key's dimensions to the add_thread id.
    if (candidate.type === PLUGIN_THREADS_EVENT_TYPES.candidate) {
      const detail = candidate.detail as
        | { id?: string; input?: { plugin?: string; file?: string; hash?: string; space?: string } }
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
          ...(detail.input.space === undefined ? {} : { space: detail.input.space }),
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
        if (thread && verdictOk) addThreads([thread])
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
    if (candidate.type === FACULTY_MESSAGE_KINDS.remote_system_two_request_result) {
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
        if (detail?.ok === true && thread && detail.result?.ok === true) {
          // The verdict is the candidate record — emitted ALWAYS: with the
          // judgment pack mounted it is the judge's trigger (the block-then-
          // judge path); with only the structural review pack mounted it
          // finds no consumer and the review pack's own verdict threads map
          // THIS selection to thread_admission / thread_admission_rejected —
          // the outcome legs above own the write. The id stays registered
          // until the outcome.
          addThreads([
            {
              label: `thread-candidate:${id}`,
              once: true,
              rules: [
                {
                  request: {
                    type: ADMISSION_EVENT_TYPES.candidate,
                    detail: { id, thread: thread as unknown as JsonObject },
                  },
                },
              ],
            },
          ])
        } else {
          // The rejection is data — the requester reads the why from the
          // verdict trace. A plugin-threads candidate's in-run decided key
          // records here (the durable record is the entry's).
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
    // backstop, no remoteSystemTwo judgment needed for host-authored threads. The
    // mint is the re-entry: addThreads pumps the super-step, so the minted
    // scale-issue request runs in the same wave as the ingress. The switch
    // is the host's ui pack itself: the mint fires iff a `ui/`-labeled pack
    // is among the mounted threads (the ui key dissolved into the array).
    if (
      hostThreads.some((t) => t.label.startsWith('ui/')) &&
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
    const event = { type: candidate.type, detail: candidate.detail, space: candidate.space } as BPEvent
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
      remoteSystemTwo.terminate()
      systemOne.terminate()
      systemTwo.terminate()
      for (const lane of actuatorLanes) lane.terminate()
    },
  }
}
