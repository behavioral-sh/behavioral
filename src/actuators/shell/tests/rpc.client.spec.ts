import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { send } from '../rpc.client.ts'

/**
 * RPC client specs — the fetch mock is the only double: the boundary under
 * test IS the injected fetch, so a scripted `fetch` exercises the real
 * request-building and response-decoding paths.
 *
 * @packageDocumentation
 */

/** A scripted fetch: captures calls, returns queued responses. */
const fetchMock = (responses: Array<Response | Error>) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('no scripted response')
    return next
  }) as unknown as typeof fetch
  return { impl, calls }
}

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

const rpcResponse = (id: string | number, result: unknown): Response => jsonResponse({ jsonrpc: '2.0', id, result })

describe('rpc.client', () => {
  test('POSTs a JSON-RPC 2.0 envelope with the method and params', async () => {
    const params = { name: 'ping' } as JsonObject
    const { impl, calls } = fetchMock([rpcResponse('r1', { pong: true })])
    const outcome = await send({ url: 'https://rpc.example/mcp', method: 'tools/list', params, id: 'r1', fetch: impl })
    expect(outcome.ok).toBe(true)
    const call = calls[0]!
    expect(call.url).toBe('https://rpc.example/mcp')
    expect(call.init.method).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(String(call.init.body)) as { jsonrpc: string; id: string; method: string; params: unknown }
    expect(body).toEqual({ jsonrpc: '2.0', id: 'r1', method: 'tools/list', params })
  })

  test('carries an Authorization bearer header when a token is provided', async () => {
    const { impl, calls } = fetchMock([rpcResponse(1, {})])
    await send({
      url: 'https://rpc.example/mcp',
      method: 'ping',
      id: 1,
      fetch: impl,
      getAuthToken: async () => 'tok-123',
    })
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer tok-123')
  })

  test('sends no Authorization header when no token is available', async () => {
    const { impl, calls } = fetchMock([rpcResponse(1, {})])
    await send({
      url: 'https://rpc.example/mcp',
      method: 'ping',
      id: 1,
      fetch: impl,
      getAuthToken: async () => undefined,
    })
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('authorization')).toBeNull()
  })

  test('is protocol-agnostic: a plain echo method carries no MCP framing', async () => {
    const { impl, calls } = fetchMock([rpcResponse(2, { echoed: true })])
    const outcome = await send({
      url: 'https://rpc.example/api',
      method: 'math/add',
      params: { a: 1, b: 2 } as JsonObject,
      id: 2,
      fetch: impl,
    })
    expect(outcome.ok).toBe(true)
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['id', 'jsonrpc', 'method', 'params'])
  })

  test('omits params from the envelope when none are given', async () => {
    const { impl, calls } = fetchMock([rpcResponse(3, null)])
    await send({ url: 'https://rpc.example/api', method: 'ping', id: 3, fetch: impl })
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect('params' in body).toBe(false)
  })

  test('HTTP non-OK is error data, not a throw', async () => {
    const { impl } = fetchMock([new Response('nope', { status: 503 })])
    const outcome = await send({ url: 'https://rpc.example/mcp', method: 'tools/list', id: 'r2', fetch: impl })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.code).toBe(503)
      expect(outcome.error.message).toContain('503')
    }
  })

  test('a JSON-RPC error payload is error data carrying its code', async () => {
    const { impl } = fetchMock([
      jsonResponse({ jsonrpc: '2.0', id: 'r3', error: { code: -32601, message: 'Method not found' } }),
    ])
    const outcome = await send({ url: 'https://rpc.example/mcp', method: 'nope/x', id: 'r3', fetch: impl })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.code).toBe(-32601)
      expect(outcome.error.message).toBe('Method not found')
    }
  })

  test('a network failure is error data, not a throw', async () => {
    const { impl } = fetchMock([new Error('connection refused')])
    const outcome = await send({ url: 'https://rpc.example/mcp', method: 'ping', id: 'r4', fetch: impl })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('network')
      expect(outcome.error.message).toContain('connection refused')
    }
  })

  test('an aborted signal is error data — cancellation rides the transport', async () => {
    const { impl } = fetchMock([new Error('The operation was aborted')])
    const controller = new AbortController()
    const outcome = await send({
      url: 'https://rpc.example/mcp',
      method: 'ping',
      id: 'r5',
      fetch: impl,
      signal: controller.signal,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.code).toBe('network')
  })
})
