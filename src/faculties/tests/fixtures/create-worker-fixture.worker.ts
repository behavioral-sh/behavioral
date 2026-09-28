import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { createWorker } from '../../create-worker.ts'
import {
  type FixtureDetail,
  hangUntilAborted,
  validateFixtureCancelEvent,
  validateFixtureDetailInput,
  validateFixtureRequestEvent,
} from './create-worker-fixture.wire.ts'

/**
 * The create-worker fixture faculty — a canned `respond` behind the generic
 * bootstrap, proving the plumbing at a real worker boundary. Ops:
 *
 * - `echo` — reflects the input plus the respond context's `data` (seenData)
 * - `fail` — returns the isError branch of the result envelope
 * - `hang` — never settles until the request's signal aborts (cancel/timeout)
 * - `crash` — schedules an uncaught throw, then hangs forever (the in-flight
 *   request never answers; the worker dies with an error event)
 * - anything else — the respond itself throws (error envelope, not a crash)
 *
 * The wire vocabulary lives in create-worker-fixture.wire.ts (no self-wiring)
 * — the no-timeout shape lives in the sibling fixture
 * (create-worker-no-timeout-fixture.worker.ts). The fixture's config rides
 * the init frame (`{ fixture: true }`), which the echo op reflects back as
 * `seenData` — the specs pin the init-frame contract through it.
 */

export const wiring = createWorker<FixtureDetail, { fixture: boolean }>({
  resultKind: 'fixture_request_result',
  validateRequest: validateFixtureRequestEvent,
  validateCancel: validateFixtureCancelEvent,
  validateInput: validateFixtureDetailInput,
  timeoutMs: 200,
  respond: async (detail, { data, signal }): Promise<JsonObject | { isError: true; message: string }> => {
    const input = detail.input
    if (input.op === 'echo') {
      const seenData = (data as { fixture?: boolean }).fixture ?? null
      return input.message === undefined ? { op: 'echo', seenData } : { op: 'echo', message: input.message, seenData }
    }
    if (input.op === 'fail') return { isError: true, message: input.message ?? 'fixture failed' }
    if (input.op === 'crash') {
      setTimeout(() => {
        throw new Error('fixture crash')
      }, 0)
      await hangUntilAborted(signal)
      return {}
    }
    if (input.op === 'throw') throw new Error('fixture respond threw')
    await hangUntilAborted(signal)
    return {}
  },
})
