import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { spawnFaculty } from '../../tests/faculty-harness.ts'
import { validateSystemOneInput } from '../schemas.ts'
import { SYSTEM_ONE_ENDPOINT_KEY } from '../types.ts'
import { DECISIONS_MODEL, startDecisionsServer } from './fixtures/decisions-server.ts'

// ================================================================
// system one worker — the event-wire surface
// ================================================================

const spawnSystemOne = (endpoint: { url: string; apiKey?: string; model?: string }) =>
  spawnFaculty({
    file: 'system-one/faculty.ts',
    requestType: FACULTY_MESSAGE_KINDS.system_one_request,
    resultType: FACULTY_MESSAGE_KINDS.system_one_request_result,
    env: { [SYSTEM_ONE_ENDPOINT_KEY]: JSON.stringify(endpoint) },
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

describe('system one faculty — the Decisions round-trip', () => {
  test('round-trips a noul/choice/score question set as one result event', async () => {
    const server = await startDecisionsServer()
    const faculty = spawnSystemOne({ url: server.url, model: 'jev-latest' })
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
    const faculty = spawnSystemOne({ url: server.url, model: 'jev-latest' })
    try {
      faculty.call({ id: 'd1', input: { state: 'x', questions } } as JsonObject)
      await faculty.resultFor('d1')
      faculty.call({ id: 'd2', input: { state: 'x', model: '~typesafe/jev-latest', questions } } as JsonObject)
      await faculty.resultFor('d2')
      expect(server.requests[0]?.body.model).toBe('jev-latest')
      expect(server.requests[1]?.body.model).toBe('~typesafe/jev-latest')
    } finally {
      faculty.terminate()
      await server.close()
    }
  })

  test('forwards the endpoint api key as a bearer token', async () => {
    const server = await startDecisionsServer({ apiKey: 'sk-test' })
    const faculty = spawnSystemOne({ url: server.url, apiKey: 'sk-test', model: 'jev-latest' })
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
    const faculty = spawnSystemOne({ url: server.url, model: 'jev-latest' })
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
    const faculty = spawnSystemOne({ url: server.url, model: 'jev-latest' })
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
