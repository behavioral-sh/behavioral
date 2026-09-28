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

import type { SystemOneInput, SystemOneOutput } from './schemas.ts'

export type { Answer, InstructionValue, Question } from './schemas.ts'
export type { SystemOneInput, SystemOneOutput }

/**
 * One provisioned System One endpoint. `apiKey` is resolved at provisioning
 * time — it is never model-facing and never crosses the wire in a request
 * message (the host delivers it via environment data).
 */
export type SystemOneEndpointConfig = {
  /** The FULL request URL (e.g. `https://api.typesafe.ai/v1/systemone`). */
  url: string
  apiKey?: string
  headers?: Record<string, string>
  /** Default model slug; a request `model` overrides it. */
  model?: string
}

/** Environment-data key for the provisioned system-one endpoint (host seeds, process reads). */
export const SYSTEM_ONE_ENDPOINT_KEY = 'behavioral:system-one-endpoint'
