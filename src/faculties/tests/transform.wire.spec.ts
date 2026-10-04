import { describe, expect, test } from 'bun:test'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import {
  validateTransformEvaluation,
  validateTransformRequestEvent,
  validateTransformRequestResultEvent,
} from '../faculties.types.ts'

describe('transform wire — the fixed fourth faculty', () => {
  describe('TransformEvaluation — the evaluation schema (moved home)', () => {
    test('accepts the outcomes the engine bridge and the faculty exchange', () => {
      expect(validateTransformEvaluation({ ok: true, value: { id: 'o-1' } })).toBe(true)
      expect(validateTransformEvaluation({ ok: false, reason: 'jq_error', stderr: 'syntax error', exitCode: 3 })).toBe(
        true,
      )
      expect(validateTransformEvaluation({ ok: false, reason: 'jq_timeout' })).toBe(true)
      expect(validateTransformEvaluation({ ok: false, reason: 'no_detail' })).toBe(true)
    })

    test('rejects off-shape frames — the two-guards pattern', () => {
      expect(validateTransformEvaluation({ ok: 'yes' })).toBe(false)
      expect(validateTransformEvaluation({ ok: true })).toBe(false)
      expect(validateTransformEvaluation({ ok: false })).toBe(false)
      expect(validateTransformEvaluation({ ok: false, reason: 'bogus' })).toBe(false)
      expect(validateTransformEvaluation({ ok: true, value: { id: 1 }, extra: true })).toBe(false)
      expect(validateTransformEvaluation({ ok: false, reason: 'jq_error', value: {} })).toBe(false)
      expect(validateTransformEvaluation('ok')).toBe(false)
    })
  })

  describe('transform_request', () => {
    test('accepts a well-formed request — id, query, target, and the jq input detail', () => {
      const valid = validateTransformRequestEvent({
        type: FACULTY_MESSAGE_KINDS.transform_request,
        detail: { id: 'tr_1', query: '.order', target: 'ship', detail: { order: { id: 'o-1' } } },
      })
      expect(valid).toBe(true)
    })

    test('the jq input detail is optional — a detail-less match still requests (the faculty answers no_detail)', () => {
      const valid = validateTransformRequestEvent({
        type: FACULTY_MESSAGE_KINDS.transform_request,
        detail: { id: 'tr_1', query: '.', target: 'ship' },
      })
      expect(valid).toBe(true)
    })

    test('rejects a request without the query or the target — the idiom is thread data, always present', () => {
      expect(
        validateTransformRequestEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request,
          detail: { id: 'tr_1', target: 'ship' },
        }),
      ).toBe(false)
      expect(
        validateTransformRequestEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request,
          detail: { id: 'tr_1', query: '.a' },
        }),
      ).toBe(false)
    })

    test('rejects extra detail keys — the request carries exactly the idiom', () => {
      expect(
        validateTransformRequestEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request,
          detail: { id: 'tr_1', query: '.', target: 'out', extra: true },
        }),
      ).toBe(false)
    })
  })

  describe('transform_request_result — the four outcomes map to result branches', () => {
    test('ok: the whole first output rides as value', () => {
      const valid = validateTransformRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.transform_request_result,
        detail: { id: 'tr_1', ok: true, value: { id: 'o-1' } },
      })
      expect(valid).toBe(true)
    })

    test('jq_error: stderr and exitCode ride the failure branch', () => {
      const valid = validateTransformRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.transform_request_result,
        detail: { id: 'tr_1', ok: false, reason: 'jq_error', stderr: 'syntax error', exitCode: 3 },
      })
      expect(valid).toBe(true)
    })

    test('no_detail, empty_output, non_object_output, jq_timeout — each a conforming failure', () => {
      for (const reason of ['no_detail', 'empty_output', 'non_object_output', 'jq_timeout'] as const) {
        expect(
          validateTransformRequestResultEvent({
            type: FACULTY_MESSAGE_KINDS.transform_request_result,
            detail: { id: 'tr_1', ok: false, reason },
          }),
        ).toBe(true)
      }
    })

    test('the retired SAB-bridge reasons are gone from the wire — jq_unavailable, output_too_large', () => {
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: false, reason: 'jq_unavailable' },
        }),
      ).toBe(false)
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: false, reason: 'output_too_large' },
        }),
      ).toBe(false)
    })

    test('division schema-total: each outcome admits against the result envelope, and off-shape detail never does', () => {
      const outcomes = [
        { id: 'tr_1', ok: true, value: { id: 'o-1' } },
        { id: 'tr_1', ok: false, reason: 'jq_error', stderr: 'x', exitCode: 3 },
        { id: 'tr_1', ok: false, reason: 'no_detail' },
        { id: 'tr_1', ok: false, reason: 'empty_output' },
        { id: 'tr_1', ok: false, reason: 'non_object_output' },
        { id: 'tr_1', ok: false, reason: 'jq_timeout' },
      ] as const
      for (const detail of outcomes) {
        expect(
          validateTransformRequestResultEvent({ type: FACULTY_MESSAGE_KINDS.transform_request_result, detail }),
        ).toBe(true)
      }
      // The envelope rejects: the cross-branch shapes, unknown reasons, extra keys.
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: true, reason: 'no_detail' },
        }),
      ).toBe(false)
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: false, reason: 'bogus' },
        }),
      ).toBe(false)
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: false },
        }),
      ).toBe(false)
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: false, reason: 'jq_error', value: {} },
        }),
      ).toBe(false)
      expect(
        validateTransformRequestResultEvent({
          type: FACULTY_MESSAGE_KINDS.transform_request_result,
          detail: { id: 'tr_1', ok: true, value: { id: 'o-1' }, extra: true },
        }),
      ).toBe(false)
    })

    test('the ctx echo lane rides beside the outcome — never a model-facing field', () => {
      const valid = validateTransformRequestResultEvent({
        type: FACULTY_MESSAGE_KINDS.transform_request_result,
        detail: { id: 'tr_1', ok: true, value: { a: 1 }, ctx: { pipeline: 'p1' } },
      })
      expect(valid).toBe(true)
    })
  })
})
