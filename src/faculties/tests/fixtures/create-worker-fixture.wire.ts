import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject } from '../../../behavioral/behavioral.types.ts'
import { detailInputSchema } from '../../create-worker.ts'

/**
 * The create-worker fixture WIRE — the fixture faculties' shared event
 * vocabulary: schemas, once-compiled validators, event constructors, types.
 * A separate module (no self-wiring) so multiple fixture entries can share
 * it: a worker global carries ONE wiring — importing a self-wiring entry's
 * module boots a second wiring in the same global.
 */

export type FixtureInput = {
  op: 'echo' | 'fail' | 'hang' | 'crash' | 'throw'
  message?: string
}

/** The bootstrap hands the faculty the full correlated detail; the payload rides `input`. */
export type FixtureDetail = { input: FixtureInput }

export type FixtureRequestEvent = {
  type: 'fixture_request'
  detail: { id: string; input: FixtureInput; ctx?: JsonObject }
  space?: string
}

export type FixtureCancelEvent = {
  type: 'fixture_cancel'
  detail: { id: string }
  space?: string
}

const inputSchema: JSONSchemaType<FixtureInput> = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['echo', 'fail', 'hang', 'crash', 'throw'] },
    message: { type: 'string', nullable: true },
  },
  required: ['op'],
  additionalProperties: false,
}

const requestSchema: JSONSchemaType<FixtureRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'fixture_request' },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        // The wire home's shape: input rides as a loose object — deep validity
        // is the faculty's separate input boundary (validateInput).
        input: { type: 'object', required: [], additionalProperties: true },
        ctx: { type: 'object', required: [], additionalProperties: true, nullable: true },
      },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

const cancelSchema: JSONSchemaType<FixtureCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'fixture_cancel' },
    detail: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

/** Resolve when the request's signal aborts (or right away if already aborted). */
export const hangUntilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

/** The fixture's once-compiled validators — the lane specs wire the SAME home (no drift). */
export const validateFixtureRequestEvent = ajv.compile(requestSchema)
export const validateFixtureCancelEvent = ajv.compile(cancelSchema)
export const validateFixtureDetailInput = ajv.compile(detailInputSchema(inputSchema))

/** Request-event constructor for the lane specs (the wire shape, not a helper the worker uses). */
export const fixtureRequestEvent = ({
  id,
  input,
  ctx,
  space,
}: {
  id: string
  input: FixtureInput
  ctx?: JsonObject
  space?: string
}): FixtureRequestEvent => ({
  type: 'fixture_request',
  detail: { id, input, ...(ctx === undefined ? {} : { ctx }) },
  ...(space === undefined ? {} : { space }),
})

/** Cancel-event constructor for the lane specs. */
export const fixtureCancelEvent = ({ id, space }: { id: string; space?: string }): FixtureCancelEvent => ({
  type: 'fixture_cancel',
  detail: { id },
  ...(space === undefined ? {} : { space }),
})
