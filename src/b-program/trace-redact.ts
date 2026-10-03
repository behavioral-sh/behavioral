/**
 * The trace redaction core — the deterministic redaction floor for the
 * composition's trace stream, HOST-NEUTRAL: the composition worker redacts
 * in-worker (the amended observability ruling — the redaction pass IS the
 * sanitize step), so this module carries zero host builtins. The daemon-side
 * persistence (the JSONL log sink) stays in `trace-consumer.ts`.
 *
 * @remarks
 * Redaction is a deterministic floor — a value registry (declared secrets),
 * sensitive field names, and the generated betterleaks provider rules
 * (keyword-prefiltered) — never a probabilistic classifier.
 *
 * The engine's trace publisher passes the SAME trace object by reference to
 * every listener and the composition's routing listener reads
 * `trace.selected`; redaction therefore deep-clones before scrubbing and
 * never mutates. The registry is supplied by the host — a list of secret
 * VALUES and/or sensitive KEY names — with no assumption about where they
 * come from (environment variables, a keychain, a declarative secret schema,
 * a secret manager).
 *
 * @packageDocumentation
 */

import type { Trace } from '../behavioral/behavioral.types.ts'
import { CREDENTIAL_RULES, type CredentialRule } from './credential-patterns.ts'

/** Marker substituted for every redacted value. */
export const REDACTED = '[REDACTED]'

/** Minimum length for an env value to count as a secret — avoids redacting "1", "true". */
const MIN_SECRET_LENGTH = 8

/** Env-var names that look sensitive — the declared-secret fallback. */
const SENSITIVE_KEY = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY)(_|$)|_KEY$/i

/** Object field names whose string values are always redacted. */
const SENSITIVE_FIELD =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth_?token|secret|password|credential|token)s?$/i

/**
 * The redaction registry — secret VALUES. A key is in scope when it matches
 * {@link SENSITIVE_KEY} (or is named in `keys`) and its value clears
 * {@link MIN_SECRET_LENGTH}. The host may also pass explicit values instead;
 * this convenience only scans the provided env-shaped record.
 */
export const collectSecretValues = (env: Record<string, string | undefined>, keys?: string[]): string[] => {
  const values = new Set<string>()
  for (const [key, value] of Object.entries(env)) {
    const wanted = keys === undefined ? SENSITIVE_KEY.test(key) : keys.includes(key)
    if (!wanted || value === undefined || value.length < MIN_SECRET_LENGTH) continue
    values.add(value)
  }
  return [...values]
}

/** The keyword prefilter — run a rule's regex only when a keyword is present (betterleaks' own optimization). */
const keywordHit = (lower: string, rule: CredentialRule): boolean =>
  rule.keywords.length === 0 || rule.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))

const scrubString = (value: string, secrets: string[], rules: CredentialRule[]): string => {
  let out = value
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  const lower = out.toLowerCase()
  for (const rule of rules) {
    if (!keywordHit(lower, rule)) continue
    out = out.replace(rule.pattern, REDACTED)
  }
  return out
}

const scrubInPlace = (value: unknown, secrets: string[], rules: CredentialRule[]): unknown => {
  if (typeof value === 'string') return scrubString(value, secrets, rules)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubInPlace(value[i], secrets, rules)
    return value
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const current = record[key]
      if (typeof current === 'string' && SENSITIVE_FIELD.test(key)) {
        record[key] = REDACTED
        continue
      }
      record[key] = scrubInPlace(current, secrets, rules)
    }
    return record
  }
  return value
}

/** Deep-clone a trace and scrub it (registry values, sensitive fields, credential shapes). */
export const redactTrace = (trace: Trace, secrets: string[] = [], rules: CredentialRule[] = CREDENTIAL_RULES): Trace =>
  scrubInPlace(structuredClone(trace), secrets, rules) as Trace
