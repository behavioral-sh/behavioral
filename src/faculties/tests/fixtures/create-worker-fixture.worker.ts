import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject } from '../../../behavioral/behavioral.types.ts'
import { createWorker, detailInputSchema } from '../../create-worker.ts'
import { envData } from '../../env-data.ts'

/**
 * The create-worker fixture faculty — a canned `respond` behind the generic
 * bootstrap, proving the plumbing at a real worker boundary. Ops:
 *
 * - `echo` — reflects the input plus the respond context's `data` (seenData)
 * - `fail` — returns the isError branch of the result envelope
 * - `hang` — never settles until the request's signal aborts (cancel/timeout)
 * - `crash` — schedules an uncaught throw, then hangs forever (the in-flight
 *   request never answers; the worker dies with an error event)
 * - anything else — the respond itself throws (error envelope, not a crash)
 *
 * The fixture compiles its own wire schemas (it is plumbing fixture, not a
 * faculty) — the request/cancel shapes mirror the wire home's event shape.
 * Its in-flight timeout is env-data configurable (FIXTURE_TIMEOUT_KEY) so the
 * specs can pin the no-timeout contract (0 = no timer).
 */

/** Env-data key for the fixture's in-flight timeout (`0` = no timer). */
export const FIXTURE_TIMEOUT_KEY = 'behavioral:fixture-timeout'

const fixtureTimeoutMs = (): number => {
  const configured = envData(FIXTURE_TIMEOUT_KEY)
  return typeof configured === 'number' ? configured : 200
}

type FixtureInput = {
  op: 'echo' | 'fail' | 'hang' | 'crash' | 'throw'
  message?: string
}

/** The bootstrap hands the faculty the full correlated detail; the payload rides `input`. */
type FixtureDetail = { input: FixtureInput }

type FixtureRequestEvent = {
  type: 'fixture_request'
  detail: { id: string; input: FixtureInput; ctx?: JsonObject }
  space?: string
}

type FixtureCancelEvent = {
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
const hangUntilAborted = (signal: AbortSignal): Promise<void> =>
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

export const wiring = createWorker<FixtureDetail, { fixture: boolean }>({
  requestKind: 'fixture_request',
  resultKind: 'fixture_request_result',
  validateRequest: validateFixtureRequestEvent,
  validateCancel: validateFixtureCancelEvent,
  validateInput: ajv.compile(detailInputSchema(inputSchema)),
  timeoutMs: fixtureTimeoutMs(),
  data: { fixture: true },
  respond: async (detail, { data, signal }): Promise<JsonObject | { isError: true; message: string }> => {
    const input = detail.input
    if (input.op === 'echo') {
      const seenData = (data as { fixture?: boolean }).fixture ?? null
      return input.message === undefined ? { op: 'echo', seenData } : { op: 'echo', message: input.message, seenData }
    }
    if (input.op === 'fail') return { isError: true, message: input.message ?? 'fixture failed' }
    if (input.op === 'crash') {
      setTimeout(() => {
        throw new Error('fixture crash')
      }, 0)
      await hangUntilAborted(signal)
      return {}
    }
    if (input.op === 'throw') throw new Error('fixture respond threw')
    await hangUntilAborted(signal)
    return {}
  },
})
