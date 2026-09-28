/**
 * The trace consumer — the deterministic redaction floor for the composition's
 * trace stream (issues 2 & 3 of the observability slice).
 *
 * @remarks
 * The engine is in-process, so the composition exposes `runtime.useTrace` and
 * the host owns egress. This module is that egress boundary: one redaction
 * pass feeds every sink (the JSONL trace log, the JSON-RPC notification
 * stream, a UI). Redaction is a deterministic floor — a value registry
 * (declared secrets), sensitive field names, and the generated betterleaks
 * provider rules (keyword-prefiltered) — never a probabilistic classifier.
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

import { appendFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { Trace, TraceListener } from '../behavioral/behavioral.types.ts'
import { behavioralHome } from '../old-faculties/behavioral-home.ts'
import { ROOT_SPACE } from '../old-faculties/store/types.ts'
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
export const collectSecretValues = (
  env: Record<string, string | undefined> = process.env,
  keys?: string[],
): string[] => {
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

/** A sink receives one redacted trace. Keep it synchronous (ordering is the log's contract). */
export type TraceSink = (trace: Trace) => void

/** Redact once, fan out to every sink. One throwing sink must not starve the others. */
export const createTraceConsumer =
  ({
    sinks,
    secrets = [],
    rules = CREDENTIAL_RULES,
  }: {
    sinks: TraceSink[]
    secrets?: string[]
    rules?: CredentialRule[]
  }): TraceListener =>
  (trace) => {
    const redacted = redactTrace(trace, secrets, rules)
    for (const sink of sinks) {
      try {
        sink(redacted)
      } catch (error) {
        // The engine's listener catch is per-consumer, not per-sink — isolate
        // here so one failing sink cannot suppress the rest.
        console.error('[behavioral] trace sink threw:', error)
      }
    }
  }

/** Best-effort space for the log path: a top-level space, else the selection's, else root. */
const traceSpace = (trace: Trace): string => {
  const direct = (trace as { space?: unknown }).space
  if (typeof direct === 'string') return direct
  if (trace.kind === TRACE_MESSAGE_KINDS.selection || trace.kind === TRACE_MESSAGE_KINDS.interrupt) {
    return trace.selected.space ?? ROOT_SPACE
  }
  if (trace.kind === TRACE_MESSAGE_KINDS.thread_added) return trace.thread.space ?? ROOT_SPACE
  return ROOT_SPACE
}

const sanitizeSpace = (space: string): string => space.replace(/[^A-Za-z0-9._-]/g, '_')

/**
 * The JSONL trace log: append one JSON line per trace to
 * `<root>/<space>/<YYYY-MM-DD>.jsonl`. Synchronous by design — the trace
 * publisher fires listeners fire-and-forget, so an async appender can reorder
 * or drop lines on exit.
 */
export const traceLogSink =
  ({ root }: { root?: string } = {}): TraceSink =>
  (trace) => {
    const base = root ?? path.join(behavioralHome(), 'traces')
    const dir = path.join(base, sanitizeSpace(traceSpace(trace)))
    mkdirSync(dir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    appendFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify(trace)}\n`, 'utf8')
  }
