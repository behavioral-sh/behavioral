import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject, type Thread } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from './faculties.constants.ts'

/*
 * Faculty event-wire vocabulary — every request/result event faculty plus validators.
 *
 * Behavioral defines the protocol; faculty processes adapt to speak it. These are
 * the events the router moves between the engine port and the satellite faculty
 * ports — the engine itself is generic over BPEvent and never imports these.
 *
 * Shape rules settled in the router design:
 * - correlation id lives INSIDE `detail` (no wire envelope) — threads match
 *   their results via listener `detailSchema` on `detail.id`
 * - requests carry `{ id, input }` (the shell faculty adds an optional `label`); results carry `{ id, result }`; cancels `{ id }`
 * - `input`/`result` are loose JsonObject payloads: their strict schemas keep
 *   their one home in the faculty modules (no cross-module drift)
 * - `ingress` never survives the boundary: routed events are synthesized by
 *   faculty files, and `additionalProperties: false` rejects its presence (proven in
 *   the spec) — so the field is deliberately absent from the types
 *
 * @public
 */

export type SystemTwoRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.system_two_request
  /** `ctx` is the optional out-of-band join lane (the you.com MCP `_meta` pattern): orchestration state riding beside `input`, echoed verbatim on the result — never a model-facing field. */
  detail: { id: string; ctx?: JsonObject; input: JsonObject }
  space?: string
}

export type SystemTwoRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.system_two_request_result
  detail: WorkerResultDetail
  space?: string
}

export type SystemTwoCancelEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.system_two_cancel
  detail: { id: string }
  space?: string
}

export type SystemOneRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.system_one_request
  detail: { id: string; input: JsonObject }
  space?: string
}

export type SystemOneRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.system_one_request_result
  detail: WorkerResultDetail
  space?: string
}

export type SystemOneCancelEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.system_one_cancel
  detail: { id: string }
  space?: string
}

export type ShellRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.shell_request
  /** `label` is an optional trace annotation (logical names like 'skill-scan') — no routing weight. */
  /** `ctx` is the optional out-of-band join lane (the you.com MCP `_meta` pattern): orchestration state riding beside `input`, echoed verbatim on the result — never a model-facing field. */
  detail: { id: string; label?: string; ctx?: JsonObject; input: JsonObject }
  space?: string
}

export type ShellRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.shell_request_result
  detail: WorkerResultDetail
  space?: string
}

export type ShellCancelEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.shell_cancel
  detail: { id: string }
  space?: string
}

/**
 * The uniform result detail — every faculty's `*_result` event carries this
 * two-branch shape (modified-B envelope, ruled 2026-09-21): the `ok`
 * discriminant sits at detail level beside the correlation id; `result` and
 * `error` are XOR branches (oneOf on the ok const). Faculty statuses ride as
 * `error.code` (the shell rpc's typed `credential_required` included —
 * first-class preserved, its request echo rides inside `error`); success
 * payloads ride `result` verbatim. Uniform gate across every faculty: `select($d.ok)`.
 */
export type WorkerResultOk = {
  id: string
  ok: true
  result: JsonObject
  /** The request's `ctx`, echoed verbatim by faculties that pass it through (shell). */
  ctx?: JsonObject
}

export type WorkerResultError = {
  id: string
  ok: false
  /** The faculty failure payload — code (the faculty status enum), message, and any diagnostics. */
  error: { code: string; message?: string } & JsonObject
  /** The request's `ctx`, echoed verbatim by faculties that pass it through (shell). */
  ctx?: JsonObject
}

/** The `detail` of every `*_result` event — one shape across all five faculties. */
export type WorkerResultDetail = WorkerResultOk | WorkerResultError

export type FacultyErrorEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.faculty_error
  detail: { faculty: string; message: string }
  space?: string
}

/** Frontier operations — its own worker faculty, like the responses client. */
export type FrontierOp = 'replay' | 'explore' | 'verify' | 'add_thread'

export type FrontierRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.frontier_request
  /** `op` selects the analysis; the worker shares no event types with the tools faculty. */
  detail: { id: string; op: FrontierOp; input: JsonObject }
  space?: string
}

