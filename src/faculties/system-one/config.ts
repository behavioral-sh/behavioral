/**
 * The System One faculty's config surface.
 *
 * @remarks
 * `configSystemOne` is the PROCESS-SIDE factory, invoked at the top of a
 * provider entry file. It owns the generic plumbing — inbound routing, the
 * result envelope, cancel and timeout — and calls the supplied `respond` for
 * the actual decision call. A provider supplies only `respond` (ours is the
 * TypeSafe/OpenRouter Decisions implementation in `system-one/faculty.ts`);
 * the event contract, and therefore the guard threads, are unchanged.
 *
 * `useSystemOne` is the HOST-SIDE helper: it references a provider entry file
 * (default: the bundled Decisions entry) and wires `useFaculty`, seeding the
 * single endpoint as environment data. Its return is what `bProgram` takes as
 * `systemOne`.
 *
 * @packageDocumentation
 */

import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import {
  SystemOneCancelEventSchema,
  type SystemOneRequestEvent,
  SystemOneRequestEventSchema,
  SystemOneRequestResultEventSchema,
  validateSystemOneCancelEvent,
  validateSystemOneRequestEvent,
} from '../faculties.types.ts'
import { emit, envData, wireInbound } from '../process-lane.ts'
import { resolveFacultyEntry } from '../resolve-faculty-entry.ts'
import { useFaculty } from '../use-faculty.ts'
import { validateSystemOneInput } from './schemas.ts'
import {
  SYSTEM_ONE_ENDPOINT_KEY,
  type SystemOneEndpointConfig,
  type SystemOneInput,
  type SystemOneOutput,
} from './types.ts'

/** The in-flight request timeout — the provider call is aborted past this. */
const FETCH_TIMEOUT_MS = 60_000

/** What `configSystemOne` hands a provider's `respond`: the endpoint and the abort signal. */
export type SystemOneRespondContext = {
  endpoint: SystemOneEndpointConfig
  signal: AbortSignal
}

/** A provider's decision call result: the success output, or error data. */
export type SystemOneResult = SystemOneOutput | { isError: true; message: string }

/** A provider's decision call: one validated input in, one result out. */
export type SystemOneRespond = (input: SystemOneInput, context: SystemOneRespondContext) => Promise<SystemOneResult>

type ActiveRequest = {
  controller: AbortController
  /** First stop reason wins. */
  reason: 'canceled' | 'timeout' | null
  timer: ReturnType<typeof setTimeout>
}

/**
 * The process-side factory: wire the inbound lane around one provider's
 * `respond`. Called at the top of a System One provider entry file.
 */
export const configSystemOne = (respond: SystemOneRespond): void => {
  const endpoint = (envData(SYSTEM_ONE_ENDPOINT_KEY) ?? {}) as SystemOneEndpointConfig
  /** In-flight requests, keyed by correlation id. */
  const active = new Map<string, ActiveRequest>()

  const postResult = (id: string, result: unknown, space?: string): void => {
    emit({
      type: FACULTY_MESSAGE_KINDS.system_one_request_result,
      detail: ((): JsonObject & { id: string } => {
        if (typeof result === 'object' && result !== null && 'isError' in result) {
          const { isError, ...rest } = result as { isError: boolean } & JsonObject
          return { id, ok: false, error: { code: 'error', ...(isError ? rest : {}) } }
        }
        return { id, ok: true, result: (result ?? {}) as JsonObject }
      })(),
      ...(space === undefined ? {} : { space }),
    })
  }

  /** Route one inbound event. */
  const handleInbound = async (message: unknown): Promise<void> => {
    if (validateSystemOneCancelEvent(message)) {
      const request = active.get(message.detail.id)
      if (request !== undefined && request.reason === null) {
        request.reason = 'canceled'
        request.controller.abort()
      }
      return
    }
    if (!validateSystemOneRequestEvent(message)) return
    const event = message as SystemOneRequestEvent
    const { id, input } = event.detail
    if (!validateSystemOneInput(input)) {
      const detail = validateSystemOneInput.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')
      postResult(id, { isError: true, message: `invalid input: ${detail}` }, event.space)
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

    try {
      const result = await respond(input, { endpoint, signal: controller.signal })
      postResult(id, result, event.space)
    } catch (error) {
      if (request.reason === 'timeout')
        postResult(
          id,
          { isError: true, message: `decision request timed out after ${FETCH_TIMEOUT_MS}ms` },
          event.space,
        )
      else if (request.reason === 'canceled')
        postResult(id, { isError: true, message: 'decision request canceled' }, event.space)
      else
        postResult(id, { isError: true, message: error instanceof Error ? error.message : String(error) }, event.space)
    } finally {
      clearTimeout(request.timer)
      active.delete(id)
    }
  }

  wireInbound((message) => handleInbound(message))
}

/**
 * The host-side helper: wire the System One faculty process. `endpoint` is
 * delivered as environment data (the secret never crosses the wire).
 */
export const useSystemOne = ({
  endpoint,
  entry,
}: {
  /** The provisioned endpoint, delivered to the process via environment data. */
  endpoint: SystemOneEndpointConfig
  /**
   * The provider entry file. Absent keeps the bundled Decisions entry; absolute
   * paths are used verbatim; relative paths resolve against the behavioral home.
   */
  entry?: string
}) =>
  useFaculty({
    command: ['bun', 'run', resolveFacultyEntry(entry, 'system-one/faculty.ts')],
    name: 'systemOne',
    threads: [],
    env: { [SYSTEM_ONE_ENDPOINT_KEY]: JSON.stringify(endpoint) },
    requestSchema: SystemOneRequestEventSchema,
    cancelSchema: SystemOneCancelEventSchema,
    resultSchema: SystemOneRequestResultEventSchema,
  })
