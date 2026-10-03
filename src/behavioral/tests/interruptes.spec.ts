import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { Trace } from '../behavioral.types.ts'
import { onSelection } from './helpers.ts'

const onType = (type: string) => ({ type })

const addHot = {
  rules: [{ waitFor: [onType('add')], interrupt: [onType('terminate')] }, { request: { type: 'hot' } }],
}

describe('interrupt', () => {
  test('should not interrupt', () => {
    const actual: string[] = []
    const program = behavioral()
    const { addThread, trigger } = program
    addThread({ name: 'addHot', description: 'Test thread.', ...addHot })
    onSelection(program, (selected) => {
      if (selected.type === 'hot') actual.push('hot')
    })
    trigger({ type: 'add' })
    trigger({ type: 'add' })
    trigger({ type: 'add' })
    expect(actual).toEqual(['hot', 'hot', 'hot'])
  })

  test('should interrupt', () => {
    const traces: Trace[] = []
    const actual: string[] = []
    const program = behavioral()
    const { addThread, trigger, useTrace } = program
    useTrace((trace: Trace) => {
      traces.push(trace)
    })
    addThread({ name: 'addHot', description: 'Test thread.', ...addHot })
    onSelection(program, (selected) => {
      if (selected.type === 'hot') actual.push('hot')
    })
    trigger({ type: 'add' })
    trigger({ type: 'add' })
    trigger({ type: 'terminate' })
    trigger({ type: 'add' })
    expect(actual).toEqual(['hot', 'hot'])
    expect(traces.some((trace) => trace.kind === TRACE_MESSAGE_KINDS.selection)).toBe(true)
    const terminateSelection = traces.find(
      (trace) => trace.kind === TRACE_MESSAGE_KINDS.selection && trace.selected.type === 'terminate',
    )
    expect(terminateSelection).toBeDefined()
  })
})
