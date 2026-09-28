/**
 * The System Two faculty's config surface — the two halves that make the faculty
 * pluggable without changing its wire contract.
 *
 * @remarks
 * `configSystemTwo` is the PROCESS-SIDE factory, invoked at the top of a
 * provider entry file. It owns the generic plumbing — inbound routing, the
 * result envelope, cancel and timeout — and calls the supplied `respond` for
 * the actual model call. A provider supplies only `respond` (ours is the Open
 * Responses implementation in `system-two/faculty.ts`); the event contract,
 * and therefore the guard threads the composition derives, are unchanged.
 *
 * `useSystemTwo` is the HOST-SIDE helper: it references a provider entry file
 * (default: the bundled Open Responses entry) and wires `useFaculty`, seeding
 * the endpoint map as environment data. Its return is what `bProgram` takes as
 * `systemTwo` — no default exists, because a System Two faculty without an
 * endpoint is simply absent.
 *
 * @packageDocumentation
 */

import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import {
  SystemTwoCancelEventSchema,
  type SystemTwoRequestEvent,
  SystemTwoRequestEventSchema,
  SystemTwoRequestResultEventSchema,
  validateSystemTwoCancelEvent,
  validateSystemTwoRequestEvent,
} from '../faculties.types.ts'
import { emit, envData, wireInbound } from '../process-lane.ts'
import { resolveFacultyEntry } from '../resolve-faculty-entry.ts'
import { useFaculty } from '../use-faculty.ts'
import { validateSystemTwoInput } from './schemas.ts'
import {
  SYSTEM_TWO_ENDPOINTS_KEY,
  type SystemTwoEndpoints,
  type SystemTwoInput,
  type SystemTwoOutput,
} from './types.ts'

/** The in-flight request timeout — the provider call is aborted past this. */
const FETCH_TIMEOUT_MS = 60_000

/** What `configSystemTwo` hands a provider's `respond`: the endpoint map and the abort signal. */
export type SystemTwoRespondContext = {
  endpoints: SystemTwoEndpoints
  signal: AbortSignal
}

/** A provider's model call: one validated input in, one output (or error data) out. */
export type SystemTwoRespond = (input: SystemTwoInput, context: SystemTwoRespondContext) => Promise<SystemTwoOutput>

type ActiveRequest = {
  controller: AbortController
  /** First stop reason wins. */
  reason: 'canceled' | 'timeout' | null
  timer: ReturnType<typeof setTimeout>
}

/**
 * The process-side factory: wire the inbound lane around one provider's
 * `respond`. Called at the top of a System Two provider entry file.
 */
export const configSystemTwo = (respond: SystemTwoRespond): void => {
  const endpoints = (envData(SYSTEM_TWO_ENDPOINTS_KEY) ?? {}) as SystemTwoEndpoints
  /** In-flight requests, keyed by correlation id. */
  const active = new Map<string, ActiveRequest>()

  const postResult = (id: string, result: unknown, space?: string, ctx?: JsonObject): void => {
    emit({
      type: FACULTY_MESSAGE_KINDS.system_two_request_result,
      // The uniform envelope: { isError: true, … } → error branch; the model
      // respond output → ok branch. The request's ctx echoes at detail level —
      // the out-of-band join lane (thread orchestration state round-trips
      // beside ok, never model-facing).
      detail: ((): JsonObject & { id: string } => {
        const base = ((): JsonObject & { id: string } => {
          if (typeof result === 'object' && result !== null && 'isError' in result) {
            const { isError, ...rest } = result as { isError: boolean } & JsonObject
            return { id, ok: false, error: { code: 'error', ...(isError ? rest : {}) } }
          }
          return { id, ok: true, result: (result ?? {}) as JsonObject }
        })()
        return ctx === undefined ? base : ({ ...base, ctx } as JsonObject & { id: string })
      })(),
      ...(space === undefined ? {} : { space }),
    })
  }

  /** Route one inbound event. */
  const handleInbound = async (message: unknown): Promise<void> => {
    if (validateSystemTwoCancelEvent(message)) {
      const request = active.get(message.detail.id)
      if (request !== undefined && request.reason === null) {
        request.reason = 'canceled'
        request.controller.abort()
      }
      return
    }
    // Events failing the shared schema have no correlation id to report to and
    // are dropped — the guard thread only forwards schema-valid events, so this
    // is defense in depth at the process boundary.
    if (!validateSystemTwoRequestEvent(message)) return
    const event = message as SystemTwoRequestEvent
    const { id, input, ctx } = event.detail
    // Input that fails the boundary is error data, not a throw: the id is valid,
    // so the caller learns why nothing ran.
    if (!validateSystemTwoInput(input)) {
      const detail = validateSystemTwoInput.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')
      postResult(id, { isError: true, message: `invalid input: ${detail}` }, event.space, ctx)
      return
    }

    const controller = new AbortController()
    const request: ActiveRequest = {
      controller,
      reason: null,
      timer: setTimeout(() => {
        if (request.reason === null) {
          request.reason = 'timeout'
          controller.abort()
        }
      }, FETCH_TIMEOUT_MS),
    }
    active.set(id, request)

    // `respond` never rejects the process: any provider throw becomes result data.
    try {
      const result = await respond(input, { endpoints, signal: controller.signal })
      postResult(id, result, event.space, ctx)
    } catch (error) {
      if (request.reason === 'timeout')
        postResult(
          id,
          { isError: true, message: `model request timed out after ${FETCH_TIMEOUT_MS}ms` },
          event.space,
          ctx,
        )
      else if (request.reason === 'canceled')
        postResult(id, { isError: true, message: 'model request canceled' }, event.space, ctx)
      else
        postResult(
          id,
          { isError: true, message: error instanceof Error ? error.message : String(error) },
          event.space,
          ctx,
        )
    } finally {
      clearTimeout(request.timer)
      active.delete(id)
    }
  }

  wireInbound((message) => handleInbound(message))
}

/**
 * The host-side helper: wire the System Two faculty process for a provider entry.
 * `endpoints` is delivered as environment data (secrets never cross the wire).
 */
export const useSystemTwo = ({
  endpoints,
  entry,
}: {
  /** Provider label → endpoint config, delivered to the process via environment data. */
  endpoints: SystemTwoEndpoints
  /**
   * The provider entry file. Absent keeps the bundled Open Responses entry; absolute
   * paths are used verbatim; relative paths resolve against the behavioral home.
   */
  entry?: string
}) =>
  useFaculty({
    command: ['bun', 'run', resolveFacultyEntry(entry, 'system-two/faculty.ts')],
    name: 'systemTwo',
    threads: [],
    env: { [SYSTEM_TWO_ENDPOINTS_KEY]: JSON.stringify(endpoints) },
    requestSchema: SystemTwoRequestEventSchema,
    cancelSchema: SystemTwoCancelEventSchema,
    resultSchema: SystemTwoRequestResultEventSchema,
  })
