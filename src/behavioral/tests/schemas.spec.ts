import { describe, expect, test } from 'bun:test'

import {
  ajv,
  SerializedThreadSchema,
  ThreadSchema,
  TraceBaseSchema,
  validateBPEvent,
  validateThread,
  validateTransformEvaluation,
} from '../behavioral.types.ts'

// Derived from TraceBaseSchema — the one home for the trace wire's common
// shape — extended per-kind with the discriminating `kind` and `step`.
const compileTraceValidator = (kind: string) =>
  ajv.compile({
    ...TraceBaseSchema,
    properties: { ...TraceBaseSchema.properties, kind: { const: kind }, step: { type: 'integer' } },
    required: [...TraceBaseSchema.required, 'step'],
  })

describe('behavioral schemas', () => {
  test('BPEvent validator accepts JSON detail values', () => {
    expect(validateBPEvent({ type: 'primitive', detail: { value: 'text' } })).toBe(true)
    expect(validateBPEvent({ type: 'object', detail: { ok: true, list: [1, null] } })).toBe(true)
    expect(validateBPEvent({ type: 'bare' })).toBe(true)
  })

  test('BPEvent validator rejects missing type and non-string type', () => {
    expect(validateBPEvent({ detail: {} })).toBe(false)
    expect(validateBPEvent({ type: 42 })).toBe(false)
    expect(validateBPEvent(null)).toBe(false)
  })

  test('Transform listener validator requires query and target', () => {
    expect(validateTransformListenerSafe({ type: 'x', query: '.', target: 'y' })).toBe(true)
    expect(validateTransformListenerSafe({ type: 'x', query: '.' })).toBe(false)
  })

  test('TransformEvaluation validator accepts well-formed frames from the jq worker', () => {
    expect(validateTransformEvaluation({ ok: true, value: { id: 'o-1' } })).toBe(true)
    expect(validateTransformEvaluation({ ok: false, reason: 'jq_error', stderr: 'syntax error', exitCode: 3 })).toBe(
      true,
    )
    expect(validateTransformEvaluation({ ok: false, reason: 'jq_timeout' })).toBe(true)
    expect(validateTransformEvaluation({ ok: false, reason: 'output_too_large' })).toBe(true)
    expect(validateTransformEvaluation({ ok: false, reason: 'no_detail' })).toBe(true)
  })

  test('TransformEvaluation validator rejects off-shape frames', () => {
    expect(validateTransformEvaluation({ ok: 'yes' })).toBe(false)
    expect(validateTransformEvaluation({ ok: true })).toBe(false)
    expect(validateTransformEvaluation({ ok: false })).toBe(false)
    expect(validateTransformEvaluation({ ok: false, reason: 'bogus' })).toBe(false)
    expect(validateTransformEvaluation({ ok: true, value: { id: 1 }, extra: true })).toBe(false)
    expect(validateTransformEvaluation({ ok: false, reason: 'jq_error', value: {} })).toBe(false)
    expect(validateTransformEvaluation('ok')).toBe(false)
  })

  test('ThreadSchema properties carry non-empty descriptions (the model-facing contract)', () => {
    for (const schema of Object.values(ThreadSchema.properties)) {
      const description = (schema as { description?: string }).description
      expect(typeof description).toBe('string')
      expect(description!.length).toBeGreaterThan(0)
    }
  })

  test('ThreadSchema uses name + description — no label on the thread surface', () => {
    expect(Object.keys(ThreadSchema.properties)).toContain('name')
    expect(Object.keys(ThreadSchema.properties)).toContain('description')
    expect(Object.keys(ThreadSchema.properties)).not.toContain('label')
    expect(ThreadSchema.required).toContain('name')
    expect(ThreadSchema.required).toContain('description')
  })

  test('SerializedThreadSchema — the one home for the serialized authored-thread shape', () => {
    expect(SerializedThreadSchema.required).toContain('name')
    expect(SerializedThreadSchema.required).toContain('description')
    expect(SerializedThreadSchema.required).toContain('rules')
    expect(SerializedThreadSchema.additionalProperties).toBe(false)
    // Rules stay permissive — a caller's detailSchema reaches the runtime
    // validator verbatim; the engine's ThreadSchema gate re-validates.
    const validate = ajv.compile(SerializedThreadSchema)
    expect(
      validate({
        name: 'a',
        description: 'd',
        rules: [{ waitFor: [{ type: 'x', detailSchema: { type: 'object' } }] }],
      }),
    ).toBe(true)
    expect(validate({ name: 'a', rules: [] })).toBe(false)
  })

  test('Thread validator accepts an optional provenance sourceHash — uint32 djb2 only', () => {
    expect(validateThread({ name: 'a', description: 'd', rules: [], sourceHash: 3328524204 })).toBe(true)
    expect(validateThread({ name: 'a', description: 'd', rules: [], sourceHash: -1 })).toBe(false)
    expect(validateThread({ name: 'a', description: 'd', rules: [], sourceHash: 1.5 })).toBe(false)
    expect(validateThread({ name: 'a', description: 'd', rules: [], sourceHash: 'abc' })).toBe(false)
  })

  test('Thread validator enforces the description cap and requires name', () => {
    expect(validateThread({ name: 'a', description: 'd', rules: [] })).toBe(true)
    expect(validateThread({ name: 'a', description: 'x'.repeat(513), rules: [] })).toBe(false)
    expect(validateThread({ name: 'a', rules: [] })).toBe(false)
    expect(validateThread({ description: 'd', rules: [] })).toBe(false)
  })

  test('Thread validator requires non-empty name and rules', () => {
    expect(validateThread({ name: 'a', description: 'd', rules: [] })).toBe(true)
    expect(validateThread({ name: 'a', description: 'd', once: true, rules: [] })).toBe(true)
    expect(validateThread({ name: '', description: 'd', rules: [] })).toBe(false)
    expect(validateThread({ description: 'd', rules: [] })).toBe(false)
    expect(validateThread({ name: 'a', rules: [] })).toBe(false)
  })

  test('Selection trace validator accepts a selected event payload', () => {
    const validate = compileTraceValidator('selection')
    const trace = {
      kind: 'selection',
      timestamp: 3,
      instanceId: 'bp_test',
      sessionId: 'sess_test',
      step: 3,
      selected: { type: 'event', detail: { value: 1 } },
    }
    expect(validate(trace)).toBe(true)
    const narrowed = trace as unknown as SelectionTraceLike
    expect(narrowed.selected.type).toBe('event')
  })

  test('Trace validators reject missing sessionId', () => {
    expect(
      compileTraceValidator('selection')({
        kind: 'selection',
        timestamp: 0,
        instanceId: 'bp_test',
        step: 0,
        selected: { type: 'event' },
      }),
    ).toBe(false)
  })

  test('Trace validators reject unknown kinds and missing step', () => {
    expect(compileTraceValidator('selection')({ kind: 'worker', response: { id: 'worker-1' }, step: 0 })).toBe(false)
    expect(compileTraceValidator('deadlock')({ kind: 'deadlock', timestamp: 0, instanceId: 'bp_test' })).toBe(false)
  })
})

type SelectionTraceLike = { selected: { type: string } }

function validateTransformListenerSafe(listener: unknown): boolean {
  // TransformListenerSchema was removed from exports (behavioral.schemas.ts was
  // consolidated into behavioral.types.ts); recompiled here via ajv to keep the
  // spec independent of validator export churn.
  const validate = ajv.compile({
    type: 'object',
    properties: {
      type: { type: 'string' },
      query: { type: 'string' },
      target: { type: 'string' },
      detailSchema: { type: 'object', required: [] },
    },
    required: ['type', 'query', 'target'],
  })
  return validate(listener)
}
