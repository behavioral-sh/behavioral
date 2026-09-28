import type { JSONSchemaType } from 'ajv'
import { ajv } from '../behavioral/behavioral.types.ts'
import { ACTUATOR_MESSAGE_KINDS } from './actuators.constants.ts'
import type {
  FacultyErrorEvent,
  SecurityCancelEvent,
  SecurityRequestEvent,
  ShellCancelEvent,
  ShellRequestEvent,
  StoreRequestEvent,
  WorkerResultDetail,
} from './actuators.types.ts'

/*
 * The actuator event-wire schemas — the request/cancel/result triples the
 * actuator processes speak, AJV-compiled once here. The actuator-owned copy
 * of the wire home's actuator half; the values are the wire's, byte-identical
 * on both sides of the boundary.
 *
 * @public
 */

const jsonObjectSchema = { type: 'object', required: [], additionalProperties: true } as const

// ── The uniform result envelope ──────────────────────────────────────────────

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
      // Actuator diagnostics ride along (request echoes, exit codes, stderr…).
      additionalProperties: true,
    },
    ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: ['id', 'ok', 'error'],
  additionalProperties: false,
} as const

/** Build one actuator's `*_result` event schema over the shared detail branches. */
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
  }) as unknown as JSONSchemaType<{ type: string; detail: WorkerResultDetail; space?: string }>

// ── Shell ────────────────────────────────────────────────────────────────────

export const ShellRequestEventSchema: JSONSchemaType<ShellRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: ACTUATOR_MESSAGE_KINDS.shell_request },
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

export const ShellRequestResultEventSchema = resultEventSchema(ACTUATOR_MESSAGE_KINDS.shell_request_result)

export const ShellCancelEventSchema: JSONSchemaType<ShellCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: ACTUATOR_MESSAGE_KINDS.shell_cancel },
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

// ── Store ────────────────────────────────────────────────────────────────────

// No store cancel: ops are short-lived (frontier rule).
export const StoreRequestEventSchema: JSONSchemaType<StoreRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: ACTUATOR_MESSAGE_KINDS.store_request },
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

export const StoreRequestResultEventSchema = resultEventSchema(ACTUATOR_MESSAGE_KINDS.store_request_result)

// ── Security ─────────────────────────────────────────────────────────────────

export const SecurityRequestEventSchema: JSONSchemaType<SecurityRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: ACTUATOR_MESSAGE_KINDS.credential_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        // The host-supplied binding lane — its strict shape is the security
        // actuator's boundary (SecurityRequestContextSchema), not the wire's.
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

export const SecurityRequestResultEventSchema = resultEventSchema(ACTUATOR_MESSAGE_KINDS.credential_result)

// A vend is a quick broker/keychain read, but a down broker can hang — the
// async actuators keep their cancels (shell, security).
export const SecurityCancelEventSchema: JSONSchemaType<SecurityCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: ACTUATOR_MESSAGE_KINDS.credential_cancel },
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

// ── The crash event ──────────────────────────────────────────────────────────

export const FacultyErrorEventSchema: JSONSchemaType<FacultyErrorEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: ACTUATOR_MESSAGE_KINDS.faculty_error },
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

// ── The once-compiled validators ─────────────────────────────────────────────

export const validateShellRequestEvent = ajv.compile(ShellRequestEventSchema)
export const validateShellRequestResultEvent = ajv.compile(ShellRequestResultEventSchema)
export const validateShellCancelEvent = ajv.compile(ShellCancelEventSchema)
export const validateStoreRequestEvent = ajv.compile(StoreRequestEventSchema)
export const validateStoreRequestResultEvent = ajv.compile(StoreRequestResultEventSchema)
export const validateSecurityRequestEvent = ajv.compile(SecurityRequestEventSchema)
export const validateSecurityRequestResultEvent = ajv.compile(SecurityRequestResultEventSchema)
export const validateSecurityCancelEvent = ajv.compile(SecurityCancelEventSchema)
export const validateBehaviorErrorEvent = ajv.compile(FacultyErrorEventSchema)
