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
import { behavioralHome } from '../actuators/behavioral-home.ts'
import { ROOT_UMWELT } from '../actuators/store.types.ts'
import { CREDENTIAL_RULES, type CredentialRule } from '../b-program/credential-patterns.ts'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { Trace, TraceListener } from '../behavioral/behavioral.types.ts'

// The host-neutral redaction core lives in `src/b-program/trace-redact.ts`
// (the composition worker redacts in-worker); the daemon side re-exports it
// and adds the `process.env` default.
export { REDACTED, redactTrace } from '../b-program/trace-redact.ts'

import {
  collectSecretValues as collectSecretValuesCore,
  redactTrace as redactTraceCore,
} from '../b-program/trace-redact.ts'

/**
 * The redaction registry — secret VALUES from the process environment. A key
 * is in scope when it matches the sensitive-name fallback (or is named in
 * `keys`) and its value clears the minimum length.
 */
export const collectSecretValues = (env: Record<string, string | undefined> = process.env, keys?: string[]): string[] =>
  collectSecretValuesCore(env, keys)

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
    const redacted = redactTraceCore(trace, secrets, rules)
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

/** Best-effort umwelt for the log path: a top-level umwelt, else the selection's, else root. */
const traceUmwelt = (trace: Trace): string => {
  const direct = (trace as { umwelt?: unknown }).umwelt
  if (typeof direct === 'string') return direct
  if (trace.kind === TRACE_MESSAGE_KINDS.selection || trace.kind === TRACE_MESSAGE_KINDS.interrupt) {
    return trace.selected.umwelt ?? ROOT_UMWELT
  }
  if (trace.kind === TRACE_MESSAGE_KINDS.thread_added || trace.kind === TRACE_MESSAGE_KINDS.thread_removed)
    return trace.thread.umwelt ?? ROOT_UMWELT
  return ROOT_UMWELT
}

const sanitizeUmwelt = (umwelt: string): string => umwelt.replace(/[^A-Za-z0-9._-]/g, '_')

/**
 * The JSONL trace log: append one JSON line per trace to
 * `<root>/<umwelt>/<YYYY-MM-DD>.jsonl`. Synchronous by design — the trace
 * publisher fires listeners fire-and-forget, so an async appender can reorder
 * or drop lines on exit.
 */
export const traceLogSink =
  ({ root }: { root?: string } = {}): TraceSink =>
  (trace) => {
    const base = root ?? path.join(behavioralHome(), 'traces')
    const dir = path.join(base, sanitizeUmwelt(traceUmwelt(trace)))
    mkdirSync(dir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    appendFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify(trace)}\n`, 'utf8')
  }
