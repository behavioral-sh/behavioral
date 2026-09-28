import { createWorker } from '../../create-worker.ts'
import {
  type FixtureDetail,
  validateFixtureCancelEvent,
  validateFixtureDetailInput,
  validateFixtureRequestEvent,
} from './create-worker-fixture.wire.ts'

/**
 * The no-timeout twin of the create-worker fixture — the same wire validators
 * (imported, no drift), `timeoutMs: 0` (no timer), and a respond that hangs
 * forever. The specs pin the no-timeout contract through it: a request stays
 * in flight past the default window and never fabricates a timeout result.
 */

export const wiring = createWorker<FixtureDetail>({
  resultKind: 'fixture_request_result',
  validateRequest: validateFixtureRequestEvent,
  validateCancel: validateFixtureCancelEvent,
  validateInput: validateFixtureDetailInput,
  timeoutMs: 0,
  respond: () => new Promise<never>(() => {}),
})
