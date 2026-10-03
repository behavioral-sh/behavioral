import { afterEach, describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { Trace } from '../behavioral.types.ts'

const originalConsoleError = console.error
const consoleErrors: unknown[][] = []

describe('useTrace — listener isolation and subscription semantics', () => {
  afterEach(() => {
    console.error = originalConsoleError
    consoleErrors.length = 0
  })

  const captureConsoleError = () => {
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args)
    }
  }

  test('a listener that throws synchronously does not prevent later listeners', () => {
    captureConsoleError()
    const { useTrace, addThread, trigger } = behavioral()

    const received: string[] = []
    useTrace(() => {
      throw new Error('listener 1 threw')
    })
    useTrace((msg: Trace) => {
      received.push(msg.kind)
    })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true })
    trigger({ type: 'start' })

    // The throwing listener was isolated; the second listener still received traces
    expect(received).toContain(TRACE_MESSAGE_KINDS.selection)
    expect(received).toContain(TRACE_MESSAGE_KINDS.pending_bids)
  })

  test('a listener that throws has its error surfaced via console.error', () => {
    captureConsoleError()
    const { useTrace, addThread, trigger } = behavioral()

    useTrace(() => {
      throw new Error('listener 1 threw')
    })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true })
    trigger({ type: 'start' })

    const threw = consoleErrors.find((args) => String(args[0]).includes('trace listener threw'))
    expect(threw).toBeDefined()
    // First trace the listener sees is the provision record (thread_added
    // fires at addThread, before any step trace)
    expect(threw![1]).toBe(TRACE_MESSAGE_KINDS.thread_added)
  })

  test('a rejecting async listener does not produce an unhandled rejection', () => {
    captureConsoleError()
    const { useTrace, addThread, trigger } = behavioral()

    useTrace(async () => {
      throw new Error('async listener rejection')
    })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true })
    trigger({ type: 'start' })
    // The rejection is captured by the subject's Promise.catch — no unhandled rejection.
  })

  test('the engine keeps stepping after a listener throws mid-superstep', () => {
    captureConsoleError()
    const { addThread, trigger, useTrace } = behavioral()

    useTrace(() => {
      throw new Error('poison listener')
    })

    const selections: string[] = []
    useTrace((msg: Trace) => {
      if (msg.kind === TRACE_MESSAGE_KINDS.selection) selections.push(msg.selected.type)
    })

    addThread({ name: 'a', description: 'Test thread.', rules: [{ request: { type: 'x' } }], once: true })
    trigger({ type: 'start' })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'y' } }], once: true })
    trigger({ type: 'advance' })

    // Both selections arrived despite the poison listener
    expect(selections).toContain('x')
    expect(selections).toContain('y')
  })

  test('listeners receive traces in subscription order', () => {
    const { useTrace, addThread, trigger } = behavioral()

    const order: string[] = []
    useTrace(() => {
      order.push('first')
    })
    useTrace(() => {
      order.push('second')
    })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true })
    trigger({ type: 'start' })

    // For each trace published, first listener fires before second
    const firstCount = order.filter((entry) => entry === 'first').length
    const secondCount = order.filter((entry) => entry === 'second').length
    expect(firstCount).toBe(secondCount)
    expect(order[0]).toBe('first')
    expect(order[1]).toBe('second')
  })

  test('disconnect removes the listener', () => {
    const { useTrace, addThread, trigger } = behavioral()

    let calls = 0
    const disconnect = useTrace(() => {
      calls += 1
    })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true })
    trigger({ type: 'start' })
    expect(calls).toBeGreaterThan(0)

    const before = calls
    disconnect()
    addThread({ name: 'c', description: 'Test thread.', rules: [{ request: { type: 'b' } }], once: true })
    trigger({ type: 'advance' })
    expect(calls).toBe(before)
  })

  test('self-disconnect inside a listener takes effect on subsequent broadcasts', () => {
    const { useTrace, addThread, trigger } = behavioral()

    const seen: number[] = []
    let disconnect: () => void
    disconnect = useTrace(() => {
      seen.push(1)
      disconnect()
    })
    useTrace(() => {
      seen.push(2)
    })

    addThread({ name: 'b', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true })
    trigger({ type: 'start' })

    // First super-step: both listeners fired (in-order), then listener 1 self-removed
    expect(seen).toContain(1)
    expect(seen).toContain(2)

    const snapshotAfterFirst = seen.length

    addThread({ name: 'c', description: 'Test thread.', rules: [{ request: { type: 'b' } }], once: true })
    trigger({ type: 'advance' })

    // Second super-step: only listener 2 fires
    const seenAfterSecond = seen.slice(snapshotAfterFirst)
    expect(seenAfterSecond.every((entry) => entry === 2)).toBe(true)
  })

  test('re-entrancy: a listener calling trigger does not corrupt the superstep', () => {
    const { addThread, trigger, useTrace } = behavioral()

    const selections: string[] = []
    let injected = false

    useTrace((msg: Trace) => {
      if (msg.kind === TRACE_MESSAGE_KINDS.selection) {
        selections.push(msg.selected.type)
        // Re-enter: inject new work from inside the listener
        if (!injected) {
          injected = true
          addThread({
            name: 'injected',
            description: 'Test thread.',
            rules: [{ request: { type: 'injected_event' } }],
            once: true,
          })
          trigger({ type: 'advance' })
        }
      }
    })

    addThread({ name: 'a', description: 'Test thread.', rules: [{ request: { type: 'x' } }], once: true })
    trigger({ type: 'start' })

    // Both the original event and the injected event were selected
    expect(selections).toContain('x')
    expect(selections).toContain('injected_event')
  })
})
