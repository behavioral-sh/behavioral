import { describe, expect, test } from 'bun:test'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { spawnFacultyWorker } from './faculty-harness.ts'

/**
 * The transform faculty's round-trip — a REAL Bun web Worker on the TS entry,
 * speaking the unchanged wire over postMessage, exactly as the composition
 * wires it. The four evaluation outcomes, the echo lanes, and the runaway
 * kill: a pathological query dies as `jq_timeout` (the re-homed 1s budget,
 * the eval terminated inside the faculty) and the faculty KEEPS SERVING —
 * the old pool-recovery semantics on the async wire.
 *
 * The selfUrl rides the INIT FRAME: classic worker bundles cannot touch
 * `import.meta` (a syntax error), so the faculty's own URL — which the
 * per-request nested eval worker re-executes — is composition-supplied data
 * (the bundler-visible literal lives at the call site).
 */
const spawn = () =>
  spawnFacultyWorker({
    url: new URL('../transform.faculty.ts', import.meta.url),
    requestType: FACULTY_MESSAGE_KINDS.transform_request,
    resultType: FACULTY_MESSAGE_KINDS.transform_request_result,
    initData: { selfUrl: new URL('../transform.faculty.ts', import.meta.url).href },
  })

const request = (id: string, query: string, target: string, detail?: JsonObject) => ({
  id,
  query,
  target,
  ...(detail === undefined ? {} : { detail }),
})

import type { JsonObject } from '../../behavioral/behavioral.types.ts'

describe('the transform faculty — the evaluation round-trip', () => {
  test('ok: the whole first output rides as value, umwelt echoed', async () => {
    const faculty = spawn()
    try {
      faculty.call(request('t1', '.order', 'ship', { order: { id: 'o-1', total: 42 } }), 's1')
      const result = await faculty.resultFor('t1')
      expect(result.detail).toEqual({ id: 't1', ok: true, value: { id: 'o-1', total: 42 } })
      expect(result.umwelt).toBe('s1')
    } finally {
      faculty.terminate()
    }
  })

  test('no_detail: a request without the jq input answers the typed failure', async () => {
    const faculty = spawn()
    try {
      faculty.call(request('t2', '.order', 'ship'))
      const result = await faculty.resultFor('t2')
      expect(result.detail).toEqual({ id: 't2', ok: false, reason: 'no_detail' })
    } finally {
      faculty.terminate()
    }
  })

  test('empty_output and non_object_output: the shape failures stay typed', async () => {
    const faculty = spawn()
    try {
      faculty.call(request('t3', '.missing? // empty', 'ship', { a: 1 }))
      const empty = await faculty.resultFor('t3')
      expect(empty.detail).toEqual({ id: 't3', ok: false, reason: 'empty_output' })

      faculty.call(request('t4', '.total', 'ship', { total: 7 }))
      const scalar = await faculty.resultFor('t4')
      expect(scalar.detail).toEqual({ id: 't4', ok: false, reason: 'non_object_output' })
    } finally {
      faculty.terminate()
    }
  })

  test('jq_error: an invalid query carries stderr and exitCode', async () => {
    const faculty = spawn()
    try {
      faculty.call(request('t5', '.order.', 'ship', { order: { id: 'o-4' } }))
      const result = await faculty.resultFor('t5')
      expect(result.detail.ok).toBe(false)
      expect((result.detail as { reason: string }).reason).toBe('jq_error')
      expect(typeof (result.detail as { stderr?: string }).stderr).toBe('string')
      expect(typeof (result.detail as { exitCode?: number }).exitCode).toBe('number')
    } finally {
      faculty.terminate()
    }
  })

  test('ctx echoes verbatim — the out-of-band join lane', async () => {
    const faculty = spawn()
    try {
      faculty.post({
        type: FACULTY_MESSAGE_KINDS.transform_request,
        detail: { ...request('t6', '.order', 'ship', { order: { id: 'o-6' } }), ctx: { pipeline: 'p1' } },
      })
      const result = await faculty.resultFor('t6')
      expect((result.detail as { ctx?: unknown }).ctx).toEqual({ pipeline: 'p1' })
      expect(result.detail.ok).toBe(true)
    } finally {
      faculty.terminate()
    }
  })

  test('a pathological query dies as jq_timeout — and the faculty keeps serving', async () => {
    const faculty = spawn()
    try {
      faculty.call(request('t7', 'while(true; .)', 'never', { spin: true }))
      const killed = await faculty.resultFor('t7', 15_000)
      expect(killed.detail).toEqual({ id: 't7', ok: false, reason: 'jq_timeout' })
      // Pool recovery on the async wire: the next transform still evaluates.
      faculty.call(request('t8', '.order', 'ship', { order: { id: 'o-9', total: 5 } }))
      const after = await faculty.resultFor('t8')
      expect(after.detail).toEqual({ id: 't8', ok: true, value: { id: 'o-9', total: 5 } })
    } finally {
      faculty.terminate()
    }
  })
})
