import { describe, expect, test } from 'bun:test'
import { behavioral } from '../behavioral.ts'
import { onSelection } from './helpers.ts'

const stringIdSchema = {
  type: 'object' as const,
  properties: { id: { type: 'string' as const } },
  required: ['id'],
  additionalProperties: false,
}

test('match listener: waitFor resumes thread when type and detail schema match', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: waitFor does not resume when detail schema fails', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 101 } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task'])
})

test('match listener: detailMatch false resumes thread when detail schema fails', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 101 } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
            detailMatch: false,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: detailMatch false does not resume thread when detail schema passes', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
            detailMatch: false,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task'])
})

test('match listener: type mismatch prevents match when source and detail would pass', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'other', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'other') log.push('other')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['other'])
})

test('match listener: sourceSchema request accepts only requested events', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: trigger and requested events both satisfy matching listeners', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })
  trigger({ type: 'task', detail: { id: 'job-1' } })

  expect(log).toEqual(['task', 'ack', 'task'])
})

test('match listener: sourceSchema can accept trigger and request', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: sourceSchema request matches request-origin events only', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })
  trigger({
    type: 'task',
    detail: { id: 'job-1' },
  })

  expect(log).toEqual(['task', 'ack', 'task'])
})

test('match listener: block prevents matching requested event from being selected', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'blocker',
    description: 'Test thread.',
    rules: [
      {
        block: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
    ],
    once: true,
  })
  addThread({
    name: 'taskProducer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({ name: 'safeProducer', description: 'Test thread.', rules: [{ request: { type: 'safe' } }], once: true })
  addThread({
    name: 'safeFollower',
    description: 'Test thread.',
    rules: [{ waitFor: [{ type: 'safe' }] }, { request: { type: 'safe_ack' } }],
    once: true,
  })
  addThread({
    name: 'taskFollower',
    description: 'Test thread.',
    rules: [{ waitFor: [{ type: 'task' }] }, { request: { type: 'task_ack' } }],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'safe') log.push('safe')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'safe_ack') log.push('safe_ack')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'task_ack') log.push('task_ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['safe', 'safe_ack'])
})

test('match listener: interrupt terminates thread when matching event is selected', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'interruptedThread',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [{ type: 'start' }],
        interrupt: [
          {
            type: 'kill',
            detailSchema: {
              type: 'object' as const,
              properties: { id: { const: 'victim' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        ],
      },
      { request: { type: 'after_start' } },
    ],
    once: true,
  })
  addThread({
    name: 'interruptProducer',
    description: 'Test thread.',
    rules: [{ request: { type: 'kill', detail: { id: 'victim' } } }],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'kill') log.push('kill')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'after_start') log.push('after_start')
  })

  trigger({ type: 'kickoff' })
  trigger({ type: 'start' })

  expect(log).toEqual(['kill'])
})

test('match listener: detail-schema listeners can express conditional matching', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { ok: true } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: {
              type: 'object' as const,
              properties: { ok: { const: true } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: non-selected same-type requesters remain pending until their own request is selected', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'first',
    description: 'Test thread.',
    rules: [{ request: { type: 'same', detail: { n: 1 } } }, { request: { type: 'first_done' } }],
    once: true,
  })
  addThread({
    name: 'second',
    description: 'Test thread.',
    rules: [{ request: { type: 'same', detail: { n: 2 } } }, { request: { type: 'second_done' } }],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'same') {
      const detail = selected.detail as { n: number }
      log.push(`same:${detail.n}`)
    }
  })
  onSelection(program, (selected) => {
    if (selected.type === 'first_done') log.push('first_done')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'second_done') log.push('second_done')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['same:1', 'first_done', 'same:2', 'second_done'])
})

test('match listener: detail schema with valid detail passes', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 'job-1' } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: {
              type: 'object' as const,
              properties: { id: { type: 'string' as const } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: detail schema with invalid detail fails', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { id: 101 } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: stringIdSchema,
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task'])
})

test('match listener: 2020-12 prefixItems keyword compiles and matches', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { items: [42, 'hello'] } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  prefixItems: [{ type: 'number' }, { type: 'string' }],
                  minItems: 2,
                  maxItems: 2,
                },
              },
              required: ['items'],
              additionalProperties: false,
            },
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  expect(log).toEqual(['task', 'ack'])
})

test('match listener: 2020-12 prefixItems enforces tuple ordering', () => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  // Producer emits tuple [42, 'hello']; consumer expects [number, string]
  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { items: ['x', 1] } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  prefixItems: [{ type: 'number' }, { type: 'string' }],
                  minItems: 2,
                  maxItems: 2,
                },
              },
              required: ['items'],
              additionalProperties: false,
            },
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  // Tuple out of order: ['x', 1] should not match [number, string]
  // So consumer should NOT resume and 'ack' should not fire
  // The producer's task event IS selected, but the consumer doesn't match
  expect(log).toEqual(['task'])
})

test('match listener: closed prefixItems tuple rejects extra elements', () => {
  // minItems/maxItems: 2 closes the tuple — a 3-element array must fail
  // validation even when the first two elements are correctly typed.
  // Distinguishes a closed tuple from an open one (where extras would pass).
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'producer',
    description: 'Test thread.',
    rules: [{ request: { type: 'task', detail: { items: [42, 'hello', 'extra'] } } }],
    once: true,
  })
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      {
        waitFor: [
          {
            type: 'task',
            detailSchema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  prefixItems: [{ type: 'number' }, { type: 'string' }],
                  minItems: 2,
                  maxItems: 2,
                },
              },
              required: ['items'],
              additionalProperties: false,
            },
          },
        ],
      },
      { request: { type: 'ack' } },
    ],
    once: true,
  })

  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  trigger({ type: 'kickoff' })

  // 3-element array exceeds maxItems: 2 — consumer must not resume
  expect(log).toEqual(['task'])
})

