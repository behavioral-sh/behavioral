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
 * construction message). For static-key vendors (Typesafe, OpenRouter) the
 * `url` is the DAEMON's provider-shaped proxy route and `apiKey` stays
 * unset — the key attaches daemon-side from the keychain and never enters a
 * browser context.
 */
export type SystemOneEndpointConfig = {
  /** The FULL request URL (e.g. `https://api.typesafe.ai/v1/systemone`). */
  url: string
  apiKey?: string
  headers?: Record<string, string>
  /** Default model slug; a request `model` overrides it. */
  model?: string
}
