/**
 * The bundled System One provider — the DEFAULT TypeSafe / OpenRouter
 * Decisions implementation.
 *
 * @remarks
 * This file is a provider ENTRY: it defines `typesafeRespond` (one decision
 * call per input) and hands it to `configSystemOne`, which wires the process.
 * A third party writes their own entry the same way; the wire contract does
 * not change.
 *
 * The endpoint is read once from environment data by `configSystemOne`; the
 * secret never enters a request message. Retries cover the API's rate-limit
 * statuses (429/529), honoring `retry-after` when present — the faculty the
 * vendor SDKs provide, implemented here so the faculty owns its transport.
 *
 * @packageDocumentation
 */

import { configSystemOne, type SystemOneRespond } from './config.ts'
import { validateSystemOneOutput } from './schemas.ts'
import type { SystemOneOutput } from './types.ts'

/** Statuses worth retrying with backoff (the API's rate-limit/overload contract). */
const RETRY_STATUSES = new Set([429, 529])
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const retryDelayMs = (res: Response, attempt: number): number => {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
}

/** Structured error body ({ error: { code, message } }), falling back to raw text. */
const describeHttpError = async (res: Response): Promise<string> => {
  let detail = ''
  try {
    const raw = await res.text()
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } }
    if (parsed.error && typeof parsed.error === 'object') {
      const { code, message } = parsed.error
      detail = `${typeof code === 'string' ? code : 'unknown_error'}: ${typeof message === 'string' ? message : raw}`
    } else {
      detail = raw
    }
  } catch {
    detail = ''
  }
  return `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`
}

const typesafeRespond: SystemOneRespond = async (input, { endpoint, signal }) => {
  const model = input.model ?? endpoint.model
  if (model === undefined) return { isError: true, message: 'no model configured for the system one endpoint' }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(endpoint.apiKey !== undefined && { authorization: `Bearer ${endpoint.apiKey}` }),
    ...endpoint.headers,
  }
  const body = JSON.stringify({ state: input.state, model, questions: input.questions })

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(endpoint.url, { method: 'POST', headers, body, signal })
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
      await sleep(retryDelayMs(res, attempt))
      continue
    }
    if (!res.ok) return { isError: true, message: await describeHttpError(res) }
    const parsed: unknown = await res.json()
    // MINIMAL: validate the envelope only — a malformed answer set is rejected
    // as error data rather than partially admitted.
    if (!validateSystemOneOutput(parsed)) return { isError: true, message: 'invalid response from endpoint' }
    return parsed as SystemOneOutput
  }
  return { isError: true, message: 'decision request exhausted retries' }
}

// The process entry: wire only when spawned (an in-process import wires nothing).
if (import.meta.main) {
  configSystemOne(typesafeRespond)
}
