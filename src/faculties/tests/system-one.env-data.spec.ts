import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { envData } from '../env-data.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { SYSTEM_ONE_ENDPOINT_KEY } from '../system-one.types.ts'
import { spawnFacultyWorker } from './faculty-harness.ts'

/**
 * The env-data contract of the system-one worker entry — the endpoint rides
 * environment data, never a request message. Two branches, pinned:
 *
 * - endpoint PRESENT → the Decisions round-trip (faculty.spec.ts);
 * - endpoint ABSENT → the typed error (`no model configured …`), not a
 *   crash and not a silent lane.
 *
 * This file owns the ABSENT branch: worker-threads environment data is
 * process-global, so the absent case explicitly resets the key (Bun has no
 * deleteEnvironmentData — `setEnvironmentData(key, undefined)` is the
 * reset), keeping the test order-independent.
 */

const spawnEndpointless = () =>
  spawnFacultyWorker({
    url: new URL('../system-one.faculty.ts', import.meta.url),
    requestType: FACULTY_MESSAGE_KINDS.system_one_request,
    resultType: FACULTY_MESSAGE_KINDS.system_one_request_result,
    env: { [SYSTEM_ONE_ENDPOINT_KEY]: undefined },
  })

describe('system one worker entry — the endpoint env-data branches', () => {
  test('an absent endpoint answers the typed error, and the lane stays alive', async () => {
    const faculty = spawnEndpointless()
    try {
      faculty.call({
        id: 'absent',
        input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } },
      } as JsonObject)
      const { detail } = await faculty.resultFor('absent')
      expect(detail.ok).toBe(false)
      expect((detail.error as { message: string }).message).toBe('no model configured for the system one endpoint')
    } finally {
      faculty.terminate()
    }
  })

  test('envData parses JSON-stringified process env (the bridge’s second leg)', () => {
    const previous = process.env[SYSTEM_ONE_ENDPOINT_KEY]
    try {
      process.env[SYSTEM_ONE_ENDPOINT_KEY] = JSON.stringify({
        url: 'https://api.example.test/v1/systemone',
        model: 'm',
      })
      expect(envData(SYSTEM_ONE_ENDPOINT_KEY)).toEqual({
        url: 'https://api.example.test/v1/systemone',
        model: 'm',
      })
      // A non-JSON string comes back verbatim.
      process.env[SYSTEM_ONE_ENDPOINT_KEY] = 'not-json'
      expect(envData(SYSTEM_ONE_ENDPOINT_KEY)).toBe('not-json')
    } finally {
      if (previous === undefined) delete process.env[SYSTEM_ONE_ENDPOINT_KEY]
      else process.env[SYSTEM_ONE_ENDPOINT_KEY] = previous
    }
  })
})