export type FrontierRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.frontier_request_result
  detail: WorkerResultDetail
  space?: string
}

/** Store operations — durable, space-scoped persistence for data that must survive invocations. */
export type StoreOp = 'put' | 'get' | 'delete' | 'query'

export type StoreRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.store_request
  /** `op` selects the store operation; the backing schema lives inside the worker — schema churn never becomes protocol churn. */
  /** `ctx` is the optional out-of-band join lane (the you.com MCP `_meta` pattern): orchestration state riding beside `input`, echoed verbatim on the result — never a model-facing field. */
  detail: { id: string; op: StoreOp; ctx?: JsonObject; input: JsonObject }
  space?: string
}

// No store cancel: ops are short-lived (frontier rule).
export type StoreRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.store_request_result
  detail: WorkerResultDetail
  space?: string
}

/** Security operations — credential vending for remote servers (broker first, keychain floor second). */
export type SecurityRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.credential_request
  /** `ctx` is the optional host-supplied binding (e.g. the resolved AS issuer) — out-of-band, never a model-facing input field. */
  detail: { id: string; ctx?: JsonObject; input: JsonObject }
  space?: string
}

export type SecurityRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.credential_result
  detail: WorkerResultDetail
  space?: string
}

// A vend is a quick broker/keychain read, but a down broker can hang — the
// async faculties keep their cancels (shell, response, security).
export type SecurityCancelEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.credential_cancel
  detail: { id: string }
  space?: string
}

/** Union of every event the router can move between ports. @public */
export type WorkerEvent =
  | SystemTwoRequestEvent
  | SystemTwoRequestResultEvent
  | SystemTwoCancelEvent
  | SystemOneRequestEvent
  | SystemOneRequestResultEvent
  | SystemOneCancelEvent
  | ShellRequestEvent
  | ShellRequestResultEvent
  | ShellCancelEvent
  | SecurityRequestEvent
  | SecurityRequestResultEvent
  | SecurityCancelEvent
  | FrontierRequestEvent
  | FrontierRequestResultEvent
  | StoreRequestEvent
  | StoreRequestResultEvent
  | FacultyErrorEvent

const jsonObjectSchema = { type: 'object', required: [], additionalProperties: true } as const

// ── The uniform result envelope — one home, five consumers ──────────────────

const workerResultOkBranch = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: true },
    result: jsonObjectSchema,
    // The out-of-band join lane — its strict shape is the requesting side's
    // (the echo rides beside `ok`, the you.com MCP `_meta` pattern).
    ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: ['id', 'ok', 'result'],
  additionalProperties: false,
} as const

const workerResultErrorBranch = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string', nullable: true },
      },
      required: ['code'],
      // Faculty diagnostics ride along (request echoes, exit codes, stderr…).
      additionalProperties: true,
    },
    ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: ['id', 'ok', 'error'],
  additionalProperties: false,
} as const

/** Build one faculty's `*_result` event schema over the shared detail branches. */
const resultEventSchema = (typeConst: string) =>
  ({
    type: 'object',
    properties: {
      type: { type: 'string', const: typeConst },
      detail: { type: 'object', oneOf: [workerResultOkBranch, workerResultErrorBranch] },
      space: { type: 'string', nullable: true },
    },
    required: ['type', 'detail'],
    additionalProperties: false,
  }) as unknown as import('ajv').JSONSchemaType<{ type: string; detail: WorkerResultDetail; space?: string }>

export const SystemTwoRequestEventSchema: JSONSchemaType<SystemTwoRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.system_two_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        // The out-of-band join lane — strict shape is the requesting side's.
        ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
        input: jsonObjectSchema,
      },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const SystemTwoRequestResultEventSchema = resultEventSchema(FACULTY_MESSAGE_KINDS.system_two_request_result)

export const SystemTwoCancelEventSchema: JSONSchemaType<SystemTwoCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.system_two_cancel },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const SystemOneRequestEventSchema: JSONSchemaType<SystemOneRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.system_one_request },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, input: jsonObjectSchema },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const SystemOneRequestResultEventSchema = resultEventSchema(FACULTY_MESSAGE_KINDS.system_one_request_result)

