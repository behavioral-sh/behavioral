import { describe, expect, test } from 'bun:test'
import { INFERENCE_PROXY_PREFIX, systemTwoEndpointsFromPlan } from '../composition-port.ts'

/**
 * The composition-side construction of system-two's initData provider map
 * (the inference-transport slice): the attach frame carries the provider
 * PLAN (labels + transports + webgpu models — data, no secrets, no URLs —
 * the daemon cannot know the page's origin), and the browser CONSTRUCTS the
 * endpoints: proxy routes for static-key vendors, verbatim entries for
 * webgpu. No apiKey field is ever produced.
 */
describe('systemTwoEndpointsFromPlan', () => {
  test('static-key vendors become the daemon proxy routes — no apiKey, no vendor origin', () => {
    const endpoints = systemTwoEndpointsFromPlan({ typesafe: {}, openrouter: {} })
    expect(endpoints).toEqual({
      typesafe: { url: `${INFERENCE_PROXY_PREFIX}typesafe` },
      openrouter: { url: `${INFERENCE_PROXY_PREFIX}openrouter` },
    })
    const encoded = JSON.stringify(endpoints)
    expect(encoded).not.toContain('apiKey')
  })

  test('webgpu entries pass through verbatim — transport + model, no url, no credential', () => {
    const endpoints = systemTwoEndpointsFromPlan({ local: { transport: 'webgpu', model: 'stub-1' } })
    expect(endpoints).toEqual({ local: { transport: 'webgpu', model: 'stub-1' } })
  })

  test('mixed plans: proxy vendors and local webgpu in one map', () => {
    const endpoints = systemTwoEndpointsFromPlan({
      openai: {},
      local: { transport: 'webgpu', model: 'm-1' },
    })
    expect(endpoints.openai).toEqual({ url: `${INFERENCE_PROXY_PREFIX}openai` })
    expect(endpoints.local).toEqual({ transport: 'webgpu', model: 'm-1' })
  })
})
