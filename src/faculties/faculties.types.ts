import type { JSONSchemaType } from 'ajv'
import type { BPEvent } from '../behavioral/behavioral.types.ts'
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
export type FrontierAnalysisOp = 'replay' | 'explore' | 'verify' | 'add_thread'

export type FrontierAnalysisRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.frontier_analysis_request
  /** `op` selects the analysis; the worker shares no event types with the tools faculty. */
  detail: { id: string; op: FrontierAnalysisOp; input: JsonObject }
  space?: string
}

export type FrontierAnalysisRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.frontier_analysis_request_result
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
// ── The transform faculty (the fixed fourth lane) — the evaluation wire ─────

/**
 * Machine-readable reasons a transform contract failed to produce its target
 * event. The engine never throws for these — each becomes the failure branch
 * of a `transform_request_result` and the target never fires.
 *
 * MOVED HOME (the transform-faculty ruling): this was
 * `behavioral.types.ts`'s evaluation vocabulary; evaluation leaves the engine
 * for the fixed fourth faculty, so the wire home owns it. The retired
 * SAB-bridge reasons (`jq_unavailable` — the no-SharedArrayBuffer floor,
 * `output_too_large` — the shared-buffer cap) die with the bridge at the
 * engine switch.
 */
export type TransformFailureReason =
  /** jq exited non-zero with stderr (`JqError`) — bad query or runtime failure */
  | 'jq_error'
  /** the matched event carried no detail to query */
  | 'no_detail'
  /** the query produced no output (`first()` returns `undefined`) */
  | 'empty_output'
  /** the query output was not an object (scalar, array, or null) */
  | 'non_object_output'
  /** the eval was killed at the timeout — a never-terminating query */
  | 'jq_timeout'
  /** the evaluated value exceeded the shared-buffer result cap (the bridge's dying reason) */
  | 'output_too_large'
  /** the host realm has no SharedArrayBuffer (not crossOriginIsolated) — the bridge stays down (the bridge's dying reason) */
  | 'jq_unavailable'

/**
 * The result of a transform evaluation — the whole first output, parsed, or
 * a machine-readable failure reason. Never thrown; the transform faculty's
 * result detail is exactly this plus the correlation id and the ctx echo.
 */
export type TransformEvaluation =
  | { ok: true; value: JsonObject }
  | { ok: false; reason: TransformFailureReason; stderr?: string; exitCode?: number }

/**
 * Structural schema for the transform evaluation — the wire result's failure
 * division and the faculty's evaluation contract (one home; moved verbatim
 * from the engine's `behavioral.types.ts`). Hand-written `oneOf` on the `ok`
 * discriminant; the `value` branch is the JsonObject floor, mirroring the
 * worker's own object check. Strict `additionalProperties: false` at every
 * level; no defaults (the strict-mode oneOf conflict does not apply).
 */
export const TransformEvaluationSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [true], description: 'True — the transform produced a value.' },
        value: {
          type: 'object',
          required: [],
          additionalProperties: true,
          description: 'The parsed query output object.',
        },
      },
      required: ['ok', 'value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [false], description: 'False — the transform failed; see reason.' },
        reason: {
          type: 'string',
          enum: ['jq_error', 'no_detail', 'empty_output', 'non_object_output', 'jq_timeout', 'output_too_large'],
          description: 'Machine-readable failure reason; the engine never throws for these.',
        },
        stderr: { type: 'string', nullable: true, description: 'jq stderr, present when reason is jq_error.' },
        exitCode: { type: 'integer', nullable: true, description: 'jq exit code, present when reason is jq_error.' },
      },
      required: ['ok', 'reason'],
      additionalProperties: false,
    },
  ],
} as unknown as JSONSchemaType<TransformEvaluation>

/** @internal Compiled once — the transform result guard. */
export const validateTransformEvaluation = ajv.compile(TransformEvaluationSchema)

