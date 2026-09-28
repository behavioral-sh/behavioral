import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { INIT_FRAME_KIND } from '../create-worker.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { spawnFacultyWorker } from './faculty-harness.ts'

/**
 * The system-one worker entry's INIT-FRAME branches — the config's only
 * channel, pinned both ways:
 *
 * - init PRESENT → the Decisions round-trip (system-one.faculty.spec.ts);
 * - init ABSENT (empty data) → the typed error (`no model configured …`),
 *   not a crash and not a silent run;
 * - init NEVER ARRIVES → the pre-init typed error (fail-closed — the
 *   faculty refuses to run on an empty config rather than guessing).
 */

const spawnEndpointless = () =>
  spawnFacultyWorker({
    url: new URL('../system-one.faculty.ts', import.meta.url),
    requestType: FACULTY_MESSAGE_KINDS.system_one_request,
    resultType: FACULTY_MESSAGE_KINDS.system_one_request_result,
    initData: {},
  })

describe('system one worker entry — the init-frame branches', () => {
  test('empty init data answers the typed error, and the lane stays alive', async () => {
    const faculty = spawnEndpointless()
    try {
      faculty.call({
        id: 'absent',
        input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } },
      } as JsonObject)
      const { detail } = await faculty.resultFor('absent')
      expect(detail.ok).toBe(false)
      expect((detail.error as { message: string }).message).toBe('no model configured for the system one endpoint')
      // The lane stays alive — a later init that names a model flips the answer.
      // (No server here; the flip is proven by the round-trip specs.)
    } finally {
      faculty.terminate()
    }
  })

  test('a request before ANY init frame answers the pre-init typed error', async () => {
    // Boot directly (the harness always posts init) — the raw worker receives
    // a request with no construction message at all.
    const worker = new Worker(new URL('../system-one.faculty.ts', import.meta.url))
    const results: { detail: Record<string, unknown> }[] = []
    worker.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data as { detail: Record<string, unknown> })
    })
    try {
      worker.postMessage({
        type: FACULTY_MESSAGE_KINDS.system_one_request,
        detail: { id: 'pre1', input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } } },
      })
      const deadline = Date.now() + 5000
      let result: { detail: Record<string, unknown> } | undefined
      for (;;) {
        result = results.find((r) => r.detail.id === 'pre1')
        if (result !== undefined || Date.now() > deadline) break
        await Bun.sleep(10)
      }
      expect(result).toBeDefined()
      const detail = (result as { detail: Record<string, unknown> }).detail
      expect((detail.error as { message: string }).message).toBe('faculty not initialized: no init frame received')
    } finally {
      worker.terminate()
    }
  })

  test('an init frame is the only thing that initializes — a malformed one changes nothing', async () => {
    const worker = new Worker(new URL('../system-one.faculty.ts', import.meta.url))
    const results: { detail: Record<string, unknown> }[] = []
    worker.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data as { detail: Record<string, unknown> })
    })
    try {
      worker.postMessage({ kind: INIT_FRAME_KIND, data: 'not an object' })
      worker.postMessage({ kind: 'other', data: { url: 'https://attacker.invalid' } })
      worker.postMessage({
        type: FACULTY_MESSAGE_KINDS.system_one_request,
        detail: { id: 'iv1', input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } } },
      })
      const deadline = Date.now() + 5000
      let result: { detail: Record<string, unknown> } | undefined
      for (;;) {
        result = results.find((r) => r.detail.id === 'iv1')
        if (result !== undefined || Date.now() > deadline) break
        await Bun.sleep(10)
      }
      // Still uninitialized — the garbage frames never became config.
      expect(result).toBeDefined()
      const detail = (result as { detail: Record<string, unknown> }).detail
      expect((detail.error as { message: string }).message).toBe('faculty not initialized: no init frame received')
    } finally {
      worker.terminate()
    }
  })
})
