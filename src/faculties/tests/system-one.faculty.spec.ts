import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { validateSystemOneInput, validateSystemOneOutput } from '../system-one.schemas.ts'
import { spawnFacultyWorker } from './faculty-harness.ts'
import { DECISIONS_MODEL, startDecisionsServer } from './fixtures/decisions-server.ts'

// ================================================================
// system one worker — the event-wire surface
// ================================================================

// The worker construction stays a bundler-visible literal at the call site —
// the same factory shape the composition's useWorker wiring takes.
const spawnSystemOne = (endpoint: { url: string; apiKey?: string; model?: string }) =>
  spawnFacultyWorker({
    url: new URL('../system-one.faculty.ts', import.meta.url),
    requestType: FACULTY_MESSAGE_KINDS.system_one_request,
    resultType: FACULTY_MESSAGE_KINDS.system_one_request_result,
    initData: endpoint,
  })

const questions = {
  is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
  department: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'Payments', technical: 'Bugs' },
  },
  frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Angry'] },
}

describe('system one input schema — the question union', () => {
  test('accepts a noul/choice/score question set with structured instructions', () => {
    expect(
      validateSystemOneInput({
        state: { document: 'I was charged twice.' },
        questions: {
          urgent: { type: 'noul', instructions: 'Urgent?', criteria: { true: 'timely', false: 'not' } },
          team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, tech: 'Bugs' } },
          mood: { type: 'score', instructions: { q: 'How angry?', ctx: 'payouts' }, criteria: ['Calm', { level: 1 }] },
        },
      }),
    ).toBe(true)
  })

  test('rejects an unknown question type', () => {
    expect(validateSystemOneInput({ state: 'x', questions: { q: { type: 'nope', instructions: 'x' } } })).toBe(false)
  })

  test('rejects an empty question set', () => {
    expect(validateSystemOneInput({ state: 'x', questions: {} })).toBe(false)
  })
})

describe('system one output schema — the response envelope', () => {
  test('accepts the live endpoint envelope — usage may carry a cost field', () => {
    // The OpenRouter Decisions alpha added `usage.cost` after the faculty
    // schema was written (jev-iteration-0 Slice 1 capture, 2026-10-03):
    // additionalProperties: false rejected every real response as error data.
    expect(
      validateSystemOneOutput({
        model: 'typesafe/jev-1.13-20260917',
        answers: {
          team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.86, tech: 0.1 }, confidence: 0.79 },
          urgent: { type: 'noul', noul: 0.71 },
          mood: {
            type: 'score',
            score: 1.05,
            legend: { '0': 'Calm', '1': 'Angry' },
            probabilities: { '0': 0, '1': 0.95 },
            confidence: 0.92,
          },
        },
        usage: { input_tokens: 415, output_tokens: 72, cost: 0.00001743 },
      }),
    ).toBe(true)
  })
})

describe('system one faculty — the Decisions round-trip', () => {
  test('round-trips a noul/choice/score question set as one result event', async () => {
    const server = await startDecisionsServer()
    const faculty = spawnSystemOne({ url: server.url, model: 'typesafe/jev-1.13' })
    try {
      faculty.call({ id: 'd1', input: { state: 'Help! My payouts failed.', questions } } as JsonObject)
      const { detail } = await faculty.resultFor('d1')
      expect(detail.ok).toBe(true)
      const result = detail.result as {
        model: string
        answers: Record<string, { type: string; noul?: number; choice?: string; score?: number }>
      }
      expect(result.model).toBe(DECISIONS_MODEL)
      expect(result.answers.is_urgent?.noul).toBe(0.9)
      expect(result.answers.department?.choice).toBe('billing')
      expect(result.answers.frustration?.type).toBe('score')
    } finally {
      faculty.terminate()
      await server.close()
    }
  })

  test('the endpoint model is the default; a request model overrides it', async () => {
    const server = await startDecisionsServer()
    const faculty = spawnSystemOne({ url: server.url, model: 'typesafe/jev-1.13' })
    try {
      faculty.call({ id: 'd1', input: { state: 'x', questions } } as JsonObject)
      await faculty.resultFor('d1')
      faculty.call({ id: 'd2', input: { state: 'x', model: '~typesafe/jev-latest', questions } } as JsonObject)
      await faculty.resultFor('d2')
      expect(server.requests[0]?.body.model).toBe('typesafe/jev-1.13')
      expect(server.requests[1]?.body.model).toBe('~typesafe/jev-latest')
    } finally {
      faculty.terminate()
      await server.close()
    }
  })

  test('forwards the endpoint api key as a bearer token', async () => {
    const server = await startDecisionsServer({ apiKey: 'sk-test' })
    const faculty = spawnSystemOne({ url: server.url, apiKey: 'sk-test', model: 'typesafe/jev-1.13' })
    try {
      faculty.call({ id: 'd1', input: { state: 'x', questions } } as JsonObject)
      const { detail } = await faculty.resultFor('d1')
      expect(detail.ok).toBe(true)
      expect(server.requests[0]?.auth).toBe('Bearer sk-test')
    } finally {
      faculty.terminate()
      await server.close()
    }
  })

  test('retries a 429 (honoring retry-after) and then succeeds', async () => {
    const server = await startDecisionsServer({ rateLimitFirst: 1 })
    const faculty = spawnSystemOne({ url: server.url, model: 'typesafe/jev-1.13' })
    try {
      faculty.call({ id: 'd1', input: { state: 'x', questions } } as JsonObject)
      const { detail } = await faculty.resultFor('d1')
      expect(detail.ok).toBe(true)
      expect(server.requests.length).toBe(2)
    } finally {
      faculty.terminate()
      await server.close()
    }
  })

  test('an input failing the boundary is error data, not a crash', async () => {
    const server = await startDecisionsServer()
    const faculty = spawnSystemOne({ url: server.url, model: 'typesafe/jev-1.13' })
    try {
      faculty.call({ id: 'bad', input: { state: 'x' } } as JsonObject)
      const { detail } = await faculty.resultFor('bad')
      expect(detail.ok).toBe(false)
      expect(String((detail.error as { message?: string } | undefined)?.message)).toContain('invalid input')
    } finally {
      faculty.terminate()
      await server.close()
    }
  })
})

describe('system one faculty — the transport toggle (rest ↔ webgpu)', () => {
  test('a webgpu endpoint dispatches to the local runtime as a normal result — no network', async () => {
    const faculty = spawnSystemOne({ transport: 'webgpu', model: 'stub-1' } as never)
    try {
      faculty.call({ id: 'w1', input: { state: 'x', questions } } as JsonObject)
      const { detail } = await faculty.resultFor('w1')
      expect(detail.ok).toBe(true)
      const result = detail.result as { model?: string; answers?: Record<string, unknown> }
      expect(result.model).toBe('stub-1')
      expect(Object.keys(result.answers ?? {}).length).toBeGreaterThan(0)
    } finally {
      faculty.terminate()
    }
  })

  test('a webgpu endpoint without a model answers the typed error', async () => {
    const faculty = spawnSystemOne({ transport: 'webgpu' } as never)
    try {
      faculty.call({ id: 'w2', input: { state: 'x', questions } } as JsonObject)
      const { detail } = await faculty.resultFor('w2')
      expect(detail.ok).toBe(false)
      expect(String((detail.error as { message?: string } | undefined)?.message)).toBe(
        'no local model configured for the webgpu endpoint',
      )
    } finally {
      faculty.terminate()
    }
  })
})
