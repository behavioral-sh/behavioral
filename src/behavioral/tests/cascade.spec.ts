import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS as K } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { StepTrace } from '../behavioral.types.ts'
import { onSelection, selections, traceCollector } from './helpers.ts'

const onType = (type: string) => ({ type })

describe('the super-step cascade (characterization)', () => {
  test('a self-sustaining request loop selects in order until a block ends it', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)

    // A looping thread re-requests `tick` each super-step — a self-sustaining
    // request loop. The stopper waits through STEPS ticks, then blocks the
    // type forever, deterministically ending the cascade in a deadlock.
    const STEPS = 5
    program.addThread({ name: 'looper', description: 'Test thread.', rules: [{ request: onType('tick') }] })
    program.addThread({
      name: 'stopper',
      description: 'Test thread.',
      rules: [...Array(STEPS).fill({ waitFor: [onType('tick')] }), { block: [onType('tick')] }],
    })
    program.step()

    // The exact selected-event sequence: STEPS ticks, then the block ends it.
    expect(selections(traces).map((s) => s.selected.type)).toEqual(Array(STEPS).fill('tick'))
    // Selections are internal channel (thread requests, not trigger ingress).
    expect(selections(traces).map((s) => s.selected.ingress === true)).toEqual(Array(STEPS).fill(false))
    // Step numbers advance in lockstep with the selections.
    expect(selections(traces).map((s) => s.step)).toEqual([...Array(STEPS).keys()])
    // And the exact trace-kind sequence: each super-step is step →
    // pending_bids → frontier → selection; the blocked end is step →
    // pending_bids → frontier → deadlock. This sequence is the oracle the
    // trampoline must reproduce byte-identical.
    const period = [K.step, K.pending_bids, K.frontier, K.selection]
    expect(traces.map((t) => t.kind)).toEqual([
      K.thread_added,
      K.thread_added,
      ...Array.from({ length: STEPS }, () => period).flat(),
      K.step,
      K.pending_bids,
      K.frontier,
      K.deadlock,
    ])
  })
})

describe('cascade re-entrancy — a nested step from a selection listener', () => {
  test('the nested super-step completes before the outer cascade continues', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)

    // The pump-shaped re-entry: a selection listener (the composition's pump)
    // adds a thread and calls step() from inside the running cascade. The
    // nested super-step (pong) must run to completion — its own selection and
    // drain — before the outer cascade continues to its drain (idle).
    program.addThread({ name: 'pinger', description: 'Test thread.', once: true, rules: [{ request: onType('ping') }] })
    const disconnect = onSelection(program, (selected) => {
      if (selected.type !== 'ping') return
      disconnect()
      program.addThread({
        name: 'replier',
        description: 'Test thread.',
        once: true,
        rules: [{ request: onType('pong') }],
      })
      program.step()
    })
    program.step()

    expect(selections(traces).map((s) => s.selected.type)).toEqual(['ping', 'pong'])
    expect(traces.map((t) => t.kind)).toEqual([
      K.thread_added, // pinger registered
      K.step,
      K.pending_bids,
      K.frontier,
      K.selection, // ping (outer cascade)
      K.thread_added, // replier registered — the nested re-entry
      K.step,
      K.pending_bids,
      K.frontier,
      K.selection, // pong (the nested super-step, completed first)
      K.step,
      K.pending_bids,
      K.frontier,
      K.idle, // the outer cascade's drain
    ])
  })

  test('a nested trigger re-enters with its ingress channel intact', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)

    // The trigger-shaped re-entry: a selection listener triggers an external
    // event mid-cascade. The nested step carries ingress: true on its step
    // trace and on the resulting candidate.
    program.addThread({ name: 'pinger', description: 'Test thread.', once: true, rules: [{ request: onType('ping') }] })
    const disconnect = onSelection(program, (selected) => {
      if (selected.type !== 'ping') return
      disconnect()
      program.trigger({ type: 'pong' })
    })
    program.step()

    const pong = selections(traces).find((s) => s.selected.type === 'pong')
    expect(pong).toBeDefined()
    expect(pong?.selected.ingress).toBe(true)
    // Step-trace ingress flags: the outer step (internal), the nested
    // trigger's step (external), the drain step (internal).
    const stepIngress = traces.filter((t): t is StepTrace => t.kind === K.step).map((t) => t.ingress === true)
    expect(stepIngress).toEqual([false, true, false])
    expect(selections(traces).map((s) => s.selected.type)).toEqual(['ping', 'pong'])
    expect(traces.map((t) => t.kind)).toEqual([
      K.thread_added, // pinger registered
      K.step,
      K.pending_bids,
      K.frontier,
      K.selection, // ping (outer cascade)
      K.step,
      K.pending_bids,
      K.frontier,
      K.selection, // pong (the nested trigger's super-step, completed first)
      K.step,
      K.pending_bids,
      K.frontier,
      K.idle, // the drain
    ])
  })
})