test('match listener: malformed detailSchema publishes add_thread_error', () => {
  const seen: import('../behavioral.types.ts').Trace[] = []
  const { addThread, useTrace } = behavioral()
  useTrace((msg) => {
    seen.push(msg)
  })

  // properties: 'not-an-object' is structurally valid JSON but un-compilable as JSON Schema
  addThread({
    name: 'bad',
    description: 'Test thread.',
    rules: [
      {
        block: [
          {
            type: 'x',
            detailSchema: { type: 'object', properties: 'not-an-object' },
          },
        ],
      },
    ],
  })

  const errors = seen.filter((s) => s.kind === 'add_thread_error')
  expect(errors).toHaveLength(1)
})

test('match listener: malformed detailSchema in one listener rejects the whole thread', () => {
  const seen: import('../behavioral.types.ts').Trace[] = []
  const { addThread, trigger, useTrace } = behavioral()

  useTrace((msg) => {
    seen.push(msg)
  })

  const log: string[] = []

  // A thread with one good rule and one rule with a bad detailSchema
  addThread({
    name: 'mixed',
    description: 'Test thread.',
    rules: [
      { request: { type: 'good' } },
      {
        block: [
          {
            type: 'x',
            detailSchema: { type: 'object', properties: 'not-an-object' },
          },
        ],
      },
    ],
  })

  const errors = seen.filter((s) => s.kind === 'add_thread_error')
  expect(errors).toHaveLength(1)

  // The thread should not have registered — no running thread means triggering does nothing
  trigger({ type: 'kickoff' })
  expect(log).toEqual([])
})

// ---------------------------------------------------------------------------
// Slice 1 — ingress channel matching
// ---------------------------------------------------------------------------

const runWaitForIngress = ({
  listenerIngress,
  origin,
}: {
  listenerIngress?: boolean
  origin: 'request' | 'trigger'
}): string[] => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  if (origin === 'request') {
    addThread({ name: 'producer', description: 'Test thread.', rules: [{ request: { type: 'task' } }], once: true })
  }
  addThread({
    name: 'consumer',
    description: 'Test thread.',
    rules: [
      { waitFor: [{ type: 'task', ...(listenerIngress === undefined ? {} : { ingressMatch: listenerIngress }) }] },
      { request: { type: 'ack' } },
    ],
    once: true,
  })
  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'ack') log.push('ack')
  })

  if (origin === 'trigger') trigger({ type: 'task' })
  else trigger({ type: 'kickoff' })

  return log
}

describe('match listener: ingress channel flag (waitFor)', () => {
  test('absent ingress matches request-origin', () => {
    expect(runWaitForIngress({ origin: 'request' })).toEqual(['task', 'ack'])
  })

  test('absent ingress matches trigger-origin', () => {
    expect(runWaitForIngress({ origin: 'trigger' })).toEqual(['task', 'ack'])
  })

  test('ingressMatch: false matches request-origin', () => {
    expect(runWaitForIngress({ listenerIngress: false, origin: 'request' })).toEqual(['task', 'ack'])
  })

  test('ingressMatch: false does not match trigger-origin', () => {
    expect(runWaitForIngress({ listenerIngress: false, origin: 'trigger' })).toEqual(['task'])
  })

  test('ingressMatch: true matches trigger-origin', () => {
    expect(runWaitForIngress({ listenerIngress: true, origin: 'trigger' })).toEqual(['task', 'ack'])
  })

  test('ingressMatch: true does not match request-origin', () => {
    expect(runWaitForIngress({ listenerIngress: true, origin: 'request' })).toEqual(['task'])
  })
})

const runBlockIngress = ({
  listenerIngress,
  origin,
}: {
  listenerIngress: boolean
  origin: 'request' | 'trigger'
}): string[] => {
  const log: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({
    name: 'blocker',
    description: 'Test thread.',
    rules: [{ block: [{ type: 'task', ingressMatch: listenerIngress }] }],
  })
  if (origin === 'request') {
    addThread({ name: 'producer', description: 'Test thread.', rules: [{ request: { type: 'task' } }], once: true })
  }
  onSelection(program, (selected) => {
    if (selected.type === 'task') log.push('task')
  })

  if (origin === 'trigger') trigger({ type: 'task' })
  else trigger({ type: 'kickoff' })

  return log
}

describe('match listener: ingress channel flag (block)', () => {
  test('ingressMatch: true block gates a trigger-origin candidate', () => {
    expect(runBlockIngress({ listenerIngress: true, origin: 'trigger' })).toEqual([])
  })

  test('ingressMatch: false block does not gate a trigger-origin candidate', () => {
    expect(runBlockIngress({ listenerIngress: false, origin: 'trigger' })).toEqual(['task'])
  })

  test('ingressMatch: false block gates a request-origin candidate', () => {
    expect(runBlockIngress({ listenerIngress: false, origin: 'request' })).toEqual([])
  })

  test('ingressMatch: true block does not gate a request-origin candidate', () => {
    expect(runBlockIngress({ listenerIngress: true, origin: 'request' })).toEqual(['task'])
  })
})
