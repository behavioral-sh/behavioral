/**
 * The ui autoresearch loop's capture side — the iterate mechanism that
 * refines the ui_* producer threads by measurement, not argument.
 *
 * @remarks
 * An in-process RAW `useTrace` consumer (the eval ruling's canonical path:
 * in-process = raw; the per-consumer catch means it coexists with the
 * redacted trace lane untouched) writing ui-pipeline runs to a capture sink
 * the eval harness reads. A run is LINEAGE-KEYED, never time-windowed: the
 * per-trigger pipeline's minted id (parsed from the mint thread names,
 * the correlation ids, and the ctx lineage) opens, routes, and closes the
 * run — so interleaved pipelines attribute correctly and unrelated faculty
 * traffic (boot scans, other spaces' requests) stays out of the runs.
 *
 * The Thread set rides `thread_added` for free, in two lanes: the STANDING
 * threads (the policy set) and the run's once-thread RE-ENTRIES (the minted
 * pipeline legs and the transform/faculty result re-entry requesters),
 * position-tagged by the message index at which each arrived. The pump's
 * SUBSCRIBER-ORDER WARP — the composition's pump subscribes first, so a
 * minted set (and its scale-check selection) reaches this consumer BEFORE
 * the opening render-ingress selection trace — is handled by binding runs
 * lazily: the pipeline id arrives with the mint (or the first id-bearing
 * message), the ingress trace is inserted at message 0 whenever it binds.
 *
 * The replay pass is `frontier_analysis_request { op: 'replay' }` over a captured
 * run — the divergence view: where requests blocked, what the frontier
 * looked like when the hold happened. Replay the full run for the end
 * state; replay a PREFIX (`uiReplayRequest(run, upTo)` — the message count,
 * e.g. up to just before the browser's scale reply) for the hold. The
 * graders are consumer-authored (the eval data-contract) — this module
 * wires the loop, nothing more.
 *
 * MINIMAL: a run closes ONLY at its `ui_render` terminus (the id-joined
 * draft) — a held run (no browser reply) stays open forever; the
 * quiescence-based flush of incomplete runs rides a named need.
 *
 * @packageDocumentation
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import { uuid } from '../utils.ts'
import { UI_RENDER_TRIGGER_TYPE } from './ui-threads.ts'

/**
 * One captured once-thread re-entry — the message count already seen when
 * the thread was added (the transform target's or faculty result's requester).
 */
export type UiReentry = { at: number; thread: Thread }

/**
 * Drop undefined-valued own keys — the engine's transform re-entries carry an
 * explicit `space: undefined` (root) that the replay input schema's strict
 * thread shape rejects; absent means root, the same semantics.
 */
const normalizeThread = (thread: Thread): Thread => {
  const out = { ...thread } as Record<string, unknown>
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }
  return out as Thread
}

/** One captured ui-pipeline run: the lineage key, the standing Thread set, the position-tagged re-entries, the run's selections. */
export type UiRun = {
  /** The minted pipeline id — the run's lineage key (`ui-<uuid>`). */
  pipeline: string
  startedAt: number
  threads: Thread[]
  reentries: UiReentry[]
  messages: SelectionTrace[]
}

/**
 * The pipeline id of a mint/re-entry thread, parsed from its name — the
 * three label shapes the composition produces: the minted leg
 * (`ui/pipeline:<pid>/<leg>`), the engine's transform re-entry
 * (`Transform(ui/pipeline:<pid>/<leg> => target)`), and the faculty result
 * re-entry (`on_<type>_<pid>-<leg>`). The correlation suffixes are the same
 * legs the pipeline composes (uuid is hex + hyphens — no underscores in a pid).
 */
