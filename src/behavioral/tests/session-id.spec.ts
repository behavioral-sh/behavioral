import { describe, expect, test } from 'bun:test'

import { behavioral } from '../behavioral.ts'
import type { Trace } from '../behavioral.types.ts'

const runProgram = (options?: Parameters<typeof behavioral>[0]): { traces: Trace[]; instanceId: string } => {
  const traces: Trace[] = []
  const program = behavioral(options)
  program.useTrace((trace) => {
    traces.push(trace)
  })
  program.addThread({
    name: 'greeter',
    description: 'Test thread.',
    once: true,
    rules: [{ request: { type: 'hello' } }],
  })
  program.trigger({ type: 'wake' })
  const first = traces[0] as Trace | undefined
  return { traces, instanceId: first?.instanceId ?? '' }
}

describe('session id wiring', () => {
  test('a host-supplied sessionId is stamped on every trace alongside instanceId', () => {
    const { traces, instanceId } = runProgram({ sessionId: 'sess_host_1' })
    expect(traces.length).toBeGreaterThan(0)
    for (const trace of traces) {
      expect(trace.sessionId).toBe('sess_host_1')
      expect(trace.instanceId).toBe(instanceId)
      expect(trace.instanceId).not.toBe('sess_host_1')
    }
  })

  test('without a host session id, every trace defaults sessionId to the instanceId', () => {
    const { traces, instanceId } = runProgram()
    expect(instanceId).not.toBe('')
    expect(traces.length).toBeGreaterThan(0)
    for (const trace of traces) {
      expect(trace.sessionId).toBe(instanceId)
    }
  })

  test('two minted instanceIds are distinct but share the bp_ prefix', () => {
    const first = runProgram().instanceId
    const second = runProgram().instanceId
    expect(first.startsWith('bp_')).toBe(true)
    expect(second.startsWith('bp_')).toBe(true)
    expect(first).not.toBe(second)
  })
})
