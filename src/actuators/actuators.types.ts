import type { JsonObject, Thread } from '../behavioral/behavioral.types.ts'
import type { ACTUATOR_MESSAGE_KINDS } from './actuators.constants.ts'

/*
 * Actuator event-wire vocabulary — the request/result event types the
 * actuator processes speak, the uniform result envelope, and the spawn
 * wiring's thread-mount signature.
 *
 * Behavioral defines the protocol; actuator processes adapt to speak it. These
 * are the events the router moves between the engine port and the satellite
 * actuator ports — the engine itself is generic over BPEvent and never imports
 * these.
 *
 * Shape rules settled in the router design:
 * - correlation id lives INSIDE `detail` (no wire envelope) — threads match
 *   their results via listener `detailSchema` on `detail.id`
 * - requests carry `{ id, input }` (the shell actuator adds an optional
 *   `label`); results carry `{ id, result }`; cancels `{ id }`
 * - `input`/`result` are loose JsonObject payloads: their strict schemas keep
 *   their one home in the actuator modules (no cross-module drift)
 * - `ingress` never survives the boundary: routed events are synthesized by
 *   actuator files, and `additionalProperties: false` rejects its presence —
 *   so the field is deliberately absent from the types
 *
 * @public
 */

export type ShellRequestEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.shell_request
  /** `label` is an optional trace annotation (logical names like 'skill-scan') — no routing weight. */
  /** `ctx` is the optional out-of-band join lane (the you.com MCP `_meta` pattern): orchestration state riding beside `input`, echoed verbatim on the result — never a model-facing field. */
  detail: { id: string; label?: string; ctx?: JsonObject; input: JsonObject }
  space?: string
}

export type ShellRequestResultEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.shell_request_result
  detail: WorkerResultDetail
  space?: string
}

export type ShellCancelEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.shell_cancel
  detail: { id: string }
  space?: string
}

/**
 * The uniform result detail — every actuator's `*_result` event carries this
 * two-branch shape (modified-B envelope, ruled 2026-09-21): the `ok`
 * discriminant sits at detail level beside the correlation id; `result` and
 * `error` are XOR branches (oneOf on the ok const). Actuator statuses ride as
 * `error.code` (the shell rpc's typed `credential_required` included —
 * first-class preserved, its request echo rides inside `error`); success
 * payloads ride `result` verbatim. Uniform gate across every actuator:
 * `select($d.ok)`.
 */
export type WorkerResultOk = {
  id: string
  ok: true
  result: JsonObject
  /** The request's `ctx`, echoed verbatim by actuators that pass it through (shell). */
  ctx?: JsonObject
}

export type WorkerResultError = {
  id: string
  ok: false
  /** The actuator failure payload — code (the actuator status enum), message, and any diagnostics. */
  error: { code: string; message?: string } & JsonObject
  /** The request's `ctx`, echoed verbatim by actuators that pass it through (shell). */
  ctx?: JsonObject
}

/** The `detail` of every `*_result` event — one shape across the actuators. */
export type WorkerResultDetail = WorkerResultOk | WorkerResultError

export type FacultyErrorEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.faculty_error
  detail: { faculty: string; message: string }
  space?: string
}

/** Store operations — durable, space-scoped persistence for data that must survive invocations. */
export type StoreOp = 'put' | 'get' | 'delete' | 'query'

export type StoreRequestEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.store_request
  /** `op` selects the store operation; the backing schema lives inside the worker — schema churn never becomes protocol churn. */
  /** `ctx` is the optional out-of-band join lane (the you.com MCP `_meta` pattern): orchestration state riding beside `input`, echoed verbatim on the result — never a model-facing field. */
  detail: { id: string; op: StoreOp; ctx?: JsonObject; input: JsonObject }
  space?: string
}

// No store cancel: ops are short-lived (frontier rule).
export type StoreRequestResultEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.store_request_result
  detail: WorkerResultDetail
  space?: string
}

/** Security operations — credential vending for remote servers (broker first, keychain floor second). */
export type SecurityRequestEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.credential_request
  /** `ctx` is the optional host-supplied binding (e.g. the resolved AS issuer) — out-of-band, never a model-facing input field. */
  detail: { id: string; ctx?: JsonObject; input: JsonObject }
  space?: string
}

export type SecurityRequestResultEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.credential_result
  detail: WorkerResultDetail
  space?: string
}

// A vend is a quick broker/keychain read, but a down broker can hang — the
// async actuators keep their cancels (shell, security).
export type SecurityCancelEvent = {
  type: typeof ACTUATOR_MESSAGE_KINDS.credential_cancel
  detail: { id: string }
  space?: string
}

/** The spawn wiring's thread-mount signature — the actuator lane's re-entry law. */
export type AddThreads = (newThreads: Thread[]) => void
