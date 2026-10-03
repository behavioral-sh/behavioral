import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { DeadlockTrace, FrontierTrace, SelectionTrace, Trace } from '../behavioral.types.ts'

const onType = (type: string) => ({
  type,
})

describe(TRACE_MESSAGE_KINDS.deadlock, () => {
  test('publishes deadlock trace when candidates exist but none are selectable', () => {
    const traces: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
    })

    addThread({ name: 'safety', description: 'Test thread.', rules: [{ block: [onType('dangerous')] }] })
    addThread({ name: 'interruptor', description: 'Test thread.', rules: [{ interrupt: [onType('dangerous')] }] })

    trigger({ type: 'dangerous' })

    const frontiers = traces.filter((s): s is FrontierTrace => s.kind === TRACE_MESSAGE_KINDS.frontier)
    expect(frontiers).toHaveLength(1)
    expect(frontiers[0]!.status).toBe('deadlock')
    expect(frontiers[0]!.candidates).toEqual([
      {
        type: 'dangerous',
        ingress: true,
        priority: 0,
      },
    ])
    expect(frontiers[0]!.enabled).toEqual([])

    const deadlocks = traces.filter((s): s is DeadlockTrace => s.kind === TRACE_MESSAGE_KINDS.deadlock)
    expect(deadlocks).toHaveLength(1)
    expect(deadlocks[0]!.step).toBe(frontiers[0]!.step)

    const selectionTraces = traces.filter((s) => s.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selectionTraces).toHaveLength(0)

    const frontierIndex = traces.findIndex((trace) => trace.kind === TRACE_MESSAGE_KINDS.frontier)
    const deadlockIndex = traces.findIndex((trace) => trace.kind === TRACE_MESSAGE_KINDS.deadlock)
    expect(frontierIndex).toBeGreaterThanOrEqual(0)
    expect(deadlockIndex).toBeGreaterThan(frontierIndex)
  })

  test('does not publish deadlock trace when no candidates exist', () => {
    const traces: Trace[] = []
    const { addThread, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
    })

    addThread({ name: 'watcher', description: 'Test thread.', rules: [{ waitFor: [onType('dangerous')] }] })

    // Provisioning traces (thread_added) do not step the program — no
    // pending_bids/frontier/deadlock until a trigger arrives.
    expect(traces.map((t) => t.kind)).toEqual(['thread_added'])
  })

  test('publishes selection trace when enabled candidates exist and keeps priority selection behavior', () => {
    const traces: Trace[] = []
    const selected: string[] = []
    const { addThread, trigger, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
      if (trace.kind === 'selection') selected.push(trace.selected.type)
    })

    addThread({ name: 'low', description: 'Test thread.', rules: [{ request: { type: 'low' } }], once: true })
    addThread({ name: 'high', description: 'Test thread.', rules: [{ request: { type: 'high' } }], once: true })

    trigger({ type: 'tick' })

    expect(selected.filter((t) => t !== 'tick')[0]).toBe('low')
    const deadlocks = traces.filter((s): s is DeadlockTrace => s.kind === TRACE_MESSAGE_KINDS.deadlock)
    expect(deadlocks).toHaveLength(0)
    const frontiers = traces.filter((s): s is FrontierTrace => s.kind === TRACE_MESSAGE_KINDS.frontier)
    const selections = traces.filter((s): s is SelectionTrace => s.kind === TRACE_MESSAGE_KINDS.selection)
    expect(frontiers.length).toBeGreaterThan(0)
    expect(selections.length).toBeGreaterThan(0)
    const lowSelection = selections.find((selection) => selection.selected.type === 'low')
    expect(lowSelection).toBeDefined()
    expect(lowSelection!.selected.ingress).toBeUndefined()
    const lowFrontier = frontiers.find((frontier) => frontier.step === lowSelection!.step)
    expect(lowFrontier).toBeDefined()
    expect(lowFrontier!.enabled.some((candidate) => candidate.type === 'low')).toBe(true)
    const frontierIndex = traces.findIndex((trace) => trace.kind === TRACE_MESSAGE_KINDS.frontier)
    const selectionIndex = traces.findIndex((trace) => trace.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selectionIndex).toBeGreaterThan(frontierIndex)
  })

  test('selection trace reports the chosen candidate event', () => {
    const traces: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
    })

    addThread({
      name: 'blockSecond',
      description: 'Test thread.',
      rules: [
        {
          block: [
            {
              type: 'same_type',
              detailSchema: {
                type: 'object' as const,
                properties: { n: { const: 2 } },
                required: ['n'],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    })
    addThread({
      name: 'first',
      description: 'Test thread.',
      rules: [{ request: { type: 'same_type', detail: { n: 1 } } }],
      once: true,
    })
    addThread({
      name: 'second',
      description: 'Test thread.',
      rules: [{ request: { type: 'same_type', detail: { n: 2 } } }],
      once: true,
    })

    trigger({ type: 'kickoff' })

    const frontier = traces.find(
      (trace): trace is FrontierTrace =>
        trace.kind === TRACE_MESSAGE_KINDS.frontier &&
        trace.status === 'ready' &&
        trace.candidates.some((candidate) => candidate.type === 'same_type'),
    )
    expect(frontier).toBeDefined()
    expect(frontier!.candidates.filter((candidate) => candidate.type === 'same_type')).toHaveLength(2)

    const selection = traces.find(
      (trace): trace is SelectionTrace =>
        trace.kind === TRACE_MESSAGE_KINDS.selection && trace.selected.type === 'same_type',
    )
    expect(selection).toBeDefined()
    const selectionFrontier = traces.find(
      (trace): trace is FrontierTrace => trace.kind === TRACE_MESSAGE_KINDS.frontier && trace.step === selection!.step,
    )
    expect(selectionFrontier).toBeDefined()
    expect(selectionFrontier!.candidates.some((candidate) => candidate.type === 'same_type')).toBe(true)
    expect(selection!.selected.detail).toEqual({ n: 1 })
  })
})
