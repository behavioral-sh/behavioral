import type { ValidateFunction } from 'ajv'
import type { JsonObject } from '../behavioral/behavioral.types.ts'

/**
 * The in-worker bootstrap — `createWorker(respond)` is called at the TOP
 * LEVEL of each faculty entry file. It owns the generic plumbing deduped
 * from the faculty configs: inbound message routing, the ok/isError result
 * envelope, the cancel map, the request timeout, space + ctx echo.
 *
 * The gate is SCOPE, not `import.meta.main` — `import.meta` is a syntax
 * error in classic worker bundles (the browser gets the same entries
 * bundled CLASSIC), and Bun's main thread carries the web-worker globals
 * anyway (oven-sh/bun#35655), so entry detection lies. Outside a worker
 * global the bootstrap wires nothing: importing a faculty entry in the
 * main thread is inert, and the `respond` stays importable by specs.
 *
 * Scope discrimination (Bun 1.4 facts, probed):
 * - browser main threads have `window`; workers never do;
 * - Bun's main thread ALSO lacks `window`, but exposes
 *   `Bun.isMainThread === true` — web workers expose `false`;
 * - a browser classic bundle has no `Bun` global at all (and the entries
 *   never run on a browser main thread).
 *
 * Every inbound message is handled independently (no await in the listener —
 * a long-running request must not head-of-line block its own cancel).
 */

/** True only inside a worker global (Bun web worker or browser worker). */
const isWorkerScope = (): boolean => {
  if (typeof window !== 'undefined') return false
  const bun = (globalThis as { Bun?: { isMainThread?: boolean } }).Bun
  return bun === undefined || bun.isMainThread !== true
}

/** The faculty's call: one validated input in, one result (or error data) out. */
export type FacultyRespond<I = JsonObject, D = JsonObject> = (
  input: I,
  context: { data: D; signal: AbortSignal },
) => Promise<JsonObject | { isError: true; message: string }>

/** The inbound request event's shape, structurally — the faculty's wire home validates it. */
type FacultyRequestEvent<I> = {
  type: string
  detail: { id: string; input: I; ctx?: JsonObject }
  space?: string
}

/** The inbound cancel event's shape, structurally. */
type FacultyCancelEvent = {
  type: string
  detail: { id: string }
  space?: string
}

type ActiveRequest = {
  controller: AbortController
  /** First stop reason wins. */
  reason: 'canceled' | 'timeout' | null
  timer: ReturnType<typeof setTimeout>
}

/**
 * Wire the worker's inbound lane around one faculty's `respond`. Returns a
 * small wiring descriptor when inside a worker scope; `undefined` when the
 * module was imported outside one (the no-op guard — introspectable so the
 * main-thread inertness is provable, not assumed).
 */
export const createWorker = <I = JsonObject, D = JsonObject>({
  respond,
  validateRequest,
  validateCancel,
  validateInput,
  requestKind,
  resultKind,
  data = {} as D,
  timeoutMs = 60_000,
}: {
  /** The faculty's call — one validated input in, one result out. */
  respond: FacultyRespond<I, D>
  /** The wire home's once-compiled request validator. */
  validateRequest: ValidateFunction
  /** The wire home's once-compiled cancel validator. */
  validateCancel: ValidateFunction
  /** The faculty's once-compiled input-boundary validator. */
  validateInput: ValidateFunction
  /** The inbound request type seal — only this type reaches the faculty. */
  requestKind: string
  /** The outbound result type — the lane's seal (must pair with `requestKind`). */
  resultKind: string
  /** The faculty's already-read environment config, handed to each call. */
  data?: D
  /** The in-flight request timeout — the provider call is aborted past this. */
  timeoutMs?: number
}): { resultKind: string } | undefined => {
  if (!isWorkerScope()) return undefined

  /** In-flight requests, keyed by correlation id. */
  const active = new Map<string, ActiveRequest>()

  /** Post one result event to the composition, space + ctx echoed. */
  const postResult = (result: JsonObject | { isError: true; message: string }, event: FacultyRequestEvent<I>): void => {
    const detail = ((): JsonObject & { id: string } => {
      if (typeof result === 'object' && result !== null && 'isError' in result) {
        const { isError, ...rest } = result as { isError: boolean } & JsonObject
        return { id: event.detail.id, ok: false, error: { code: 'error', ...(isError ? rest : {}) } }
      }
      return { id: event.detail.id, ok: true, result: (result ?? {}) as JsonObject }
    })()
    const echoed =
      event.detail.ctx === undefined ? detail : ({ ...detail, ctx: event.detail.ctx } as JsonObject & { id: string })
    postMessage({
      type: resultKind,
      detail: echoed,
      ...(event.space === undefined ? {} : { space: event.space }),
    })
  }

  /** Route one inbound message (fire-and-forget per message). */
  const handleInbound = async (message: unknown): Promise<void> => {
    if (validateCancel(message)) {
      const request = active.get((message as FacultyCancelEvent).detail.id)
      if (request !== undefined && request.reason === null) {
        request.reason = 'canceled'
        request.controller.abort()
      }
      return
    }
    if (!validateRequest(message) || (message as FacultyRequestEvent<I>).type !== requestKind) return
    const event = message as FacultyRequestEvent<I>
    const { id, input } = event.detail
    if (!validateInput(input)) {
      const detail = validateInput.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')
      postResult({ isError: true, message: `invalid input: ${detail}` }, event)
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
      }, timeoutMs),
    }
    active.set(id, request)

    // `respond` never rejects the worker: any faculty throw becomes result data.
    // The stop reason wins over HOW the call settled — a resolved call on an
    // aborted request (a respond that returns instead of throwing on abort)
    // still answers with the canceled/timeout result, deterministically.
    const stopResult = (): { isError: true; message: string } | null =>
      request.reason === 'timeout'
        ? { isError: true, message: `request timed out after ${timeoutMs}ms` }
        : request.reason === 'canceled'
          ? { isError: true, message: 'request canceled' }
          : null
    try {
      const result = await respond(input, { data, signal: controller.signal })
      postResult(stopResult() ?? result, event)
    } catch (error) {
      postResult(
        stopResult() ?? { isError: true, message: error instanceof Error ? error.message : String(error) },
        event,
      )
    } finally {
      clearTimeout(request.timer)
      active.delete(id)
    }
  }

  addEventListener('message', (event: MessageEvent) => {
    void handleInbound(event.data)
  })

  return { resultKind }
}
