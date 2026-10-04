import { describe, expect, test } from 'bun:test'
import { jitteredBackoffMs } from '../jittered-backoff.ts'

describe('jitteredBackoffMs', () => {
  // The websocket-transport #retry shape — capped exponential with FULL
  // jitter (`min(9999, 1000 * 2^n)`, uniform in [0, maxDelay)) — one shared
  // home, imported by the transport and the admission outage re-issue, never
  // copied.
  test('the jitter bound doubles per retry count: 1000, 2000, 4000', () => {
    for (const [n, bound] of [
      [0, 1_000],
      [1, 2_000],
      [2, 4_000],
    ] as const) {
      for (const random of [() => 0, () => 0.999999]) {
        const ms = jitteredBackoffMs(n, random)
        expect(ms).toBeGreaterThanOrEqual(0)
        expect(ms).toBeLessThan(bound)
      }
      expect(jitteredBackoffMs(n, () => 0)).toBe(0)
      expect(jitteredBackoffMs(n, () => 0.5)).toBe(Math.floor(bound / 2))
    }
  })

  test('the bound caps at 9999 — deep retry counts never exceed it', () => {
    expect(jitteredBackoffMs(10, () => 0.999999)).toBeLessThan(10_000)
    expect(jitteredBackoffMs(10, () => 0.999999)).toBeLessThanOrEqual(9_999)
    expect(jitteredBackoffMs(10, () => 0)).toBe(0)
  })

  test('a negative retry count clamps to the first bound', () => {
    expect(jitteredBackoffMs(-3, () => 0.5)).toBe(500)
  })
})
