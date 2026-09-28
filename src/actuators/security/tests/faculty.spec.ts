import { afterEach, describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../../faculties/faculties.constants.ts'
import { spawnFaculty } from '../../tests/faculty-harness.ts'

/**
 * Security faculty specs — exercised through the REAL faculty process
 * boundary speaking the behavioral event wire: `credential_request` in, one
 * `credential_result` out, `credential_cancel` for an in-flight vend.
 *
 * The credential vend is fail-closed by construction: broker env-data is
 * absent unless the spec seeds it (a REAL loopback broker over `Bun.serve`,
 * so the HTTP leg is genuine), and the keychain floor is empty in tests —
 * a missing credential is error data, never a throw.
 *
 * @packageDocumentation
 */

type WireResult = {
  id: string
  ok: boolean
  result?: { token?: string }
  error?: { code?: string; message?: string }
  space?: string
}

/** A loopback token broker — the env-data leg of the vend, over real HTTP. */
const brokerServer = (handler?: (request: Request) => Response | Promise<Response>) => {
  const requests: Array<{ url: string; auth?: string }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({ url: request.url, auth: request.headers.get('authorization') ?? undefined })
      if (handler !== undefined) return handler(request)
      return Response.json({ token: 'broker-tok' })
    },
  })
  return {
    url: `http://localhost:${server.port}/`,
    requests,
    close: () => server.stop(true),
  }
}

/** The faculty harness bound to the security wire. */
const spawnSecurityWorker = (env?: Record<string, string>) =>
  spawnFaculty({
    file: 'security/faculty.ts',
    requestType: FACULTY_MESSAGE_KINDS.credential_request,
    resultType: FACULTY_MESSAGE_KINDS.credential_result,
    env,
  })

const SERVER_URL = 'https://mcp.example.com/mcp'

const brokers: Array<ReturnType<typeof brokerServer>> = []
const workers: Array<ReturnType<typeof spawnSecurityWorker>> = []
afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close()
  for (const worker of workers.splice(0)) worker.terminate()
})

describe('security faculty — credential vending over the wire', () => {
  test('a credential_request vends the broker token when broker env-data is bound', async () => {
    const broker = brokerServer()
    brokers.push(broker)
    const worker = spawnSecurityWorker({ MCP_BROKER_URL: broker.url, MCP_BROKER_BOOT_SECRET: 'boot-secret' })
    workers.push(worker)
    worker.call({ id: 'cred1', input: { serverUrl: SERVER_URL } } as JsonObject)
    const raw = await worker.resultFor('cred1')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(true)
    expect(result.result?.token).toBe('broker-tok')
    // The broker leg carries the boot secret as a bearer.
    expect(broker.requests[0]?.auth).toBe('Bearer boot-secret')
  })

  test('no broker env-data and an empty keychain → the vend fails as error data', async () => {
    const worker = spawnSecurityWorker()
    workers.push(worker)
    worker.call({ id: 'cred2', input: { serverUrl: SERVER_URL } } as JsonObject)
    const raw = await worker.resultFor('cred2')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toContain(SERVER_URL)
  })

  test('a down broker falls through to the keychain floor — still error data when empty', async () => {
    const broker = brokerServer(() => new Response('down', { status: 503 }))
    brokers.push(broker)
    const worker = spawnSecurityWorker({ MCP_BROKER_URL: broker.url, MCP_BROKER_BOOT_SECRET: 'boot-secret' })
    workers.push(worker)
    worker.call({ id: 'cred3', input: { serverUrl: SERVER_URL } } as JsonObject)
    const raw = await worker.resultFor('cred3')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
  })

  test('input that fails the boundary is error data naming the failure', async () => {
    const worker = spawnSecurityWorker()
    workers.push(worker)
    worker.call({ id: 'cred4', input: { serverUrl: '' } } as JsonObject)
    const raw = await worker.resultFor('cred4')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toContain('invalid input')
  })

  test('credential_cancel stops an in-flight vend — the result is canceled data', async () => {
    const broker = brokerServer(async () => {
      await Bun.sleep(1_000)
      return Response.json({ token: 'late-tok' })
    })
    brokers.push(broker)
    const worker = spawnSecurityWorker({ MCP_BROKER_URL: broker.url, MCP_BROKER_BOOT_SECRET: 'boot-secret' })
    workers.push(worker)
    worker.call({ id: 'cred5', input: { serverUrl: SERVER_URL } } as JsonObject)
    worker.post({ type: FACULTY_MESSAGE_KINDS.credential_cancel, detail: { id: 'cred5' } } as never)
    const raw = await worker.resultFor('cred5')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('canceled')
  })

  test('a ctx-carrying request is valid on the wire and vends (the binding rides out-of-band)', async () => {
    const broker = brokerServer()
    brokers.push(broker)
    const worker = spawnSecurityWorker({ MCP_BROKER_URL: broker.url, MCP_BROKER_BOOT_SECRET: 'boot-secret' })
    workers.push(worker)
    // ctx rides beside input (the host-supplied override lane) — never a
    // model-facing input field.
    worker.call({
      id: 'cred7',
      input: { serverUrl: SERVER_URL },
      ctx: { issuer: 'https://as.example.com' },
    } as JsonObject)
    const raw = await worker.resultFor('cred7')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(true)
    expect(result.result?.token).toBe('broker-tok')
  })

  test('a ctx that fails its boundary is error data naming the failure', async () => {
    const worker = spawnSecurityWorker()
    workers.push(worker)
    worker.call({ id: 'cred8', input: { serverUrl: SERVER_URL }, ctx: { issuer: 42 } } as JsonObject)
    const raw = await worker.resultFor('cred8')
    const result = raw.detail as unknown as WireResult
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toContain('invalid input')
  })

  test('the request space is echoed on the result', async () => {
    const worker = spawnSecurityWorker()
    workers.push(worker)
    worker.call({ id: 'cred6', input: { serverUrl: SERVER_URL } } as JsonObject, 'space-9')
    const raw = await worker.resultFor('cred6')
    expect(raw.space).toBe('space-9')
  })
})
