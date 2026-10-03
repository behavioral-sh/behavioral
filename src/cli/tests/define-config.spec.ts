import { describe, expect, test } from 'bun:test'
import { defineConfig } from '../define-config.ts'

describe('defineConfig', () => {
  test('returns the config unchanged (a typed identity for config.ts authors)', () => {
    expect(defineConfig({})).toEqual({})
  })

  test('preserves a thread-pack reference (packs are data)', () => {
    const pack = [{ label: 'p', rules: [{ request: { type: 'x' } }] }] as Parameters<typeof defineConfig>[0]['threads']
    expect(defineConfig({ threads: pack }).threads).toBe(pack)
  })
})
