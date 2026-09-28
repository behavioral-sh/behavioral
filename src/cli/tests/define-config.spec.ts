import { describe, expect, test } from 'bun:test'
import { defineConfig } from '../define-config.ts'

describe('defineConfig', () => {
  test('returns the config unchanged (a typed identity for config.ts authors)', () => {
    expect(defineConfig({ actuators: ['store'] })).toEqual({ actuators: ['store'] })
  })

  test('preserves an override reference', () => {
    const shell = (() => ({ name: 'shell' })) as unknown as Parameters<typeof defineConfig>[0]['shell']
    expect(defineConfig({ shell }).shell).toBe(shell)
  })
})
