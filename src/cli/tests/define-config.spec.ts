import { describe, expect, test } from 'bun:test'
import { defineConfig } from '../define-config.ts'

describe('defineConfig', () => {
  test('returns the config unchanged (a typed identity for config.ts authors)', () => {
    expect(defineConfig({})).toEqual({})
  })

  test('preserves the actuators allow-list and the model identifiers (both are data)', () => {
    const config = defineConfig({
      actuators: ['shell', 'store'],
      systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', apiKey: 'k' },
      systemTwo: { openai: { url: 'https://api.openai.com/v1' } },
      ui: { provider: 'openai', modelId: 'gpt-x' },
    })
    expect(config.actuators).toEqual(['shell', 'store'])
    expect(config.systemOne).toEqual({
      url: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKey: 'k',
    })
    expect(config.systemTwo).toEqual({ openai: { url: 'https://api.openai.com/v1' } })
    expect(config.ui).toEqual({ provider: 'openai', modelId: 'gpt-x' })
  })
})
