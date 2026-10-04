import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { JsonObject, Trace } from '../behavioral/behavioral.types.ts'
import type { ClientMessage, ServerMessage } from '../controller/controller.types.ts'
import { ROOT_UMWELT } from '../faculties/faculties.constants.ts'
import type { SystemTwoEndpointConfig } from '../faculties/system-two.types.ts'
import { keyMirror } from '../utils.ts'
import type { RuntimeIdentity } from './runtime-identity.ts'

/**
 * The composition port vocabulary — the message protocol between the
 * bProgram worker entry (`b-program.worker.ts`, the per-tab dedicated
 * worker) and a page's controller transport (`src/controller/
 * worker-transport.ts`). Browser-neutral: the worker and the page bundle
 * both import it, so it carries zero host builtins and NO ajv — the
 * page-side controller bundle compiles no schemas (the controller's
 * dumb-relay floor); the worker validates its inbound frames (the schemas
 * live here as data and compile beside `b-program.worker.ts`'s wiring).
 *
 * @remarks
 * Frames are discriminated: control frames carry `kind`, the controller's
 * ingress/egress messages ride their own unions (a `ClientMessage` arrives
 * raw; a `ServerMessage` leaves wrapped in a `message` frame). Ingress
 * (`ui_*`/trigger semantics) mirrors `dispatchToRuntime`'s raw-ClientMessage
 * shape; egress is the AMENDED observability ruling — ONE full-fidelity
 * redacted trace stream per worker, filterable by kind, umwelt-isolated per
 * attach (root-umwelt traces broadcast; stamped traces deliver to the owning
 * attach only).
 *
 * @public
 */

/** The port frame discriminants (control frames only; messages ride raw). */
export const COMPOSITION_PORT_KINDS = keyMirror('attach', 'hello', 'trace', 'message', 'trace_subscribe')

/**
 * The page's model identifiers — the init-frame payloads delivered to the
 * faculties at boot: `systemOne` endpoint config, `systemTwo` endpoints map
 * (per-provider `transport: 'rest' | 'webgpu'`), the `ui` generation target.
 * The provider map + model identifiers ARE the faculties' `initData`.
 */
export type CompositionPortModels = {
  systemOne?: JsonObject
  systemTwo?: JsonObject
  ui?: { provider?: string; modelId?: string }
}

/** Page → worker: claim the page's umwelt and (optionally) hand the model identifiers. */
export type CompositionPortAttachFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.attach
  umwelt?: string
  models?: CompositionPortModels
}

// ---------------------------------------------------------------------------
// The provider plan — the inference transport's browser construction
// ---------------------------------------------------------------------------

/**
 * The proxy route prefix — `POST /v1/inference/<provider>/<path>` (the
 * daemon's provider-shaped inference routes). Defined HERE because the
 * browser-side construction derives proxy URLs from it; the daemon's
 * serving side imports the same constant (the serving contract's paths,
 * same spirit as `B_PROGRAM_WORKER_PATH`).
 */
export const INFERENCE_PROXY_PREFIX = '/v1/inference/'

/**
 * One provider plan entry — what the attach frame carries per provider:
 * the transport decision (+ the local model id for webgpu). No URLs, no
 * credentials — the browser constructs the endpoints from the plan.
 */
export type SystemTwoProviderPlanEntry = {
  transport?: 'rest' | 'webgpu'
  /** Webgpu transport only — the local model id. */
  model?: string
}

/** Provider label → plan entry. The attach frame's systemTwo plan shape. */
export type SystemTwoProviderPlan = Record<string, SystemTwoProviderPlanEntry>

/**
 * The browser-side construction of system-two's initData provider map (the
 * inference-transport ruling): static-key vendors become the daemon's proxy
 * routes (`${INFERENCE_PROXY_PREFIX}<label>` — the key attaches daemon-side
 * and never enters a browser context; relative URLs resolve against the
 * worker's same-origin script URL); webgpu entries pass through verbatim
 * (local compute, no network, no credential). No `apiKey` field is ever
 * produced — the type's optionality is for daemon-vended short-lived
 * tokens only.
 */
export const systemTwoEndpointsFromPlan = (plan: SystemTwoProviderPlan): Record<string, SystemTwoEndpointConfig> =>
  Object.fromEntries(
    Object.entries(plan).map(([label, entry]) => [
      label,
      entry.transport === 'webgpu'
        ? { transport: 'webgpu', ...(entry.model === undefined ? {} : { model: entry.model }) }
        : { url: `${INFERENCE_PROXY_PREFIX}${label}` },
    ]),
  )

/** Page → worker: scope the trace stream. Omitted kinds = all (full fidelity). */
export type CompositionPortTraceSubscribeFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.trace_subscribe
  kinds?: string[]
}

/** Worker → page: the attach's answer — the engine identity + the page's umwelt. */
export type CompositionPortHelloFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.hello
  umwelt: string
  identity: RuntimeIdentity
}

/** Worker → page: one redacted trace of the page's subscribed stream. */
export type CompositionPortTraceFrame = { kind: typeof COMPOSITION_PORT_KINDS.trace; trace: Trace }

/** Worker → page: a `ui_*` selection as a controller ServerMessage. */
export type CompositionPortMessageFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.message
  message: ServerMessage
}

/** Everything the composition worker may receive from the page. */
export type CompositionPortInbound = CompositionPortAttachFrame | CompositionPortTraceSubscribeFrame | ClientMessage

/** Everything the composition worker may deliver to the page. */
export type CompositionPortOutbound =
  | CompositionPortHelloFrame
  | CompositionPortTraceFrame
  | CompositionPortMessageFrame

/**
 * The inbound frame schemas — data here, compiled at the worker (the
 * page→worker trust edge; the page bundle carries no ajv).
 */
export const CompositionPortAttachFrameSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: COMPOSITION_PORT_KINDS.attach },
    umwelt: { type: 'string', nullable: true },
    models: { type: 'object', nullable: true },
  },
  required: ['kind'],
  additionalProperties: false,
} as const

export const CompositionPortTraceSubscribeFrameSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: COMPOSITION_PORT_KINDS.trace_subscribe },
    kinds: { type: 'array', items: { type: 'string' }, nullable: true },
  },
  required: ['kind'],
  additionalProperties: false,
} as const

/**
 * A trace's best-effort umwelt — the same resolution the log sink's path uses:
 * a top-level umwelt, else the selection's/interrupt's, else a thread_added's,
 * else root. Root-umwelt traces broadcast to every attached page; umwelt-stamped
 * traces deliver only to the owning attach (the umwelt-per-tab isolation).
 */
export const traceUmweltOf = (trace: Trace): string => {
  const direct = (trace as { umwelt?: unknown }).umwelt
  if (typeof direct === 'string') return direct
  if (trace.kind === TRACE_MESSAGE_KINDS.selection || trace.kind === TRACE_MESSAGE_KINDS.interrupt) {
    return (trace as { selected?: { umwelt?: string } }).selected?.umwelt ?? ROOT_UMWELT
  }
  if (trace.kind === TRACE_MESSAGE_KINDS.thread_added || trace.kind === TRACE_MESSAGE_KINDS.thread_removed)
    return (trace as { thread?: { umwelt?: string } }).thread?.umwelt ?? ROOT_UMWELT
  return ROOT_UMWELT
}
