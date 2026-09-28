/**
 * Wire and option types shared by the systemTwo faculty process
 * (`system-two/faculty.ts` — Open Responses model calls) and its host-side
 * config surface (`system-two/config.ts`).
 *
 * @remarks
 * The faculty runs as a spawned process, never imported by the host; both
 * sides import here instead. Types plus one side-effect-free key constant —
 * the key is the only runtime value, so both sides agree on the
 * environment-data key (env vars across the spawn) without a circular import.
 */

import type {
  FunctionTool,
  InputItem,
  Error as OpenResponsesError,
  OpenResponsesStreamEvent,
  OutputItem,
  ReasoningEffort,
  Truncation,
  Usage,
} from './schemas.ts'

export type { ReasoningEffort }

/**
 * One provisioned Open Responses endpoint. `apiKey` must already be resolved
 * at provisioning time — it is never model-facing and never crosses the wire
 * in a request message (the host delivers the whole map via environment data).
 */
export type SystemTwoEndpointConfig = {
  /**
   * The full base URL the operation path appends to (`/responses`) — no
   * `/v1/` prefix is added.
   */
  url: string
  apiKey?: string
  headers?: Record<string, string>
}

/** Provider label → endpoint config. Delivered to the faculty via environment data. */
export type SystemTwoEndpoints = Record<string, SystemTwoEndpointConfig>

/** Environment-data key for the provisioned endpoint map (host seeds, worker reads). */
export const SYSTEM_TWO_ENDPOINTS_KEY = 'behavioral:model-endpoints'

// ---------------------------------------------------------------------------
// model-respond — input / output
// ---------------------------------------------------------------------------

export type SystemTwoInput = {
  provider: string
  modelId: string
  input: InputItem[]
  tools?: FunctionTool[]
  instructions?: string
  truncation?: Truncation
  stream?: boolean
  /** Spec ReasoningEffortEnum value, or a non-spec value passed through verbatim. */
  reasoningEffort?: ReasoningEffort | (string & {})
  /**
   * Passthrough: spec request params we do not name + endpoint extensions,
   * forwarded to the request body verbatim (named fields win on collision).
   */
  [key: string]: unknown
}

/**
 * Success: items + terminal status (+ usage / structured error, and the full
 * streamed event list when `stream` is set). Errors are data, never throws:
 * `{ isError: true, message }` for unknown provider / transport / HTTP failure.
 */
export type SystemTwoOutput =
  | {
      items: OutputItem[]
      status: string
      events?: OpenResponsesStreamEvent[]
      usage?: Usage
      error?: OpenResponsesError
    }
  | { isError: true; message: string }
