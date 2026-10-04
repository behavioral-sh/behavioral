import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import type { behavioral } from '../behavioral.ts'
import type { Disconnect, SelectionTrace, Trace } from '../behavioral.types.ts'

type BehavioralApi = ReturnType<typeof behavioral>

/**
 * Collects all traces emitted by a behavioral program.
 *
 * Post-hoc filtering in the test body — the collector captures everything so
 * tests can join across kinds (e.g. `deadlock.step === frontier.step`).
 *
 * @returns `{ traces, disconnect }` — the array fills as the program runs.
 */
export const traceCollector = (program: BehavioralApi): { traces: Trace[]; disconnect: Disconnect } => {
  const traces: Trace[] = []
  const disconnect = program.useTrace((msg: Trace) => {
    traces.push(msg)
  })
  return { traces, disconnect }
}

/**
 * Subscribes a handler to Selection traces, optionally filtered by `umwelt`.
 *
 * Replaces the old `useAddHandler(type, handler)` pattern — the handler fires
 * when an event of the matching type is selected.
 *
 * @returns A disconnect function.
 */
export const onSelection = (
  program: BehavioralApi,
  handler: (selected: SelectionTrace['selected']) => void | Promise<void>,
  umwelt?: string,
): Disconnect => {
  return program.useTrace((msg: Trace) => {
    if (msg.kind !== TRACE_MESSAGE_KINDS.selection) return
    if (umwelt !== undefined && msg.selected.umwelt !== umwelt) return
    void handler(msg.selected)
  })
}

/** Extracts all Selection traces from a collected array. */
export const selections = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((trace): trace is SelectionTrace => trace.kind === TRACE_MESSAGE_KINDS.selection)
