import { describe, expect, test } from 'bun:test'
import { behavioral } from '../behavioral.ts'
import type { SelectionTrace } from '../behavioral.types.ts'
import { onSelection } from './helpers.ts'

const onType = (type: string) => ({ type })

describe('trigger', () => {
  test('routes triggered events into the BP engine', () => {
    const program = behavioral()
    const { addThread, trigger } = program
    const received: string[] = []

    addThread({
      name: 'listener',
      description: 'Test thread.',
      rules: [{ waitFor: [onType('allowed_event')] }],
      once: true,
    })
    onSelection(program, (selected) => {
      if (selected.type === 'allowed_event') received.push('allowed_event')
    })

    trigger({ type: 'allowed_event' })

    expect(received).toEqual(['allowed_event'])
  })

  test('preserves detail payload on triggered events', () => {
    const program = behavioral()
    const { addThread, trigger } = program
    const received: Array<{ id: number }> = []

    addThread({
      name: 'listener',
      description: 'Test thread.',
      rules: [{ waitFor: [onType('payload_event')] }],
      once: true,
    })
    onSelection(program, (selected) => {
      if (selected.type === 'payload_event') received.push(selected.detail as { id: number })
    })

    trigger({ type: 'payload_event', detail: { id: 99 } })

    expect(received).toEqual([{ id: 99 }])
  })
})

describe('trigger_error isolation — no error pooling across calls', () => {
  test('sequential invalid triggers each carry only their own errors', () => {
    const program = behavioral()
    const { trigger } = program

    const traces: Array<{ kind: string; error?: unknown[]; umwelt?: string }> = []
    program.useTrace((msg) => {
      if (msg.kind === 'trigger_error') traces.push(msg)
    })

    // Three invalid triggers with distinct failure shapes
    //@ts-expect-error: test
    trigger({ type: 42 }) // wrong type field
    //@ts-expect-error: test
    trigger({ umwelt: 'no-type-here' }) // missing type
    //@ts-expect-error: test
    trigger({ type: 'x', umwelt: 123 }) // umwelt is a number

    expect(traces).toHaveLength(3)

    // Each trace's errors match only that call's validation failure
    const first = traces[0]!
    const second = traces[1]!
    const third = traces[2]!

    // First: type is 42 (not string)
    expect(Array.isArray(first.error)).toBe(true)
    expect((first.error as unknown[]).length).toBeGreaterThan(0)
    const firstMsgs = (first.error as Array<{ message?: string }>).map((e) => e.message ?? '').join(' ')
    expect(firstMsgs).toContain('string')

    // Second: missing type — different error than the first
    expect(Array.isArray(second.error)).toBe(true)
    const secondMsgs = (second.error as Array<{ message?: string; params?: Record<string, unknown> }>)
      .map((e) => e.message ?? '')
      .join(' ')
    expect(secondMsgs).toContain('required')

    // Third: umwelt is a number — error mentions umwelt, not type
    expect(Array.isArray(third.error)).toBe(true)
    const thirdStr = JSON.stringify(third.error)
    expect(thirdStr).toContain('umwelt')

    // Critical: the first trace's errors must NOT contain the second or third call's errors
    const firstStr = JSON.stringify(first.error)
    expect(firstStr).not.toContain('required')
    expect(firstStr).not.toContain('umwelt')
  })

  test('valid trigger between invalid ones does not leak stale errors into the next trace', () => {
    const program = behavioral()
    const { addThread, trigger } = program

    const triggerErrors: unknown[][] = []
    program.useTrace((msg) => {
      if (msg.kind === 'trigger_error') triggerErrors.push(msg.error ?? [])
    })

    addThread({
      name: 'listener',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'valid_event' }] }],
      once: true,
    })

    // Invalid → valid → invalid
    //@ts-expect-error: test
    trigger({ type: 42 })
    trigger({ type: 'valid_event' })
    //@ts-expect-error: test
    trigger({ umwelt: 'missing-type' })

    // Two trigger_error traces (the valid one doesn't emit trigger_error)
    expect(triggerErrors).toHaveLength(2)

    // The second invalid trigger's errors are fresh — not accumulated from the first
    const firstCount = (triggerErrors[0] as unknown[]).length
    const secondCount = (triggerErrors[1] as unknown[]).length
    // First: type is 42 → 1 error; Second: umwelt is number → 1 error
    // If pooled, the second would have ≥2 errors
    expect(firstCount).toBe(1)
    expect(secondCount).toBe(1)
  })
})

describe('trigger — event-carried umwelt', () => {
  test('stamps the event umwelt on the selected candidate', () => {
    const program = behavioral()
    const { addThread, trigger, useTrace } = program
    const selections: SelectionTrace[] = []
    useTrace((msg) => {
      if (msg.kind === 'selection') selections.push(msg)
    })

    addThread({ name: 'listener', description: 'Test thread.', rules: [{ waitFor: [onType('evt')] }], once: true })
    trigger({ type: 'evt', umwelt: 'umwelt-1' })

    const selected = selections.find((trace) => trace.selected.type === 'evt')
    expect(selected).toBeDefined()
    expect(selected!.selected.umwelt).toBe('umwelt-1')
  })

  test('absent umwelt selects at root (no umwelt stamp)', () => {
    const program = behavioral()
    const { addThread, trigger, useTrace } = program
    const selections: SelectionTrace[] = []
    useTrace((msg) => {
      if (msg.kind === 'selection') selections.push(msg)
    })

    addThread({ name: 'listener', description: 'Test thread.', rules: [{ waitFor: [onType('evt')] }], once: true })
    trigger({ type: 'evt' })

    const selected = selections.find((trace) => trace.selected.type === 'evt')
    expect(selected).toBeDefined()
    expect(selected!.selected.umwelt).toBeUndefined()
  })

  test('an invalid trigger echoes the attempted umwelt on the error trace', () => {
    const program = behavioral()
    const { trigger } = program
    const triggerErrors: Array<{ umwelt?: string }> = []
    program.useTrace((msg) => {
      if (msg.kind === 'trigger_error') triggerErrors.push(msg)
    })
    //@ts-expect-error: test
    trigger({ type: 42, umwelt: 'umwelt-err' })

    expect(triggerErrors).toHaveLength(1)
    expect(triggerErrors[0]!.umwelt).toBe('umwelt-err')
  })

  test('an invalid trigger with no umwelt omits the umwelt on the error trace', () => {
    const program = behavioral()
    const { trigger } = program
    const triggerErrors: Array<{ umwelt?: string }> = []
    program.useTrace((msg) => {
      if (msg.kind === 'trigger_error') triggerErrors.push(msg)
    })
    //@ts-expect-error: test
    trigger({ type: 42 })

    expect(triggerErrors).toHaveLength(1)
    expect(triggerErrors[0]!.umwelt).toBeUndefined()
  })
})
