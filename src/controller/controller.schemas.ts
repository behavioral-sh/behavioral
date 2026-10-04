import type { JSONSchemaType } from 'ajv'
import { ajv, BPEventSchema } from '../behavioral/behavioral.types.ts'
import {
  CONTROLLER_INCOMING_MESSAGE_TYPES,
  CONTROLLER_OUTGOING_MESSAGE_TYPES,
  PAGE_EVENTS,
  SCALE,
  SWAP_MODES,
} from './controller.constants.ts'
import type {
  AttrsMessage,
  DispatchCustomEventMessage,
  ErrorMessage,
  FormSubmitMessage,
  NavigateMessage,
  PageSnapshot,
  RenderMessage,
  ScaleCheckMessage,
  ScaleCheckResultMessage,
  SuccessMessage,
  UiEventMessage,
} from './controller.types.ts'

/**
 * AJV schemas for the controller message **details** — the `ui_*` wire shapes.
 *
 * @remarks
 * The controller itself is validation-free (a dumb relay); these schemas are the
 * runtime gate, consumed by the behavioral threads that `block` malformed
 * messages in or out and by the CLI's `--schema` reflection. Kept in a separate
 * file from {@link ./controller.types.ts} so the browser bundle never pulls AJV:
 * the frontend imports the types, the host/threads import the schemas.
 *
 * @packageDocumentation
 */

/**
 * The `target` constraint — the selector sites' slug floor (the
 * #style-deletion ruling): targets are `b-target` attribute VALUES feeding
 * querySelectorAll in #render/#attrs/#scaleCheck — a slug-ish charset. The
 * `match` nuance rides the OPERATOR (a closed SelectorMatch enum), so this
 * pattern fights nothing.
 */
const TARGET_PATTERN = '^[A-Za-z][A-Za-z0-9_-]*$'

const MATCH = {
  type: 'string',
  enum: ['=', '~=', '|=', '^=', '$=', '*='],
  nullable: true,
} as const

const SWAP = { type: 'string', enum: Object.values(SWAP_MODES) } as const

export const RenderDetailSchema: JSONSchemaType<RenderMessage['detail']> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    target: { type: 'string', minLength: 1, pattern: TARGET_PATTERN },
    html: { type: 'string' },
    match: MATCH,
    swap: SWAP,
  },
  required: ['id', 'target', 'html', 'swap'],
  additionalProperties: false,
}

export const AttrsDetailSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    target: { type: 'string', minLength: 1, pattern: TARGET_PATTERN },
    match: MATCH,
    attr: {
      type: 'object',
      required: [],
      additionalProperties: {
        anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
      },
    },
  },
  required: ['id', 'target', 'attr'],
  additionalProperties: false,
} as unknown as JSONSchemaType<AttrsMessage['detail']>

export const NavigateDetailSchema: JSONSchemaType<NavigateMessage['detail']> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    replace: { type: 'boolean', nullable: true },
  },
  required: ['id', 'url'],
  additionalProperties: false,
}

export const DispatchCustomEventDetailSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    target: { type: 'string', minLength: 1, pattern: TARGET_PATTERN },
    event: BPEventSchema,
    bubbles: { type: 'boolean', nullable: true },
    cancelable: { type: 'boolean', nullable: true },
    composed: { type: 'boolean', nullable: true },
  },
  required: ['id', 'target', 'event'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DispatchCustomEventMessage['detail']>

export const ScaleCheckDetailSchema: JSONSchemaType<ScaleCheckMessage['detail']> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    target: { type: 'string', minLength: 1, pattern: TARGET_PATTERN },
    swap: SWAP,
    match: MATCH,
  },
  required: ['id', 'target', 'swap'],
  additionalProperties: false,
}

export const UiEventDetailSchema = {
  type: 'object',
  properties: {
    event: BPEventSchema,
    timeStamp: { type: 'number' },
  },
  required: ['event', 'timeStamp'],
  additionalProperties: false,
} as unknown as JSONSchemaType<UiEventMessage['detail']>

export const FormSubmitDetailSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', nullable: true },
    timeStamp: { type: 'number' },
    action: { type: 'string', nullable: true },
    data: {
      type: 'object',
      required: [],
      additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      nullable: true,
    },
  },
  required: ['timeStamp'],
  additionalProperties: false,
} as unknown as JSONSchemaType<FormSubmitMessage['detail']>

export const SnapshotDetailSchema: JSONSchemaType<PageSnapshot['detail']> = {
  type: 'object',
  properties: {
    timeStamp: { type: 'number' },
    type: { type: 'string', enum: Object.values(PAGE_EVENTS) },
    serializedHTML: { type: 'string' },
  },
  required: ['timeStamp', 'type', 'serializedHTML'],
  additionalProperties: false,
}

export const SuccessDetailSchema: JSONSchemaType<SuccessMessage['detail']> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    timeStamp: { type: 'number' },
  },
  required: ['id', 'timeStamp'],
  additionalProperties: false,
}

export const ErrorDetailSchema = {
  type: 'object',
  properties: {
    timeStamp: { type: 'number' },
    id: { type: 'string', nullable: true },
    name: { type: 'string' },
    error: { type: 'string', nullable: true },
    stack: { type: 'string', nullable: true },
    violations: { type: 'array', items: {}, nullable: true },
  },
  required: ['timeStamp', 'name'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ErrorMessage['detail']>

export const ScaleCheckResultDetailSchema: JSONSchemaType<ScaleCheckResultMessage['detail']> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    target: { type: 'string', minLength: 1, pattern: TARGET_PATTERN },
    effectiveScale: { type: 'string', enum: Object.values(SCALE) },
    timeStamp: { type: 'number' },
  },
  required: ['id', 'target', 'effectiveScale', 'timeStamp'],
  additionalProperties: false,
}

/** Every controller message kind mapped to its detail schema — the guard/reflection home. */
export const CONTROLLER_DETAIL_SCHEMAS = {
  [CONTROLLER_INCOMING_MESSAGE_TYPES.ui_render]: RenderDetailSchema,
  [CONTROLLER_INCOMING_MESSAGE_TYPES.ui_attrs]: AttrsDetailSchema,
  [CONTROLLER_INCOMING_MESSAGE_TYPES.ui_navigate]: NavigateDetailSchema,
  [CONTROLLER_INCOMING_MESSAGE_TYPES.ui_dispatch_custom_event]: DispatchCustomEventDetailSchema,
  [CONTROLLER_INCOMING_MESSAGE_TYPES.ui_scale_check]: ScaleCheckDetailSchema,
  [CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_event]: UiEventDetailSchema,
  [CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_form_submit]: FormSubmitDetailSchema,
  [CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_snapshot]: SnapshotDetailSchema,
  [CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_success]: SuccessDetailSchema,
  [CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_error]: ErrorDetailSchema,
  [CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_scale_check_result]: ScaleCheckResultDetailSchema,
} as const

/** Compiled once — the guard/host disptacher. */
const validators = new Map(
  Object.entries(CONTROLLER_DETAIL_SCHEMAS).map(([type, schema]) => [
    type,
    ajv.compile(schema) as (value: unknown) => boolean,
  ]),
)

/** Validate a controller message detail against its `ui_*` schema; unknown types fail closed. */
export const validateControllerDetail = (type: string, detail: unknown): boolean =>
  validators.get(type)?.(detail) ?? false
