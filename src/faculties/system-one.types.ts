/**
 * Wire and option types for the System One faculty (the TypeSafe "Decisions"
 * API and its OpenRouter-compatible sibling).
 *
 * @remarks
 * `SystemOneEndpointConfig.url` is the FULL request URL (the TypeSafe native
 * `/v1/systemone` and OpenRouter `/api/alpha/decisions` paths differ, so no
 * base-plus-path assumption is safe). `model` is the endpoint default; a
 * request may override it.
 *
 * @packageDocumentation
 */

import type { SystemOneInput, SystemOneOutput } from './system-one.schemas.ts'

export type { SystemOneInput, SystemOneOutput }

/**
 * One provisioned System One endpoint, riding the init frame (the
 * construction message). Two transports:
 *
 * - `rest` (default) — `url` is the FULL request URL (the TypeSafe native
 *   `/v1/systemone` and OpenRouter `/api/alpha/decisions` paths differ, so
 *   no base-plus-path assumption is safe). For static-key vendors the `url`
 *   is the DAEMON's provider-shaped proxy route and `apiKey` stays unset —
 *   the key attaches daemon-side from the keychain, never a browser context.
 * - `webgpu` — local in-worker inference; `model` names the local model id.
 *   No network, no credential. Re-init overwrites (R4's channel — built).
 */
export type SystemOneEndpointConfig = {
  transport?: 'rest' | 'webgpu'
  /** Rest transport only — the FULL request URL (e.g. `https://openrouter.ai/api/alpha/decisions`). */
  url?: string
  /** Rest transport only — daemon-vended short-lived tokens, never a static vendor key. */
  apiKey?: string
  headers?: Record<string, string>
  /** Rest: the default model slug (a request `model` overrides it). Webgpu: the local model id. */
  model?: string
}
