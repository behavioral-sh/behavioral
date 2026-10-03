import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { FrontierTrace, IdleTrace, Trace } from '../behavioral.types.ts'

const onType = (type: string) => ({ type })

describe(TRACE_MESSAGE_KINDS.idle, () => {
  test('publishes an idle trace when no candidates remain after activity', () => {
    const traces: Trace[] = []
    const { addThread, step, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
    })

    // A one-shot request: the super-step selects it, the thread completes, and
    // the next frontier has no candidates at all — quiescent, not deadlocked.
    addThread({ name: 'once', description: 'Test thread.', once: true, rules: [{ request: onType('work') }] })
    step()

    const idles = traces.filter((trace): trace is IdleTrace => trace.kind === TRACE_MESSAGE_KINDS.idle)
    expect(idles).toHaveLength(1)

    const lastFrontier = traces
      .filter((trace): trace is FrontierTrace => trace.kind === TRACE_MESSAGE_KINDS.frontier)
      .at(-1)
    expect(lastFrontier?.status).toBe('idle')
    expect(idles[0]?.step).toBe(lastFrontier?.step)

    // The idle trace is terminal: it follows the last selection.
    const lastSelectionIndex = traces.map((trace) => trace.kind).lastIndexOf(TRACE_MESSAGE_KINDS.selection)
    const idleIndex = traces.findIndex((trace) => trace.kind === TRACE_MESSAGE_KINDS.idle)
    expect(idleIndex).toBeGreaterThan(lastSelectionIndex)
  })

  test('does not publish an idle trace when candidates deadlock', () => {
    const traces: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
    })

    addThread({ name: 'safety', description: 'Test thread.', rules: [{ block: [onType('dangerous')] }] })
    trigger({ type: 'dangerous' })

    expect(traces.filter((trace) => trace.kind === TRACE_MESSAGE_KINDS.deadlock)).toHaveLength(1)
    expect(traces.filter((trace) => trace.kind === TRACE_MESSAGE_KINDS.idle)).toHaveLength(0)
  })
})
