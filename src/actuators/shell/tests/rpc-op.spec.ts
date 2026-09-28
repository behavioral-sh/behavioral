import { afterEach, describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../../faculties/faculties.constants.ts'
import { spawnFaculty } from '../../tests/faculty-harness.ts'

/**
 * RPC op specs — exercised through the REAL faculty process boundary
 * speaking the behavioral event wire against a real local JSON-RPC HTTP
 * server: `shell_request` (`op: 'rpc'`) in, one `shell_request_result` out.
 *
 * @packageDocumentation
 */

type WireResult = {
  id: string
  ok: boolean
  ctx?: unknown
  result?: { output?: JsonObject; durationMs?: number }
  error?: {
    code?: string
    message?: string
    remoteCode?: number | string
    retryable?: boolean
    request?: { input?: { url?: string } }
  }
  space?: string
}

/** One JSON-RPC endpoint on a random localhost port; records requests. */
const rpcServer = (handler?: (body: Record<string, unknown>) => Response | Promise<Response>) => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      requests.push({ url: request.url, body, headers })
      if (handler !== undefined) return handler(body)
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { echo: body } })
    },
  })
  return {
    url: `http://localhost:${server.port}/mcp`,
    requests,
    close: () => server.stop(true),
  }
}

/** The faculty harness bound to the shell wire. */
const spawnShellWorker = () =>
  spawnFaculty({
    file: 'shell/faculty.ts',
    requestType: FACULTY_MESSAGE_KINDS.shell_request,
    resultType: FACULTY_MESSAGE_KINDS.shell_request_result,
  })

const servers: Array<ReturnType<typeof rpcServer>> = []
const workers: Array<ReturnType<typeof spawnShellWorker>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const worker of workers.splice(0)) worker.terminate()
})

const wire = (raw: Awaited<ReturnType<ReturnType<typeof spawnShellWorker>['resultFor']>>): WireResult =>
  raw.detail as WireResult

