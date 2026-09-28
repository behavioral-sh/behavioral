/**
 * The System One (TypeSafe Decisions) wire schemas — the request/response
 * contract for `POST <url>` with `{ state, model, questions }` returning
 * `{ model, answers, usage }`.
 *
 * @remarks
 * The one home for the question and answer unions: `noul` (yes/no →
 * probability), `choice` (pick + distribution + confidence), and `score`
 * (rubric + legend + distribution + confidence). `instructions` and `criteria`
 * values are free-form (`string | object | array`) per the API, so they stay
 * unstructured; the question/answer envelopes are strict.
 *
 * The same schema is the transport for the TypeSafe API and the OpenRouter
 * Decisions API — only the endpoint URL and model slug change.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject } from '../../behavioral/behavioral.types.ts'

/** A free-form instruction/criteria value: a string, a structured object, or an array. */
export type InstructionValue = string | JsonObject | unknown[]

export type NoulQuestion = {
  type: 'noul'
  instructions: InstructionValue
  criteria?: { true?: InstructionValue; false?: InstructionValue }
}

export type ChoiceQuestion = {
  type: 'choice'
  instructions: InstructionValue
  criteria: Record<string, InstructionValue | null>
}

export type ScoreQuestion = {
  type: 'score'
  instructions: InstructionValue
  criteria: InstructionValue[]
}

/** The typed question union (discriminated on `type`). */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export type NoulAnswer = { type: 'noul'; noul: number }
export type ChoiceAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}
export type ScoreAnswer = {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

/** The typed answer union (discriminated on `type`). */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** The System One request input — the model defaults from the endpoint; a thread may override it. */
export type SystemOneInput = {
  state: string | JsonObject | unknown[]
  questions: Record<string, Question>
  model?: string
}

/** The System One success output; errors are data (`{ isError: true, message }`). */
export type SystemOneOutput = {
  model: string
  answers: Record<string, Answer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const instructionValueSchema = {
  oneOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
} as const

const noulQuestionSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'noul' },
    instructions: instructionValueSchema,
    criteria: {
      type: 'object',
      properties: { true: instructionValueSchema, false: instructionValueSchema },
      additionalProperties: false,
    },
  },
  required: ['type', 'instructions'],
  additionalProperties: false,
} as const

/** The choice question's schema — the admit/reject judgment derives its question shape from this one home. */
export const choiceQuestionSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'choice' },
    instructions: instructionValueSchema,
    criteria: {
      type: 'object',
      additionalProperties: {
        oneOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }, { type: 'null' }],
      },
    },
  },
  required: ['type', 'instructions', 'criteria'],
  additionalProperties: false,
} as const

const scoreQuestionSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'score' },
    instructions: instructionValueSchema,
    criteria: { type: 'array', items: instructionValueSchema },
  },
  required: ['type', 'instructions', 'criteria'],
  additionalProperties: false,
} as const

export const SystemOneInputSchema = {
  type: 'object',
  properties: {
    state: { oneOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }] },
    model: { type: 'string' },
    questions: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { oneOf: [noulQuestionSchema, choiceQuestionSchema, scoreQuestionSchema] },
    },
  },
  required: ['state', 'questions'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SystemOneInput>

const probabilityMapSchema = { type: 'object', additionalProperties: { type: 'number' } } as const

const noulAnswerSchema = {
  type: 'object',
  properties: { type: { type: 'string', const: 'noul' }, noul: { type: 'number' } },
  required: ['type', 'noul'],
  additionalProperties: false,
} as const

const choiceAnswerSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'choice' },
    choice: { type: 'string' },
    probabilities: probabilityMapSchema,
    confidence: { type: 'number' },
  },
  required: ['type', 'choice', 'probabilities', 'confidence'],
  additionalProperties: false,
} as const

const scoreAnswerSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'score' },
    score: { type: 'number' },
    legend: { type: 'object', additionalProperties: { type: 'string' } },
    probabilities: probabilityMapSchema,
    confidence: { type: 'number' },
  },
  required: ['type', 'score', 'legend', 'probabilities', 'confidence'],
  additionalProperties: false,
} as const

export const SystemOneOutputSchema = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    answers: {
      type: 'object',
      additionalProperties: { oneOf: [noulAnswerSchema, choiceAnswerSchema, scoreAnswerSchema] },
    },
    usage: {
      type: 'object',
      properties: { input_tokens: { type: 'integer' }, output_tokens: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  required: ['model', 'answers'],
  additionalProperties: true,
} as unknown as JSONSchemaType<SystemOneOutput>

/** The input trust boundary — validated in the faculty process. */
export const validateSystemOneInput = ajv.compile(SystemOneInputSchema)
/** The output conformance boundary. */
export const validateSystemOneOutput = ajv.compile(SystemOneOutputSchema)
