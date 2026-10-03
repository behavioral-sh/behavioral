import { describe, expect, test } from 'bun:test'
import { behavioral } from '../behavioral.ts'
import type { PendingBidsTrace, Trace } from '../behavioral.types.ts'

const jsonSchema = {
  type: 'object' as const,
  properties: { id: { type: 'string' as const } },
  required: ['id'],
  additionalProperties: false,
}

describe('pending_bids trace', () => {
  test('publishes pending_bids trace with thread states during superstep', () => {
    const seen: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()
    useTrace((msg) => {
      seen.push(msg)
    })

    addThread({ name: 'worker', description: 'Test thread.', rules: [{ request: { type: 'task' } }], once: true })
    trigger({ type: 'start' })

    const pending = seen.find((s) => s.kind === 'pending_bids')
    expect(pending).toBeDefined()
    expect(pending!.kind).toBe('pending_bids')
  })

  test('pending_bids appears before frontier in the same step', () => {
    const seen: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()
    useTrace((msg) => {
      seen.push(msg)
    })

    addThread({ name: 'req', description: 'Test thread.', rules: [{ request: { type: 'ping' } }], once: true })

    trigger({ type: 'start' })

    const pendingIdx = seen.findIndex((s) => s.kind === 'pending_bids')
    const frontierIdx = seen.findIndex((s) => s.kind === 'frontier')

    expect(pendingIdx).not.toBe(-1)
    expect(frontierIdx).not.toBe(-1)
    expect(pendingIdx).toBeLessThan(frontierIdx)
  })

  test('detailSchema in pending_bids trace echoes the input JSON Schema without conversion', () => {
    const seen: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()
    useTrace((msg) => {
      seen.push(msg)
    })

    addThread({
      name: 'blocker',
      description: 'Test thread.',
      rules: [
        {
          block: [
            {
              type: 'task',
              detailSchema: jsonSchema,
            },
          ],
        },
      ],
    })
    addThread({
      name: 'worker',
      description: 'Test thread.',
      rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
      once: true,
    })

    trigger({ type: 'start' })

    const pending = seen.find((s) => s.kind === 'pending_bids') as PendingBidsTrace | undefined
    expect(pending).toBeDefined()
    expect(pending!.threads.length).toBeGreaterThanOrEqual(2)

    const blocker = pending!.threads.find((t) => t.name === 'blocker')
    expect(blocker).toBeDefined()
    const block = blocker!.block
    expect(block).toBeDefined()
    const listener = block![0]!
    // Raw JSON Schema `detailSchema` passes through without conversion
    expect(listener.detailSchema).toEqual(jsonSchema)
    expect(listener.detailSchema).toHaveProperty('additionalProperties', false)
  })
})