describe('shell rpc op', () => {
  test('dispatches a generic remote JSON-RPC call and returns the output', async () => {
    const server = rpcServer()
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc1', input: { op: 'rpc', url: server.url, method: 'tools/list', params: { page: 2 } } })
    const raw = await worker.resultFor('rpc1')
    const result = wire(raw)
    expect(result.ok).toBe(true)
    const output = result.result?.output as { echo?: { method?: string } }
    expect(output.echo?.method).toBe('tools/list')
    // The generic envelope — no MCP framing.
    const body = server.requests[0]?.body as Record<string, unknown>
    expect(body.method).toBe('tools/list')
    expect(body.jsonrpc).toBe('2.0')
  })

  test('a remote JSON-RPC error payload is error data, not a throw', async () => {
    const server = rpcServer((body) =>
      Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }),
    )
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc2', input: { op: 'rpc', url: server.url, method: 'nope/x' } })
    const raw = await worker.resultFor('rpc2')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toBe('nope')
    expect(result.error?.remoteCode).toBe(-32601)
    // A JSON-RPC error payload completed the call — not a transport failure.
    expect(result.error?.retryable).toBe(false)
  })

  test('an HTTP non-OK response is error data', async () => {
    const server = rpcServer(() => new Response('down', { status: 503 }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc3', input: { op: 'rpc', url: server.url, method: 'ping' } })
    const raw = await worker.resultFor('rpc3')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.remoteCode).toBe(503)
  })

  test('the error detail carries retryable — computed where the numeric comparison lives', async () => {
    // The op owns the retry-vs-surface discriminant so the thread siblings
    // can divide on a schema field (a const), not a jq numeric check. A
    // remote 5xx is retryable; a 4xx is not — both branches through the real
    // process boundary.
    const down = rpcServer(() => new Response('down', { status: 503 }))
    const bad = rpcServer(() => new Response('bad', { status: 400 }))
    servers.push(down, bad)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'r503', input: { op: 'rpc', url: down.url, method: 'x' } })
    worker.call({ id: 'r400', input: { op: 'rpc', url: bad.url, method: 'x' } })
    const first = wire(await worker.resultFor('r503'))
    const second = wire(await worker.resultFor('r400'))
    expect(first.ok).toBe(false)
    expect(first.error?.remoteCode).toBe(503)
    expect(first.error?.retryable).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.error?.remoteCode).toBe(400)
    expect(second.error?.retryable).toBe(false)
  })

  test('shell_cancel aborts the in-flight fetch — the result is canceled data', async () => {
    let seen = 0
    const server = rpcServer(async () => {
      seen += 1
      await Bun.sleep(5_000)
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    })
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc4', input: { op: 'rpc', url: server.url, method: 'slow/x' } })
    // The in-flight assertion races the worker's cold spawn on slow runners —
    // poll to the server's arrival instead of a fixed sleep (the CI lesson).
    const arrival = Date.now() + 5_000
    while (seen < 1) {
      if (Date.now() > arrival) break
      await Bun.sleep(25)
    }
    expect(seen).toBe(1)
    worker.post({ type: FACULTY_MESSAGE_KINDS.shell_cancel, detail: { id: 'rpc4' } })
    const raw = await worker.resultFor('rpc4')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('canceled')
    // A deliberate stop is never retried by policy.
    expect(result.error?.retryable).toBe(false)
  })

  test('the deadline terminates a hung call — the result is timeout data', async () => {
    const server = rpcServer(async () => {
      await Bun.sleep(5_000)
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    })
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc5', input: { op: 'rpc', url: server.url, method: 'slow/x', timeoutMs: 200 } })
    const raw = await worker.resultFor('rpc5')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('timeout')
    // A deadline stop is a transport-class failure — retry policy applies.
    expect(result.error?.retryable).toBe(true)
  })

  test('input that fails the rpc boundary is error data with the id intact', async () => {
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc6', input: { op: 'rpc', method: 'ping' } })
    const raw = await worker.resultFor('rpc6')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toContain('invalid input')
  })

  test('an auth-declared rpc op without a token short-circuits as credential_required data', async () => {
    let hits = 0
    const server = rpcServer(() => {
      hits += 1
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    })
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc8', input: { op: 'rpc', url: server.url, method: 'tools/list', auth: true } })
    const raw = await worker.resultFor('rpc8')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('credential_required')
    // The echo is the replay capture payload — the thread re-issues the call
    // with the vended token; nothing reached the remote.
    const error = result.error as { request?: { op?: string; input?: { url?: string; auth?: boolean } } }
    expect(error.request?.op).toBe('rpc')
    expect(error.request?.input?.url).toBe(server.url)
    expect(error.request?.input?.auth).toBe(true)
    expect(hits).toBe(0)
  })

  test('a token injected by the replay rides the fetch as a bearer header', async () => {
    const server = rpcServer((body) => Response.json({ jsonrpc: '2.0', id: body.id, result: { ok: 1 } }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({
      id: 'rpc9',
      input: { op: 'rpc', url: server.url, method: 'tools/list', auth: true, authToken: 'vended-tok' },
    })
    const raw = await worker.resultFor('rpc9')
    const result = wire(raw)
    expect(result.ok).toBe(true)
    expect(server.requests[0]?.headers.authorization).toBe('Bearer vended-tok')
  })

  test('a remote 401 on an unauthenticated call is reactive credential_required data', async () => {
    const server = rpcServer(() => new Response('unauthorized', { status: 401 }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc10', input: { op: 'rpc', url: server.url, method: 'tools/list' } })
    const raw = await worker.resultFor('rpc10')
    const result = wire(raw)
    // The 401 challenge maps to the typed vend-and-replay capture payload —
    // the seam vends and replays; a token'd 401 stays a remote error.
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('credential_required')
    const error = result.error as { request?: { input?: { url?: string } } }
    expect(error.request?.input?.url).toBe(server.url)
  })

  test("a remote 401 on a token'd call stays a remote error — the loop is bounded", async () => {
    const server = rpcServer(() => new Response('unauthorized', { status: 401 }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({
      id: 'rpc11',
      input: { op: 'rpc', url: server.url, method: 'tools/list', authToken: 'stale-tok' },
    })
    const raw = await worker.resultFor('rpc11')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.remoteCode).toBe(401)
  })

  test('request ctx echoes on the result — the thread join lane', async () => {
    const server = rpcServer((body) => Response.json({ jsonrpc: '2.0', id: body.id, result: {} }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({
      id: 'rpc12',
      input: { op: 'rpc', url: server.url, method: 'x' },
      ctx: { echo: { leg: 'call' } },
    })
    const raw = await worker.resultFor('rpc12')
    const result = wire(raw)
    expect(result.ok).toBe(true)
    expect(result.ctx).toEqual({ echo: { leg: 'call' } })
  })

  test('op-supplied headers ride the fetch', async () => {
    const server = rpcServer((body) => Response.json({ jsonrpc: '2.0', id: body.id, result: {} }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({
      id: 'rpc13',
      input: { op: 'rpc', url: server.url, method: 'x', headers: { 'MCP-Protocol-Version': '2026-07-28' } },
    })
    const raw = await worker.resultFor('rpc13')
    const result = wire(raw)
    expect(result.ok).toBe(true)
    expect(server.requests[0]?.headers['mcp-protocol-version']).toBe('2026-07-28')
  })
})
