import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { AddThreadError, Thread, ThreadAddedTrace, ThreadRemovedTrace } from '../behavioral.types.ts'
import { selections, traceCollector } from './helpers.ts'

describe('removeThread', () => {
  test('a removed standing thread stops matching and emits thread_removed at the next super-step', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    program.addThread({
      name: 'greeter',
      description: 'Test thread.',
      instanceHash: 12345,
      rules: [{ waitFor: [{ type: 'start' }] }, { request: { type: 'done' } }],
    })
    program.removeThread({ instanceHash: 12345 })
    // Removal is staged — inert until a super-step pumps (the addThread mirror).
    expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.thread_removed)).toBe(false)
    program.trigger({ type: 'start' })
    const removed = traces.find((t): t is ThreadRemovedTrace => t.kind === TRACE_MESSAGE_KINDS.thread_removed)
    expect(removed).toBeDefined()
    expect(removed?.instanceHash).toBe(12345)
    expect(removed?.thread.name).toBe('greeter')
    // The thread never re-arms: no `done` request is ever selected.
    expect(selections(traces).some((s) => s.selected.type === 'done')).toBe(false)
  })

  test('a removed thread\u2019s block dies with its bid — the previously blocked type becomes selectable', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    program.addThread({
      name: 'gate',
      description: 'Test thread.',
      instanceHash: 777,
      rules: [{ block: [{ type: 'cold' }] }],
    })
    // While the gate is live, cold is blocked (deadlock, never selected).
    program.trigger({ type: 'cold' })
    expect(selections(traces).some((s) => s.selected.type === 'cold')).toBe(false)
    program.removeThread({ instanceHash: 777 })
    program.trigger({ type: 'cold' })
    expect(selections(traces).some((s) => s.selected.type === 'cold')).toBe(true)
  })

  test('removal staged from a selection listener is effective the next super-step, not the current one', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    program.addThread({
      name: 'later',
      description: 'Test thread.',
      instanceHash: 42,
      rules: [{ waitFor: [{ type: 'go' }] }, { request: { type: 'later_done' } }],
      once: true,
    })
    program.useTrace((trace) => {
      if (trace.kind === TRACE_MESSAGE_KINDS.selection && trace.selected.type === 'go') {
        program.removeThread({ instanceHash: 42 })
      }
    })
    program.trigger({ type: 'go' })
    // `later` was waiting on `go`: the removal is staged during the `go`
    // selection's listener (its bid is mid-resumption) — effective the NEXT
    // super-step. The wait leg still consumed `go`; `later_done` never fires.
    const removed = traces.find((t): t is ThreadRemovedTrace => t.kind === TRACE_MESSAGE_KINDS.thread_removed)
    expect(removed).toBeDefined()
    expect(removed?.thread.name).toBe('later')
    expect(selections(traces).some((s) => s.selected.type === 'later_done')).toBe(false)
  })

  test('an unknown hash, an absent hash, and an exhausted once-thread are clean no-ops', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    program.addThread({
      name: 'ephemeral',
      description: 'Test thread.',
      once: true,
      rules: [{ request: { type: 'one_shot' } }],
    })
    program.trigger({ type: 'boot' })
    // The once-thread exhausted (its bid is gone) — removal is a no-op.
    program.removeThread({ instanceHash: 999 })
    program.removeThread({})
    program.removeThread({ instanceHash: 12345 }) // never mounted
    expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.thread_removed)).toBe(false)
    expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.add_thread_error)).toBe(false)
  })

  test('once-thread re-entries a removed thread already minted stay — no cascading kill', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    program.addThread({
      name: 'shaper',
      description: 'Test thread.',
      instanceHash: 7,
      rules: [
        {
          transform: [{ type: 'arrives', query: '.', target: 'reshaped' }],
        },
      ],
    })
    program.trigger({ type: 'arrives', detail: { v: 1 } })
    // The transform matched: the engine minted the Transform re-entry
    // once-thread (an ephemeral identity). Remove the shaper; the re-entry
    // STAYS and still requests its target.
    program.removeThread({ instanceHash: 7 })
    program.trigger({ type: 'pump' })
    expect(selections(traces).some((s) => s.selected.type === 'reshaped')).toBe(true)
    // The shaper itself no longer matches: a second arrival transforms nothing.
    program.trigger({ type: 'arrives', detail: { v: 2 } })
    program.trigger({ type: 'pump' })
    expect(selections(traces).filter((s) => s.selected.type === 'reshaped')).toHaveLength(1)
  })

  test('a live same-identity add is rejected — never a silent replacement', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    const thread = (): Thread => ({
      name: 'twin',
      description: 'Test thread.',
      instanceHash: 321,
      rules: [{ waitFor: [{ type: 'go' }] }],
    })
    program.addThread(thread())
    program.addThread(thread())
    const error = traces.find((t): t is AddThreadError => t.kind === TRACE_MESSAGE_KINDS.add_thread_error)
    expect(error).toBeDefined()
    expect(String(error?.error[0])).toContain('duplicate thread identity')
    // The remove-then-remount wave is the one sanctioned overwrite.
    program.removeThread({ instanceHash: 321 })
    program.trigger({ type: 'go' }) // pumps the staged removal
    program.addThread(thread())
    const added = traces.filter((t): t is ThreadAddedTrace => t.kind === TRACE_MESSAGE_KINDS.thread_added)
    expect(added).toHaveLength(2)
  })
})
