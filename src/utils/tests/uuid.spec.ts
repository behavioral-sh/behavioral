import { describe, expect, test } from 'bun:test'
import { uuid } from '../uuid.ts'

const V7_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  test('mints RFC 9562 v7: 8-4-4-4-12 hex, version nibble 7, variant 10x', () => {
    const id = uuid()
    expect(id).toMatch(V7_SHAPE)
    expect(id.length).toBe(36)
  })

  test('encodes the mint time as the 48-bit ms timestamp', () => {
    const before = Date.now()
    const id = uuid()
    const after = Date.now()
    // 48-bit big-endian ms timestamp = bytes 0-5 = the first 12 hex chars.
    const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })

  test('supports an optional prefix — prefix + 36-char uuid', () => {
    const id = uuid('bp_')
    expect(id.startsWith('bp_')).toBe(true)
    expect(id.slice(3)).toMatch(V7_SHAPE)
    expect(id.length).toBe(39)
  })

  test('is non-decreasing over a tight burst — including ids minted within one ms', () => {
    const ids = Array.from({ length: 5000 }, uuid)
    for (let i = 1; i < ids.length; i++) {
      // Lexicographic comparison — the wire-level ordering trace joins rely on.
      expect(ids[i]! >= ids[i - 1]!).toBe(true)
    }
  })

  test('mints 100k unique ids', () => {
    const ids = new Set(Array.from({ length: 100_000 }, uuid))
    expect(ids.size).toBe(100_000)
  })
})
