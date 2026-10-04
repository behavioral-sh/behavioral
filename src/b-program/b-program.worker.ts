import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { ajv, type SelectionTrace, type Trace } from '../behavioral/behavioral.types.ts'
import {
  CONTROLLER_INCOMING_MESSAGE_TYPES,
  CONTROLLER_OUTGOING_MESSAGE_TYPES,
} from '../controller/controller.constants.ts'
import { FACULTY_MESSAGE_KINDS, ROOT_UMWELT } from '../faculties/faculties.constants.ts'
import {
  validateSecurityCancelEvent,
  validateSecurityRequestEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateStoreRequestEvent,
} from '../faculties/faculties.types.ts'
import { socketLane } from '../faculties/socket-lane.ts'
import { tracePipe } from '../faculties/trace-pipe.ts'
import { uuid } from '../utils.ts'
import { bProgram, type LaneBuilder } from './b-program.ts'
import {
  COMPOSITION_PORT_KINDS,
  type CompositionPortAttachFrame,
  CompositionPortAttachFrameSchema,
  type CompositionPortOutbound,
  type CompositionPortTraceSubscribeFrame,
  CompositionPortTraceSubscribeFrameSchema,
  traceUmweltOf,
} from './composition-port.ts'
import { watchPluginThreadRegistry } from './plugin-threads.registry.ts'
import { validateHelloDetail } from './runtime-identity.ts'
import { redactTrace } from './trace-redact.ts'

/*
 * The bProgram worker entry — the composition boots INSIDE a per-tab
 * dedicated module worker (the amended topology, pilot ruling 2026-09-28:
 * a SharedWorker realm in Chromium can neither spawn workers (`Worker is not
 * defined`) nor reach SharedArrayBuffer (never crossOriginIsolated), so the
 * ruled nested-worker placement is only satisfiable in a dedicated worker).
 *
 * This is the level-1 worker: a MODULE script (it needs `import.meta` URLs —
 * the faculty workers'). Every worker IT spawns is CLASSIC
 * (the nested module-worker failure is silent in the WebView's Chromium) —
 * the fixed FOUR faculty workers spawn through `useWorker` with the
 * bundler-visible `new Worker` literals inside `b-program.ts`.
 *
 * The message protocol (`composition-port.ts`), over the worker's own
 * channel — the page's `WorkerTransport` is the other end:
 *   - `attach` (with the page's umwelt and — optionally — the provider map +
 *     model identifiers) BOOTS the composition: the models become the
 *     faculties' init-frame payloads (`initData`), the data must exist
 *     before the faculty workers spawn. The `hello` frame (the validated
 *     engine identity + the page's umwelt) answers.
 *   - ingress: the controller's ClientMessages ride raw (`ui_event` triggers
 *     its `detail.event`; every other `ui_*` type triggers as
 *     `{ type, detail }` — the dispatchToRuntime semantics) and are FORCIBLY
 *     stamped with the attached umwelt (a tab cannot impersonate another
 *     umwelt — structural in the dedicated-worker topology).
 *   - egress: ONE full-fidelity trace stream, REDACTED in-worker (the
 *     sanitize step IS the redaction pass), filterable by kind
 *     (`trace_subscribe`). Root-umwelt traces always deliver; umwelt-stamped
 *     traces deliver when they match the attached umwelt. A `ui_*` selection
 *     additionally leaves as a `message` frame (a controller ServerMessage)
 *     — the egress-as-selection lane, mirrored from serve.ts.
 *
 * The actuator leg: the entry takes PRE-BUILT lane builders (over an
 * injected Transport — the socket lane's default lands with Slice 3; no
 * default here). Absent actuators means the engine runs without environment
 * access — the faculty calls answer the typed error, fail-visible.
 *
 * MINIMAL: the redaction pass deep-clones every trace (no batching — the
 * amended ruling's no-batching point); upgrade path if it shows: a filter
 * before the clone (kind/umwelt are knowable pre-redaction). Traces emitted
 * before the page's `trace_subscribe` are not replayed — the stream starts
 * at subscription (the daemon-pipe slice re-points persistence, where the
 * full stream lives).
 */

/** The daemon bridge's conventional WS path — the thin faculty host serves the faculty wire here. */
export const DAEMON_BRIDGE_PATH = '/faculty-wire'