/** The transform faculty's request — the evaluation ask (the idiom's data, correlated). */
export type TransformRequestEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.transform_request
  /** `detail` is the jq INPUT — the selected event's detail; absent means the event carried none (`no_detail`). `ctx` is the optional out-of-band join lane, echoed verbatim on the result. */
  detail: { id: string; query: string; target: string; ctx?: JsonObject; detail?: JsonObject }
  space?: string
}

export type TransformRequestResultEvent = {
  type: typeof FACULTY_MESSAGE_KINDS.transform_request_result
  /** The evaluation outcome joined to the correlation id — `TransformEvaluation` plus the optional `ctx` echo lane. */
  detail: { id: string; ctx?: JsonObject } & TransformEvaluation
  space?: string
}

const transformResultOkBranch = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: true },
    value: { type: 'object', required: [], additionalProperties: true },
    ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: ['id', 'ok', 'value'],
  additionalProperties: false,
} as const

const transformResultFailureBranch = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: false },
    reason: {
      type: 'string',
      enum: ['jq_error', 'no_detail', 'empty_output', 'non_object_output', 'jq_timeout'],
    },
    stderr: { type: 'string', nullable: true },
    exitCode: { type: 'integer', nullable: true },
    ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: ['id', 'ok', 'reason'],
  additionalProperties: false,
} as const

export const TransformRequestEventSchema: JSONSchemaType<TransformRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.transform_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        query: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        // The out-of-band join lane — its strict shape is the requesting side's.
        ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
        detail: { type: 'object', required: [], additionalProperties: true, nullable: true },
      },
      required: ['id', 'query', 'target'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const TransformRequestResultEventSchema: JSONSchemaType<TransformRequestResultEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.transform_request_result },
    detail: {
      type: 'object',
      oneOf: [transformResultOkBranch, transformResultFailureBranch],
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
} as unknown as JSONSchemaType<TransformRequestResultEvent>

export const validateTransformRequestEvent = ajv.compile(TransformRequestEventSchema)
export const validateTransformRequestResultEvent = ajv.compile(TransformRequestResultEventSchema)

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
  | FrontierAnalysisRequestEvent
  | FrontierAnalysisRequestResultEvent
  | StoreRequestEvent
  | StoreRequestResultEvent
  | TransformRequestEvent
  | TransformRequestResultEvent
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
export const FrontierAnalysisRequestEventSchema: JSONSchemaType<FrontierAnalysisRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: FACULTY_MESSAGE_KINDS.frontier_analysis_request },
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

export const FrontierAnalysisRequestResultEventSchema = resultEventSchema(
  FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
)

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
export const validateFrontierAnalysisRequestEvent = ajv.compile(FrontierAnalysisRequestEventSchema)
export const validateFrontierAnalysisRequestResultEvent = ajv.compile(FrontierAnalysisRequestResultEventSchema)
export const validateStoreRequestEvent = ajv.compile(StoreRequestEventSchema)
export const validateStoreRequestResultEvent = ajv.compile(StoreRequestResultEventSchema)

export type AddThreads = (newThreads: Thread[]) => void

/**
 * The faculty wire's line frame — one JSON line per event, the socket lane's
 * landed framing. THE shared home: the socket-lane client speaks it, and the
 * daemon's bridge speaks exactly it back (no second framing invented
 * server-side — both sides import this type).
 */
export type FacultyWireFrame = {
  type: string
  detail?: Record<string, unknown>
  space?: string
}

/**
 * The ruled four-key lane — what every faculty wiring returns (worker, spawn,
 * or socket). The composition routes on it; the wire home owns the shape.
 */
export type FacultyLane = {
  name: string
  send: (event: BPEvent) => void
  invalidEventGate: (event: BPEvent) => boolean
  terminate: () => void
}

/**
 * A pre-built lane builder: the host entry's `useWorker(...)` /
 * `socketLane(...)` return. The composition invokes it with its addThreads —
 * binding the lane's re-entries to the re-entry law — and owns the resulting
 * lifecycle.
 */
export type LaneBuilder = (addThreads: AddThreads) => FacultyLane
