import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { DeadlockTrace, FrontierTrace, SelectionTrace, ThreadAddedTrace, Trace } from '../behavioral.types.ts'
import { onSelection } from './helpers.ts'

const onType = (type: string) => ({ type })

describe('addThread', () => {
  test('supports dynamic thread installation from trace listeners', () => {
    const actual: string[] = []
    const program = behavioral()
    const { addThread, trigger } = program

    addThread({ name: 'addHotOnce', description: 'Test thread.', rules: [{ request: { type: 'hot_1' } }], once: true })
    addThread({
      name: 'mixHotCold',
      description: 'Test thread.',
      rules: [
        {
          waitFor: [onType('hot_1'), onType('hot')],
          block: [onType('cold')],
        },
        {
          waitFor: [onType('cold')],
          block: [onType('hot_1'), onType('hot')],
        },
      ],
    })

    onSelection(program, (selected) => {
      if (selected.type === 'hot_1') {
        actual.push('hot')
        trigger({ type: 'cold' })
        addThread({
          name: 'addMoreHot',
          description: 'Test thread.',
          rules: [{ request: { type: 'hot' } }, { request: { type: 'hot' } }],
          once: true,
        })
        addThread({
          name: 'addMoreCold',
          description: 'Test thread.',
          rules: [{ request: { type: 'cold' } }, { request: { type: 'cold' } }],
          once: true,
        })
      }
      if (selected.type === 'cold') {
        actual.push('cold')
      }
      if (selected.type === 'hot') {
        actual.push('hot')
      }
    })

    trigger({ type: 'start' })

    expect(actual).toHaveLength(6)
    expect(actual.filter((event) => event === 'hot')).toHaveLength(3)
    expect(actual.filter((event) => event === 'cold')).toHaveLength(3)
  })

  test('frontier and selection traces include worker requests and selected events', () => {
    const traces: Trace[] = []
    const completions: string[] = []
    const program = behavioral()
    const { addThread, trigger, useTrace } = program

    useTrace((trace: Trace) => {
      traces.push(trace)
      if (trace.kind === 'selection' && (trace.selected.type === 'done_a' || trace.selected.type === 'done_b')) {
        completions.push('done')
      }
    })

    addThread({
      name: 'workerA',
      description: 'Test thread.',
      rules: [{ waitFor: [onType('start')] }, { request: { type: 'done_a' } }],
      once: true,
    })
    addThread({
      name: 'workerB',
      description: 'Test thread.',
      rules: [{ waitFor: [onType('start')] }, { request: { type: 'done_b' } }],
      once: true,
    })

    trigger({ type: 'start' })

    expect(completions).toHaveLength(2)
    const frontierTraces = traces.filter(
      (trace): trace is FrontierTrace => trace.kind === TRACE_MESSAGE_KINDS.frontier && trace.status === 'ready',
    )
    const doneCandidates = frontierTraces
      .flatMap((trace) => trace.candidates)
      .filter((candidate) => candidate.type === 'done_a' || candidate.type === 'done_b')
    expect(new Set(doneCandidates.map((candidate) => candidate.type))).toEqual(new Set(['done_a', 'done_b']))
    expect(doneCandidates.every((candidate) => candidate.ingress === undefined)).toBe(true)

    const selectionTraces = traces.filter(
      (trace): trace is SelectionTrace => trace.kind === TRACE_MESSAGE_KINDS.selection,
    )
    expect(selectionTraces.some((trace) => trace.selected.type === 'done_a')).toBe(true)
    expect(selectionTraces.some((trace) => trace.selected.type === 'done_b')).toBe(true)
  })

  test('deadlock traces publish frontier status and step continuity', () => {
    const traces: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()

    useTrace((trace: Trace) => {
      traces.push(trace)
    })

    addThread({ name: 'guard', description: 'Test thread.', rules: [{ block: [onType('dangerous')] }] })
    addThread({ name: 'watchdog', description: 'Test thread.', rules: [{ interrupt: [onType('dangerous')] }] })
    addThread({
      name: 'requester',
      description: 'Test thread.',
      rules: [{ request: { type: 'dangerous' } }],
      once: true,
    })

    trigger({ type: 'start' })

    const deadlockFrontier = traces.find(
      (trace): trace is FrontierTrace => trace.kind === TRACE_MESSAGE_KINDS.frontier && trace.status === 'deadlock',
    )
    expect(deadlockFrontier).toBeDefined()
    expect(deadlockFrontier!.candidates.some((candidate) => candidate.type === 'dangerous')).toBe(true)
    expect(deadlockFrontier!.enabled).toEqual([])

    const deadlockSnapshot = traces.find((trace): trace is DeadlockTrace => trace.kind === TRACE_MESSAGE_KINDS.deadlock)
    expect(deadlockSnapshot).toBeDefined()
    expect(deadlockSnapshot!.step).toBe(deadlockFrontier!.step)
  })
})

describe('addThread quiescence', () => {
  test('addThread alone does not step — the program stays idle until a trigger arrives', () => {
    const traces: Trace[] = []
    const program = behavioral()
    const { addThread } = program
    program.useTrace((trace: Trace) => {
      traces.push(trace)
    })

    addThread({ name: 'requester', description: 'Test thread.', rules: [{ request: { type: 'x' } }], once: true })

    // `addThread` is inert beyond its provision trace: no super-step runs
    // until an event enters via `trigger` or `step`.
    expect(traces.map((t) => t.kind)).toEqual([TRACE_MESSAGE_KINDS.thread_added])
  })

  test('a registered thread emits thread_added carrying the full definition — the provision record', () => {
    const added: Trace[] = []
    const program = behavioral()
    const { addThread, useTrace } = program
    useTrace((trace: Trace) => {
      if (trace.kind === TRACE_MESSAGE_KINDS.thread_added) added.push(trace)
    })

    const thread = {
      name: 'provisioned',
      description: 'Test thread.',
      umwelt: 'demo',
      once: true as const,
      rules: [{ request: { type: 'go' } }],
    }
    addThread(thread)

    expect(added).toHaveLength(1)
    const trace = added[0] as ThreadAddedTrace
    // The full validated Thread — the trace log is self-contained: replay =
    // thread_added payloads + ingress events.
    expect(trace.thread).toEqual(thread)
    expect(trace.instanceId).toBeTypeOf('string')

    // An invalid thread emits add_thread_error, never thread_added.
    addThread({ name: 'no-rules' } as never)
    expect(added).toHaveLength(1)
  })
})
