/**
 * Wire and option types shared by the systemTwo faculty worker entry
 * (`system-two.faculty.ts` — Open Responses model calls) and its composition
 * wiring (`src/b-program/use-worker.ts`).
 *
 * @remarks
 * The faculty runs as a web worker, never imported by the host; both sides
 * import here instead. Types only — the faculty's config rides the init frame (the construction message).
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
} from './system-two.schemas.ts'

export type { ReasoningEffort }

/**
 * One provisioned model endpoint. Two transports:
 *
 * - `rest` (default) — `url` is the full base URL the operation path appends
 *   to (`/responses`). For static-key vendors (Typesafe, OpenRouter) this is
 *   the DAEMON's provider-shaped proxy route and `apiKey` stays unset — the
 *   key attaches daemon-side from the keychain and never enters a browser
 *   context. `apiKey` is only for providers that accept short-lived,
 *   scoped tokens vended to this session.
 * - `webgpu` — local in-worker inference; `model` names the local model.
 *   No network, no credential.
 */
export type SystemTwoEndpointConfig = {
  transport?: 'rest' | 'webgpu'
  /**
   * The full base URL the operation path appends to (`/responses`) — no
   * `/v1/` prefix is added. Rest transport only.
   */
  url?: string
  /** Rest transport only — daemon-vended short-lived tokens, never a static vendor key. */
  apiKey?: string
  headers?: Record<string, string>
  /** Webgpu transport only — the local model id. */
  model?: string
}

/** Provider label → endpoint config. Rides the init frame (the construction message). */
export type SystemTwoEndpoints = Record<string, SystemTwoEndpointConfig>
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