const pipelineOfThread = (thread: Thread): string | undefined => {
  const mint = /^ui\/pipeline:([^/]+)\//.exec(thread.name)
  if (mint !== null) return mint[1]
  const transform = /Transform\(ui\/pipeline:([^/]+)\//.exec(thread.name)
  if (transform !== null) return transform[1]
  const reentry = /_(ui-[0-9a-f-]+-(?:scale|tenant|gen|render|style))$/.exec(thread.name)
  if (reentry !== null) return reentry[1]!.slice(0, -(reentry[1]!.length - reentry[1]!.lastIndexOf('-')))
  return undefined
}

/**
 * The pipeline id of a selection, parsed from the wire shapes the pipeline
 * composes: the generate lineage (`ctx.echo.pipeline`), the systemTwo ctx
 * (`ctx.pipeline`), and every correlation id (`<pid>-scale|tenant|gen|render`).
 * A selection with no lineage is unrelated traffic — it belongs to no run.
 */
const pipelineOfSelection = (selected: { type: string; detail?: BPEvent['detail'] }): string | undefined => {
  const detail = (selected.detail ?? {}) as {
    ctx?: { pipeline?: unknown; echo?: { pipeline?: unknown } }
    id?: unknown
  }
  if (typeof detail.ctx?.echo?.pipeline === 'string') return detail.ctx.echo.pipeline
  if (typeof detail.ctx?.pipeline === 'string') return detail.ctx.pipeline
  if (typeof detail.id === 'string') {
    const id = /^(.+)-(scale|tenant|gen|render|style)$/.exec(detail.id)
    if (id !== null) return id[1]
  }
  return undefined
}

/**
 * The pipeline id of a once-thread's REQUESTED event — the fallback when the
 * name carries no lineage (a STANDING thread's transform re-entry, e.g. the
 * render gate's `Transform(ui/render-gate => ui_render)`: the requester's
 * request detail still carries the per-trigger id, so the re-entry routes to
 * its run and the replay can reconstruct the gate's request).
 */
const pipelineOfRequest = (thread: Thread): string | undefined => {
  for (const rule of thread.rules) {
    if (rule.request !== undefined) {
      const pipeline = pipelineOfSelection(rule.request)
      if (pipeline !== undefined) return pipeline
    }
  }
  return undefined
}

/**
 * The raw capture consumer — mount beside the redacted lane
 * (`runtime.useTrace(createUiCapture({ sink }))`). The sink is the eval
 * harness's own code; {@link uiCaptureFileSink} is the durable default.
 *
 * Runs are keyed by pipeline lineage and MANY may be open at once
 * (interleaved triggers are the per-trigger pipeline's norm). The mint's
 * subscriber-order warp — the minted legs (and the first scale-check
 * selection) arrive BEFORE the render ingress trace — is handled by binding
 * lazily: the ingress trace is held until a pipeline id arrives, then
 * inserted at message 0 of the NEWEST unbound run (the mint order is
 * per-trigger sequential, so newest-unbound is unambiguous).
 */
export const createUiCapture = ({ sink }: { sink: (run: UiRun) => void }): ((trace: Trace) => void) => {
  const threads: Thread[] = []
  /** The open runs, keyed by pipeline id — several may be open (interleaving). */
  const open = new Map<string, UiRun>()
  /** Ingress traces not yet bound to a pipeline (the warp's true-order form). */
  const unboundIngress: SelectionTrace[] = []
  const ensureRun = (pipeline: string, timestamp: number): UiRun => {
    let run = open.get(pipeline)
    if (run === undefined) {
      run = { pipeline, startedAt: timestamp, threads: [], reentries: [], messages: [] }
      open.set(pipeline, run)
      // Bind the OLDEST held ingress (FIFO — triggers mint in arrival order).
      const ingress = unboundIngress.shift()
      if (ingress !== undefined) run.messages.push(ingress)
    }
    return run
  }
  const flush = (run: UiRun): void => {
    open.delete(run.pipeline)
    sink({ ...run, threads: [...threads], reentries: [...run.reentries] })
  }
  return (trace: Trace): void => {
    if (trace.kind === TRACE_MESSAGE_KINDS.thread_removed) {
      // The replay-contract subtraction: replay = thread_added minus
      // thread_removed + ingress. The standing set drops the removed thread
      // (matched on the instance identity — only instance-hash-keyed threads
      // are removal-addressable), so a later flush/replay derives the set
      // without it.
      const at = threads.findIndex((t) => t.instanceHash === trace.instanceHash)
      if (at !== -1) threads.splice(at, 1)
      return
    }
    if (trace.kind === TRACE_MESSAGE_KINDS.thread_added) {
      const thread = trace.thread
      if (thread.once === true) {
        // A once-thread re-entry: the minted pipeline legs, the transform
        // target requesters, the faculty result re-entries. Route by name
        // lineage, then by the REQUESTED event's id (a standing thread's
        // transform re-entry still names its pipeline in the request
        // detail). Unattributable onces (boot scans, replays) belong to no
        // run — dropped, never buffered into the next one.
        const pipeline = pipelineOfThread(thread) ?? pipelineOfRequest(thread)
        if (pipeline === undefined) return
        const run = ensureRun(pipeline, trace.timestamp)
        // The minted legs compose the run — they precede its first message
        // by construction (warp or true order), so they position-tag at 0;
        // mid-run re-entries tag at the index their target will take.
        run.reentries.push({ at: run.messages.length === 0 ? 0 : run.messages.length, thread: normalizeThread(thread) })
      } else {
        threads.push(thread)
      }
      return
    }
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = trace.selected
    if (selected.type === UI_RENDER_TRIGGER_TYPE && selected.ingress === true) {
      // The opening ingress — no lineage of its own. Warped order: the mint
      // already created the run — bind to the NEWEST unbound run (insert at
      // message 0, before the warp-arrived scale check). True order: hold
      // until the mint (or first id-bearing message) creates the run.
      const unbound = [...open.values()].filter(
        (run) => run.messages.length === 0 || run.messages[0]?.selected.type !== UI_RENDER_TRIGGER_TYPE,
      )
      const run = unbound.at(-1)
      if (run === undefined) {
        unboundIngress.push(trace)
        return
      }
      run.messages.unshift(trace)
      return
    }
    const pipeline = pipelineOfSelection(selected)
    if (pipeline === undefined) return // unrelated traffic — no run
    const run = ensureRun(pipeline, trace.timestamp)
    run.messages.push(trace)
    if (selected.type === 'ui_render') flush(run)
  }
}

/**
 * The durable default sink — one JSONL line per closed run under
 * `<root>/ui-runs.jsonl` (the host passes `<home>/captures`; the same
 * root-local trust domain as the redacted trace log).
 */
export const uiCaptureFileSink = ({ root }: { root: string }): ((run: UiRun) => void) => {
  let ready = false
  return (run: UiRun): void => {
    if (!ready) {
      mkdirSync(root, { recursive: true })
      ready = true
    }
    appendFileSync(join(root, 'ui-runs.jsonl'), `${JSON.stringify(run)}\n`, 'utf8')
  }
}

/** The thread set for a replay of the first `upTo` messages: the standing set + the re-entries that existed by then. */
const replayThreads = (run: UiRun, upTo: number): Thread[] => [
  ...run.threads,
  ...run.reentries.filter((reentry) => reentry.at < upTo).map((reentry) => reentry.thread),
]

/**
 * The replay pass — build the `frontier_analysis_request { op: 'replay' }` event over
 * a captured run. The default replays the whole run (the end state); pass
 * `upTo` (a message count) to replay a PREFIX and re-derive a mid-run state
 * — e.g. the index of the browser's scale reply for the preflight hold.
 * Trigger it through the composition; the frontier lane analyses and the
 * result re-enters as a selection carrying `{ frontier, stateKey, pendingCount }`.
 */
export const uiReplayRequest = (run: UiRun, upTo = run.messages.length): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
  detail: {
    id: `ui-replay-${uuid()}`,
    op: 'replay',
    // Threads are pure data (they serialize as JSON) but their listener
    // schemas aren't statically JsonValue — the same cast the composition's
    // candidate emission makes (b-program's thread-candidate precedent).
    input: {
      threads: replayThreads(run, upTo),
      messages: run.messages.slice(0, upTo),
    } as unknown as JsonObject,
  },
})
