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
 * global the bootstrap wires nothing: importing a faculty entry in the main
 * thread is inert, and the `respond` stays importable by specs.
 *
 * Faculty config rides the INIT FRAME (the construction message) — never
 * eval-time reads, never request messages, never node builtins.
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

/**
 * Lift an input-level schema to the request-detail level — the system
 * faculties' payload rides the detail at `input`. The wire home's event
 * validator remains the strict outer boundary; this is the faculty's
 * defense-in-depth at its own boundary.
 */
export const detailInputSchema = (inputSchema: object): object => ({
  type: 'object',
  properties: { input: inputSchema },
  required: ['input'],
  additionalProperties: true,
})

/**
 * The lane's control-frame discriminant — the construction message. The
 * composition posts `{ kind: 'init', data }` immediately after constructing
 * the worker (port FIFO + the worker message queue guarantee it precedes the
 * first request); the faculty's config NEVER rides a request message and the
 * worker side never imports node builtins (the browser classic bundle cannot
 * carry them — Bun's browser build silently shims `node:` imports to empty
 * objects, and the shim dies at eval). Re-init is legal: a later init frame
 * overwrites the config (the forward-compatible channel for config updates,
 * e.g. pulling a new local model).
 */
export const INIT_FRAME_KIND = 'init'

/** The init frame: the composition → faculty construction message. */
export type InitFrame = { kind: typeof INIT_FRAME_KIND; data: JsonObject }

const isInitFrame = (message: unknown): message is InitFrame =>
  typeof message === 'object' &&
  message !== null &&
  (message as InitFrame).kind === INIT_FRAME_KIND &&
  typeof (message as InitFrame).data === 'object' &&
  (message as InitFrame).data !== null &&
  !Array.isArray((message as InitFrame).data)

/**
 * The faculty's call: one correlated request detail in, one result (or error data) out.
 *
 * The result is structurally discriminated by the envelope: `{ isError: true,
 * message }` (any extra fields ride the error payload) → the error branch;
 * anything else → the ok branch, JSON-serialized verbatim. The type is
 * deliberately `unknown` — a faculty's typed output (e.g. SystemTwoOutput's
 * `OutputItem[]`) is not a JsonObject, and the wire boundary is the
 * faculty's output validator, not this signature.
 */
export type FacultyRespond<I = JsonObject, D = JsonObject> = (
  input: I,
  context: { data: D; signal: AbortSignal },
) => Promise<unknown>

/** The inbound request event's shape, structurally — the faculty's wire home validates it.
 *
 * The bootstrap hands the faculty the FULL correlated detail (`{ id, ctx? } & I`):
 * where the payload sits inside the detail is the faculty wire's convention
 * (the system faculties nest it at `input`; frontier's dispatch key `op` rides
 * beside it) — not the bootstrap's business.
 */
type FacultyRequestEvent<I> = {
  type: string
  detail: { id: string; ctx?: JsonObject } & I
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
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Wire the worker's inbound lane around one faculty's `respond`. Returns the
 * lane's sealed result kind when inside a worker scope; `undefined` when the
 * module was imported outside one (the no-op guard — introspectable so the
 * main-thread inertness is provable, not assumed).
 */
export const createWorker = <I = JsonObject, D = JsonObject>({
  respond,
  validateRequest,
  validateCancel,
  validateInput,
  resultKind,
  timeoutMs = 60_000,
}: {
  /** The faculty's call — one correlated request detail in, one result out. */
  respond: FacultyRespond<I, D>
  /** The wire home's once-compiled request validator. */
  validateRequest: ValidateFunction
  /** The wire home's once-compiled cancel validator — absent for faculties with no cancel contract (sync analyses). */
  validateCancel?: ValidateFunction
  /** The faculty's once-compiled input-boundary validator. */
  validateInput: ValidateFunction
  /** The outbound result type — the lane's seal (the request validators are const-discriminated). */
  resultKind: string
  /** The in-flight request timeout — the provider call is aborted past this. `0` = no timer (sync faculties). */
  timeoutMs?: number
}): string | undefined => {
  if (!isWorkerScope()) return undefined

  // The faculty's config, delivered by the init frame (never eval-time, never
  // a request message). Fail-closed: requests before init answer a typed
  // error; an invalid init frame is ignored.
  let data = {} as D
  let initialized = false

  /** In-flight requests, keyed by correlation id. */
  const active = new Map<string, ActiveRequest>()

  /** Post one result event to the composition, space + ctx echoed. */
  const postResult = (result: unknown, event: FacultyRequestEvent<I>): void => {
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
    if (isInitFrame(message)) {
      data = message.data as D
      initialized = true
      return
    }
    if (validateCancel?.(message)) {
      const request = active.get((message as FacultyCancelEvent).detail.id)
      if (request !== undefined && request.reason === null) {
        request.reason = 'canceled'
        request.controller.abort()
      }
      return
    }
    if (!validateRequest(message)) return
    const event = message as FacultyRequestEvent<I>
    if (!initialized) {
      // Fail-closed: no config yet — the caller learns why nothing ran.
      postResult({ isError: true, message: 'faculty not initialized: no init frame received' }, event)
      return
    }
    const requestDetail = event.detail
    if (!validateInput(requestDetail)) {
      const detail = validateInput.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')
      postResult({ isError: true, message: `invalid input: ${detail}` }, event)
      return
    }

    const controller = new AbortController()
    const request: ActiveRequest = {
      controller,
      reason: null,
      ...(timeoutMs > 0
        ? {
            timer: setTimeout(() => {
              if (request.reason === null) {
                request.reason = 'timeout'
                controller.abort()
              }
            }, timeoutMs),
          }
        : {}),
    }
    active.set(requestDetail.id, request)

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
      const result = await respond(requestDetail, { data, signal: controller.signal })
      postResult(stopResult() ?? result, event)
    } catch (error) {
      postResult(
        stopResult() ?? { isError: true, message: error instanceof Error ? error.message : String(error) },
        event,
      )
    } finally {
      if (request.timer !== undefined) clearTimeout(request.timer)
      active.delete(requestDetail.id)
    }
  }

  addEventListener('message', (event: MessageEvent) => {
    void handleInbound(event.data)
  })

  return resultKind
}