/** The worker-scope origin as a ws(s) URL — empty where no location exists (a Bun worker). */
const bridgeOrigin = (): string => (typeof location === 'undefined' ? '' : `${location.origin.replace(/^http/, 'ws')}`)

/**
 * The DEFAULT actuator leg: the trio over the socket lane, pointed at the
 * daemon bridge (the thin faculty host — later work; this lands DARK: the
 * lanes construct at boot but connect only when a request routes, so an
 * unused leg never opens a socket). Tauri/native-bridge transports swap
 * behind the same LaneBuilder interface.
 */
export const defaultActuatorLanes = (url: string | (() => string)): LaneBuilder[] => [
  socketLane({
    url,
    name: 'shell',
    validateRequest: validateShellRequestEvent,
    validateCancel: validateShellCancelEvent,
    resultKind: FACULTY_MESSAGE_KINDS.shell_request_result,
  }),
  socketLane({
    url,
    name: 'store',
    validateRequest: validateStoreRequestEvent,
    resultKind: FACULTY_MESSAGE_KINDS.store_request_result,
  }),
  socketLane({
    url,
    name: 'security',
    validateRequest: validateSecurityRequestEvent,
    validateCancel: validateSecurityCancelEvent,
    resultKind: FACULTY_MESSAGE_KINDS.credential_result,
  }),
]

/** The entry's compile-time options — the runtime data (models) rides the attach frame. */
export type CompositionWorkerOptions = {
  /** Host-minted policy packs (shell, rpc-auth, remote-mcp, plugin-threads, supervision, ui_*). */
  threads?: Parameters<typeof bProgram>[0]['threads']
  /**
   * The pre-built actuator lane builders — reachability is construction, never
   * config. Absent = the default socket-lane trio over the daemon bridge; an
   * EXPLICIT empty array means the engine alone.
   */
  actuators?: LaneBuilder[]
}

type Runtime = ReturnType<typeof bProgram>

/** The trace stream's per-worker subscription: attached (umwelt) + kind filter. */
type TraceSubscription = { umwelt?: string; kinds?: Set<string> }

/** The worker's own global message surface (DedicatedWorkerGlobalScope, typed minimally). */
const workerSelf = self as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent) => void) | null
}

/**
 * Run the composition worker: wire the message protocol; the composition
 * boots on the first `attach` (the models ride the attach frame — the
 * faculties' init-frame payloads must exist before the faculty workers
 * spawn). The egress subscription is attached BEFORE `start()` (the
 * boot-order law — boot traces are observable). The entry is a
 * dedicated-worker script — the browser calls this once per worker.
 */
