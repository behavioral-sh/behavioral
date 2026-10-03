import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { JsonObject, Trace } from '../behavioral/behavioral.types.ts'
import type { ClientMessage, ServerMessage } from '../controller/controller.types.ts'
import { ROOT_SPACE } from '../faculties/faculties.constants.ts'
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
 * redacted trace stream per worker, filterable by kind, space-isolated per
 * attach (root-space traces broadcast; stamped traces deliver to the owning
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

/** Page → worker: claim the page's space and (optionally) hand the model identifiers. */
export type CompositionPortAttachFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.attach
  space?: string
  models?: CompositionPortModels
}

/** Page → worker: scope the trace stream. Omitted kinds = all (full fidelity). */
export type CompositionPortTraceSubscribeFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.trace_subscribe
  kinds?: string[]
}

/** Worker → page: the attach's answer — the engine identity + the page's space. */
export type CompositionPortHelloFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.hello
  space: string
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
    space: { type: 'string', nullable: true },
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
 * A trace's best-effort space — the same resolution the log sink's path uses:
 * a top-level space, else the selection's/interrupt's, else a thread_added's,
 * else root. Root-space traces broadcast to every attached page; space-stamped
 * traces deliver only to the owning attach (the space-per-tab isolation).
 */
export const traceSpaceOf = (trace: Trace): string => {
  const direct = (trace as { space?: unknown }).space
  if (typeof direct === 'string') return direct
  if (trace.kind === TRACE_MESSAGE_KINDS.selection || trace.kind === TRACE_MESSAGE_KINDS.interrupt) {
    return (trace as { selected?: { space?: string } }).selected?.space ?? ROOT_SPACE
  }
  if (trace.kind === TRACE_MESSAGE_KINDS.thread_added)
    return (trace as { thread?: { space?: string } }).thread?.space ?? ROOT_SPACE
  return ROOT_SPACE
}