export const SystemOneCancelEventSchema: JSONSchemaType<SystemOneCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.system_one_cancel },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ShellRequestEventSchema: JSONSchemaType<ShellRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.shell_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        label: { type: 'string', nullable: true },
        // The out-of-band join lane — strict shape is the requesting side's.
        ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
        input: jsonObjectSchema,
      },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ShellRequestResultEventSchema = resultEventSchema(FACULTY_MESSAGE_KINDS.shell_request_result)

export const ShellCancelEventSchema: JSONSchemaType<ShellCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.shell_cancel },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const SecurityRequestEventSchema: JSONSchemaType<SecurityRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.credential_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        // The host-supplied binding lane — its strict shape is the security
        // faculty's boundary (SecurityRequestContextSchema), not the wire's.
        ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
        input: jsonObjectSchema,
      },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const SecurityRequestResultEventSchema = resultEventSchema(FACULTY_MESSAGE_KINDS.credential_result)

export const SecurityCancelEventSchema: JSONSchemaType<SecurityCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.credential_cancel },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const FacultyErrorEventSchema: JSONSchemaType<FacultyErrorEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.faculty_error },
    detail: {
      type: 'object',
      properties: { faculty: { type: 'string' }, message: { type: 'string' } },
      required: ['faculty', 'message'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const validateSystemTwoRequestEvent = ajv.compile(SystemTwoRequestEventSchema)
export const validateSystemTwoRequestResultEvent = ajv.compile(SystemTwoRequestResultEventSchema)
export const validateSystemTwoCancelEvent = ajv.compile(SystemTwoCancelEventSchema)
export const validateSystemOneRequestEvent = ajv.compile(SystemOneRequestEventSchema)
export const validateSystemOneRequestResultEvent = ajv.compile(SystemOneRequestResultEventSchema)
export const validateSystemOneCancelEvent = ajv.compile(SystemOneCancelEventSchema)
export const validateShellRequestEvent = ajv.compile(ShellRequestEventSchema)
export const validateShellRequestResultEvent = ajv.compile(ShellRequestResultEventSchema)
export const validateShellCancelEvent = ajv.compile(ShellCancelEventSchema)
export const validateSecurityRequestEvent = ajv.compile(SecurityRequestEventSchema)
export const validateSecurityRequestResultEvent = ajv.compile(SecurityRequestResultEventSchema)
export const validateSecurityCancelEvent = ajv.compile(SecurityCancelEventSchema)
// No frontier cancel event: analyses are synchronous — nothing is in flight
// to abort (the async faculties keep their cancels).
export const FrontierRequestEventSchema: JSONSchemaType<FrontierRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.frontier_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        op: { type: 'string', enum: ['replay', 'explore', 'verify', 'add_thread'] },
        input: jsonObjectSchema,
      },
      required: ['id', 'op', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const FrontierRequestResultEventSchema = resultEventSchema(FACULTY_MESSAGE_KINDS.frontier_request_result)

// No store cancel: ops are short-lived (same rule as frontier).
export const StoreRequestEventSchema: JSONSchemaType<StoreRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.store_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        op: { type: 'string', enum: ['put', 'get', 'delete', 'query'] },
        // The out-of-band join lane — strict shape is the requesting side's.
        ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
        input: jsonObjectSchema,
      },
      required: ['id', 'op', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const StoreRequestResultEventSchema = resultEventSchema(FACULTY_MESSAGE_KINDS.store_request_result)

export const validateBehaviorErrorEvent = ajv.compile(FacultyErrorEventSchema)
export const validateFrontierRequestEvent = ajv.compile(FrontierRequestEventSchema)
export const validateFrontierRequestResultEvent = ajv.compile(FrontierRequestResultEventSchema)
export const validateStoreRequestEvent = ajv.compile(StoreRequestEventSchema)
export const validateStoreRequestResultEvent = ajv.compile(StoreRequestResultEventSchema)

export type AddThreads = (newThreads: Thread[]) => void