export const runCompositionWorker = ({ threads = [], actuators }: CompositionWorkerOptions = {}): void => {
  const laneBuilders = actuators ?? defaultActuatorLanes(() => `${bridgeOrigin()}${DAEMON_BRIDGE_PATH}`)
  // The trace leg (the one-observability-stream ruling): armed when the
  // actuator leg is the DEFAULT socket-lane trio (the daemon bridge is this
  // worker's environment) — the worker's redacted stream pushes upstream,
  // folding into the daemon's one observability stream. Scoped by
  // construction: the pipe connects to the session-gated bridge; no token
  // rides any frame (the browser attaches the cookie). A fixture-provided
  // actuator leg has no daemon bridge — no pipe.
  const pipe = actuators === undefined ? tracePipe({ url: () => `${bridgeOrigin()}${DAEMON_BRIDGE_PATH}` }) : undefined
  const validateAttach = ajv.compile(CompositionPortAttachFrameSchema)
  const validateSubscribe = ajv.compile(CompositionPortTraceSubscribeFrameSchema)
  const subscription: TraceSubscription = {}
  let runtime: Runtime | undefined

  /** One outbound frame — never throws into the trace publisher. */
  const post = (frame: CompositionPortOutbound): void => {
    try {
      workerSelf.postMessage(frame)
    } catch (error) {
      // A dead channel (closed tab) is not a composition failure.
      console.warn('[composition-worker] postMessage failed:', error)
    }
  }

  /**
   * Boot the composition: the attach's models become the faculties'
   * init-frame payloads; the egress subscription attaches before `start()`.
   * Idempotent — the first attach wins (a re-attach re-hellos, never
   * re-boots).
   */
  const boot = (models: Parameters<typeof bProgram>[0]['models']): Runtime => {
    if (runtime !== undefined) return runtime
    // (The boot reconciliation pack does NOT mount here: its joins are jq
    // transforms, and the transform faculty is not yet wired in the BUNDLED
    // composition's serving seam — the pack mounts DAEMON-ONLY until the
    // serving-side story lands. The transform faculty itself rides the
    // bundle gate by construction.)
    const booted = bProgram({ threads, models, actuators: laneBuilders })
    // The registry's durable-write legs — over the default leg's socket-lane
    // store (queue-before-open covers the boot window; a fixture-provided
    // actuator leg has no known store lane — no watcher, the trace-pipe
    // precedent). No exit exists in-browser; the flush gate is a daemon
    // concern.
    if (actuators === undefined) watchPluginThreadRegistry({ runtime: booted })
    booted.useTrace((trace: Trace) => {
      // The upstream trace leg pushes the full redacted stream (the daemon is
      // the persistence home — full fidelity, independent of the page's
      // subscription).
      pipe?.push(redactTrace(trace))
      if (subscription.umwelt === undefined) return // attach is the admission
      if (subscription.kinds !== undefined && !subscription.kinds.has(trace.kind)) return
      const redacted = redactTrace(trace)
      const umwelt = traceUmweltOf(redacted)
      if (umwelt !== ROOT_UMWELT && umwelt !== subscription.umwelt) return
      post({ kind: COMPOSITION_PORT_KINDS.trace, trace: redacted })
      // Egress-as-selection: a `ui_*` selection is a controller ServerMessage.
      // (The ui threads produce conforming details; the relay is dumb — the
      // root guard threads are the schema gate both directions.)
      if (redacted.kind === TRACE_MESSAGE_KINDS.selection) {
        const selected = (redacted as SelectionTrace).selected
        if ((Object.values(CONTROLLER_INCOMING_MESSAGE_TYPES) as string[]).includes(selected.type)) {
          post({
            kind: COMPOSITION_PORT_KINDS.message,
            message: { type: selected.type, detail: selected.detail } as never,
          })
        }
      }
    })
    booted.start()
    runtime = booted
    return booted
  }

  /** Ingress: one message → attach/subscribe frame or a controller trigger. */
  const onMessage = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return
    const frame = data as Record<string, unknown>
    if (frame.kind === COMPOSITION_PORT_KINDS.attach) {
      if (!validateAttach(frame)) return // fail closed: a malformed attach gets no hello
      const attach = frame as CompositionPortAttachFrame
      subscription.umwelt = attach.umwelt ?? `tab_${uuid()}`
      const booted = boot(attach.models ?? {})
      // The hello: the composition's engine identity + this page's umwelt.
      // Fail closed — the worker never sends an unvalidated identity frame.
      if (validateHelloDetail(booted.identity)) {
        post({
          kind: COMPOSITION_PORT_KINDS.hello,
          umwelt: subscription.umwelt,
          identity: booted.identity,
        })
      } else {
        console.error('[composition-worker] runtime identity failed its schema — no hello sent')
      }
      return
    }
    if (frame.kind === COMPOSITION_PORT_KINDS.trace_subscribe) {
      if (!validateSubscribe(frame)) return
      const kinds = (frame as CompositionPortTraceSubscribeFrame).kinds
      subscription.kinds = kinds === undefined ? undefined : new Set(kinds)
      return
    }
    // The controller's ingress: ClientMessages ride raw. The attached umwelt
    // WINS — an attached tab cannot impersonate another umwelt.
    const type = frame.type
    if (typeof type !== 'string' || !(Object.values(CONTROLLER_OUTGOING_MESSAGE_TYPES) as string[]).includes(type))
      return
    if (subscription.umwelt === undefined) return // never attached
    if (type === CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_event) {
      const detail = frame.detail as { event?: { type?: string } } | undefined
      const event = detail?.event
      if (typeof event?.type !== 'string') return
      runtime?.trigger({ ...event, umwelt: subscription.umwelt } as never)
      return
    }
    runtime?.trigger({ type, detail: frame.detail, umwelt: subscription.umwelt } as never)
  }

  workerSelf.onmessage = (event: MessageEvent) => {
    try {
      onMessage(event.data)
    } catch (error) {
      // One bad frame must not kill the message loop.
      console.warn('[composition-worker] message failed:', error)
    }
  }
}
