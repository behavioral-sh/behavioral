import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryKeychain } from '../../actuators/keychain-oauth-provider.ts'
import { saveProviderToken } from '../../actuators/provider-keys.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { CONNECT_BEHAVIORAL_ROUTE } from '../../controller/bundle-controller.ts'
import type { ClientMessage } from '../../controller/controller.types.ts'
import { B_PROGRAM_WORKER_PATH } from '../../controller/worker-transport.ts'
import { SESSION_COOKIE_NAME, sessionTokenPath } from '../session.ts'
import { createSocketHost, instanceSocketPath } from '../socket-host.ts'
import { PROVIDER_TOKEN, startInferenceProvider } from './fixtures/inference-provider.ts'

/** The identity the engine stamps on every trace — the hello's payload. */
const identity = { instanceId: 'bp_instance_test', sessionId: 'sess_test' }

/** The host's runtime surface, faked: records triggers, traces, and lifecycle calls. */
const fakeRuntime = (withIdentity = identity) => {
  const triggers: BPEvent[] = []
  const listeners: Array<(trace: Trace) => void> = []
  const runtime = {
    identity: withIdentity,
    trigger: (event: BPEvent): void => {
      triggers.push(event)
    },
    useTrace: (listener: (trace: Trace) => void): (() => void) => {
      listeners.push(listener)
      return () => {}
    },
    start: (): void => {},
    terminate: (): void => {},
  }
  const emit = (trace: Trace): void => {
    for (const listener of listeners) listener(trace)
  }
  return { runtime, triggers, emit }
}

const selectionOf = (selected: { type: string; detail?: JsonObject; space?: string }): SelectionTrace => ({
  kind: TRACE_MESSAGE_KINDS.selection,
  timestamp: 0,
  instanceId: 'i',
  sessionId: 'i',
  step: 1,
  selected: { priority: 0, ...selected },
})

const traceOf = (kind: Trace['kind'], extra: Partial<Trace> = {}): Trace =>
  ({ kind, timestamp: 0, instanceId: 'i', sessionId: 'i', step: 1, ...extra }) as Trace

/**
 * A Transport-shaped client over the real instance socket: `send` frames a
 * ClientMessage (or a trigger) as one JSON-RPC frame; inbound JSON-RPC
 * notifications land raw in `frames` for assertions.
 */
type TestClient = {
  send: (message: ClientMessage | { type: 'trigger'; detail: { event: BPEvent } }) => void
  sendRaw: (line: string) => void
  frames: unknown[]
  waitFor: <T>(pred: (frame: unknown) => boolean, what: string) => Promise<T>
  close: () => void
}

const attachClient = (
  path: string,
  { headers, onOpen }: { headers?: Record<string, string>; onOpen?: (socket: WebSocket) => void } = {},
): Promise<TestClient> =>
  new Promise((resolveClient, reject) => {
    const socket = new WebSocket(`ws+unix://${path}`, { headers } as never)
    const frames: unknown[] = []
    let nextId = 1
    socket.addEventListener('open', () => {
      if (onOpen !== undefined) onOpen(socket)
      resolveClient({
        send: (message) => {
          const id = nextId++
          if (message.type === 'trigger' || message.type === 'ui_event') {
            socket.send(
              JSON.stringify({ jsonrpc: '2.0', id, method: message.type, params: { event: message.detail.event } }),
            )
            return
          }
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: message.type, params: message.detail }))
        },
        sendRaw: (line) => socket.send(line),
        frames,
        waitFor: <T>(pred: (frame: unknown) => boolean, what: string): Promise<T> =>
          new Promise<T>((resolveWait, rejectWait) => {
            const start = Date.now()
            const timer = setInterval(() => {
              const found = frames.find(pred)
              if (found !== undefined) {
                clearInterval(timer)
                resolveWait(found as T)
              } else if (Date.now() - start > 3000) {
                clearInterval(timer)
                rejectWait(new Error(`timed out waiting for ${what}`))
              }
            }, 5)
          }),
        close: () => socket.close(),
      })
    })
    socket.addEventListener('message', (ev) => {
      frames.push(JSON.parse(String(ev.data)))
    })
    socket.addEventListener('error', (ev) => reject(new Error(`client socket error: ${String(ev)}`)))
  })

const homes: string[] = []
const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'behavioral-socket-host-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

describe('createSocketHost', () => {
  test('a new client is helloed with the engine identity before anything else', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    const hello = await client.waitFor<{ method: string; params: unknown }>(
      (frame) => (frame as { method?: string }).method === 'hello',
      'hello notification',
    )
    expect(hello.params).toEqual(identity)
    // Connection-scoped notification, not an engine event: nothing entered
    // the engine, nothing triggered a super-step.
    expect(fake.triggers).toEqual([])
    client.close()
    await host.close()
  })

  test('the hello is per-connection and stays first on the wire', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const first = await attachClient(host.path)
    const second = await attachClient(host.path)
    fake.emit(traceOf(TRACE_MESSAGE_KINDS.idle))
    await first.waitFor((frame) => (frame as { method?: string }).method === 'trace', 'trace on client one')
    await second.waitFor((frame) => (frame as { method?: string }).method === 'trace', 'trace on client two')
    // Each client saw exactly one hello, and it preceded every trace frame.
    for (const client of [first, second]) {
      const hellos = client.frames.filter((frame) => (frame as { method?: string }).method === 'hello')
      expect(hellos).toHaveLength(1)
      const helloIndex = client.frames.findIndex((frame) => (frame as { method?: string }).method === 'hello')
      const traceIndex = client.frames.findIndex((frame) => (frame as { method?: string }).method === 'trace')
      expect(helloIndex).toBeLessThan(traceIndex)
    }
    first.close()
    second.close()
    await host.close()
  })

  test('a runtime without a well-formed identity helloes nobody', async () => {
    const home = tempHome()
    const fake = fakeRuntime({ instanceId: 'bp_instance_test' } as typeof identity)
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    await Bun.sleep(100)
    const hellos = client.frames.filter((frame) => (frame as { method?: string }).method === 'hello')
    expect(hellos).toEqual([])
    client.close()
    await host.close()
  })

  test('a trigger request lands as an engine event and answers accepted', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    client.send({ type: 'trigger', detail: { event: { type: 'kick' } } })
    type ResponseFrame = { id: number; result?: unknown; error?: unknown }
    const response = await client.waitFor<ResponseFrame>(
      (frame) => (frame as { id?: number }).id === 1,
      'trigger response',
    )
    expect(fake.triggers).toEqual([{ type: 'kick' }])
    expect(response.result).toEqual({ accepted: true })
    client.close()
    await host.close()
  })

  test('redacted traces fan back out to every connected client', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const first = await attachClient(host.path)
    const second = await attachClient(host.path)
    fake.emit(traceOf(TRACE_MESSAGE_KINDS.idle))
    const firstTrace = await first.waitFor<{ method: string; params: Trace }>(
      (frame) => (frame as { method?: string }).method === 'trace',
      'trace on client one',
    )
    const secondTrace = await second.waitFor<{ method: string; params: Trace }>(
      (frame) => (frame as { method?: string }).method === 'trace',
      'trace on client two',
    )
    expect(firstTrace.params.kind).toBe(TRACE_MESSAGE_KINDS.idle)
    expect(secondTrace.params.kind).toBe(TRACE_MESSAGE_KINDS.idle)
    first.close()
    second.close()
    await host.close()
  })

  test('a ui_* selection is pushed to clients as its own notification', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    fake.emit(selectionOf({ type: 'ui_render', detail: { id: 'r1', target: 'main' } }))
    const frame = await client.waitFor<{ method: string; params: JsonObject }>(
      (item) => (item as { method?: string }).method === 'ui_render',
      'ui_render notification',
    )
    expect(frame.params).toEqual({ id: 'r1', target: 'main' })
    client.close()
    await host.close()
  })

  test('an unknown method is answered with a JSON-RPC error', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    client.sendRaw('{"jsonrpc":"2.0","id":2,"method":"nope"}')
    const frame = await client.waitFor<{ id: number; error?: { code: number } }>(
      (item) => (item as { id?: number }).id === 2,
      'error response',
    )
    expect(frame.error?.code).toBe(-32603)
    client.close()
    await host.close()
  })

  test('the socket file lives while the host runs and is removed on close', async () => {
    const home = tempHome()
    const path = instanceSocketPath(home)
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    expect(existsSync(path)).toBe(true)
    await host.close()
    expect(existsSync(path)).toBe(false)
  })

  test('a stale socket file from a dead instance is replaced at start', async () => {
    const home = tempHome()
    writeFileSync(instanceSocketPath(home), 'garbage from a crashed instance')
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const client = await attachClient(host.path)
    client.send({ type: 'trigger', detail: { event: { type: 'kick' } } })
    await client.waitFor((frame) => (frame as { id?: number }).id === 1, 'trigger response')
    client.close()
    await host.close()
  })

  test('the ui capture lane is wired: a ui run lands in <home>/captures', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      // A scripted ui pipeline under one minted pipeline id (pid `ui-e2e`):
      // the render ingress, the scale check, the browser reply, and the
      // render — the capture binds the run by the pid lineage and closes it
      // at the render.
      fake.emit({
        ...selectionOf({ type: 'render', detail: {} }),
        selected: { priority: 0, type: 'render', detail: {}, ingress: true },
      })
      fake.emit(
        selectionOf({
          type: 'ui_scale_check',
          detail: { id: 'ui-e2e-scale', target: 'body', swap: 'innerHTML' },
        }) as never,
      )
      fake.emit(
        selectionOf({
          type: 'ui_scale_check_result',
          detail: { id: 'ui-e2e-scale', target: 'body', effectiveScale: 's3', timeStamp: 1 },
        }) as never,
      )
      fake.emit(
        selectionOf({
          type: 'ui_render',
          detail: { id: 'ui-e2e-render', target: 'body', html: '<p>x</p>', swap: 'innerHTML' },
        }) as never,
      )
      const file = join(home, 'captures', 'ui-runs.jsonl')
      const deadline = Date.now() + 5_000
      while (!existsSync(file)) {
        if (Date.now() > deadline) throw new Error('capture file never appeared')
        await Bun.sleep(10)
      }
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { messages: Array<{ selected: { type: string } }> })
      expect(lines).toHaveLength(1)
      expect(lines[0]!.messages.map((m) => m.selected.type)).toEqual([
        'render',
        'ui_scale_check',
        'ui_scale_check_result',
        'ui_render',
      ])
    } finally {
      await host.close()
    }
  })

  test('a configured provider list emits the CSP connect-src — self + the daemon origin + exactly those origins', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({
      runtime: fake.runtime,
      home,
      inferenceProviders: {
        typesafe: 'https://api.typesafe.ai',
        selfhosted: 'https://blackwell.lan/v1',
      },
    })
    try {
      const response = await fetch(`http://localhost${CONNECT_BEHAVIORAL_ROUTE}`, { unix: host.path })
      expect(response.status).toBe(200)
      const csp = response.headers.get('content-security-policy')
      expect(csp).toBe("connect-src 'self' http://localhost https://api.typesafe.ai https://blackwell.lan/v1")
    } finally {
      await host.close()
    }
  })

  test('the inference proxy rides the carrier: the page mints the session cookie, the cookie authenticates the proxied call', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const provider = await startInferenceProvider({ token: PROVIDER_TOKEN })
    const keychain = InMemoryKeychain()
    await saveProviderToken({
      provider: 'typesafe',
      origin: new URL(provider.url).origin,
      token: PROVIDER_TOKEN,
      keychain,
    })
    const host = await createSocketHost({
      runtime: fake.runtime,
      home,
      inferenceProviders: { typesafe: provider.url },
      keychain,
    })
    try {
      // The page response mints the browser presentation: the httpOnly cookie.
      const page = await fetch(`http://localhost${CONNECT_BEHAVIORAL_ROUTE}`, { unix: host.path })
      expect(page.status).toBe(200)
      const setCookie = page.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
      expect(setCookie).toContain('HttpOnly')
      const token = (setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)) ?? [])[1]
      expect(typeof token).toBe('string')
      // The minted token is the durable, revocable session.
      expect((await Bun.file(sessionTokenPath(home)).text()).trim()).toBe(token as string)

      // Sessionless → 401, and the provider is never reached.
      const denied = await fetch('http://localhost/v1/inference/typesafe/responses', {
        unix: host.path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', input: [] }),
      })
      expect(denied.status).toBe(401)
      expect(provider.requests).toHaveLength(0)

      // The cookie authenticates the worker→daemon hop (R3).
      const ok = await fetch('http://localhost/v1/inference/typesafe/responses', {
        unix: host.path,
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: JSON.stringify({ model: 'm', input: [{ type: 'message', role: 'user', content: 'hi' }] }),
      })
      expect(ok.status).toBe(200)
      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0]!.auth).toBe(`Bearer ${PROVIDER_TOKEN}`)
    } finally {
      await host.close()
      await provider.close()
    }
  })

  test('the trace fan-out is scoped: a composition client receives its space, a driver receives root — disjoint', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const { actuatorLaneBuilders } = await import('../serve.ts')
    const host = await createSocketHost({
      runtime: fake.runtime,
      home,
      facultyLanes: actuatorLaneBuilders(['store']),
    })
    try {
      const token = (await Bun.file(sessionTokenPath(home)).text()).trim()
      const bridgeHeaders = { authorization: `Bearer ${token}` }

      // Two attach-lane clients with different scopes.
      const composition = await attachClient(host.path, {
        headers: bridgeHeaders,
        onOpen: (socket) =>
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'attach_scope',
              params: { scope: 'composition', space: 'tab_a' },
            }),
          ),
      })
      const driver = await attachClient(host.path)

      // The bridge's push leg (composition scope by the gate — proven at the
      // bridge level) folds into host.pushTrace; drive the fold directly (the
      // WS hop is the bridge spec's).
      host.pushTrace({
        kind: 'idle',
        space: 'tab_a',
        timestamp: 1,
        instanceId: 'i',
        sessionId: 's',
        step: 1,
      } as unknown as Trace)

      // The composition-scoped client receives the pushed tab_a trace.
      await composition.waitFor<{ method: string; params: { kind?: string; space?: string } }>(
        (frame) =>
          (frame as { method?: string }).method === 'trace' &&
          (frame as { params?: { space?: string } }).params?.space === 'tab_a',
        'the pushed tab_a trace',
      )

      // The daemon engine's own root trace goes to the driver only.
      fake.emit(traceOf(TRACE_MESSAGE_KINDS.idle))
      await driver.waitFor<{ method: string; params: { kind?: string } }>(
        (frame) => (frame as { method?: string }).method === 'trace',
        'the root trace',
      )

      // Disjoint: the driver never saw the composition's space-stamped trace;
      // the composition client never saw the daemon's root trace.
      await Bun.sleep(150)
      const traceOf_ = (client: { frames: unknown[] }) =>
        client.frames.filter((frame) => (frame as { method?: string }).method === 'trace') as Array<{
          params?: { kind?: string; space?: string }
        }>
      expect(traceOf_(driver).some((frame) => frame.params?.space === 'tab_a')).toBe(false)
      expect(
        traceOf_(composition).some((frame) => frame.params?.space === undefined || frame.params?.space === 'root'),
      ).toBe(false)
      expect(traceOf_(composition).some((frame) => frame.params?.space === 'tab_a')).toBe(true)
      expect(traceOf_(driver).length).toBeGreaterThan(0)
      composition.close()
      driver.close()
    } finally {
      await host.close()
    }
  })

  test('an unauthenticated composition-scope declaration is REJECTED loud — attach_scope_rejected, not a silent downgrade', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      // No cookie, no bearer — the client declares composition scope anyway.
      const client = await attachClient(host.path)
      client.sendRaw(
        JSON.stringify({ jsonrpc: '2.0', method: 'attach_scope', params: { scope: 'composition', space: 'tab_x' } }),
      )
      // The refusal is EXPLICIT — the client observes it on the wire.
      const rejection = await client.waitFor<{ method: string; params: { reason?: string } }>(
        (frame) => (frame as { method?: string }).method === 'attach_scope_rejected',
        'the attach_scope rejection',
      )
      expect(rejection.params?.reason).toBe('session_required')
      // The refusal is real: the client keeps the driver scope — no
      // space-stamped traffic ever arrives.
      host.pushTrace({
        kind: 'idle',
        space: 'tab_x',
        timestamp: 1,
        instanceId: 'i',
        sessionId: 's',
        step: 1,
      } as unknown as Trace)
      await Bun.sleep(150)
      expect(
        client.frames.some(
          (frame) =>
            (frame as { method?: string }).method === 'trace' &&
            (frame as { params?: { space?: string } }).params?.space === 'tab_x',
        ),
      ).toBe(false)
      client.close()
    } finally {
      await host.close()
    }
  })

  test('an unauthenticated driver declaration is untouched — no rejection, driver traffic flows', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      const client = await attachClient(host.path)
      client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'attach_scope', params: { scope: 'driver' } }))
      await Bun.sleep(150)
      // Drivers need no session — the declaration is silent-accepted.
      expect(client.frames.some((frame) => (frame as { method?: string }).method === 'attach_scope_rejected')).toBe(
        false,
      )
      // Driver traffic: the daemon's root-space traces.
      fake.emit(traceOf(TRACE_MESSAGE_KINDS.idle))
      await client.waitFor<{ method: string }>(
        (frame) => (frame as { method?: string }).method === 'trace',
        'the driver trace',
      )
      client.close()
    } finally {
      await host.close()
    }
  })

  test('a sessioned composition declaration is granted — no rejection, composition traffic flows', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      const token = (await Bun.file(sessionTokenPath(home)).text()).trim()
      const client = await attachClient(host.path, {
        headers: { authorization: `Bearer ${token}` },
        onOpen: (socket) =>
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'attach_scope',
              params: { scope: 'composition', space: 'tab_g' },
            }),
          ),
      })
      await Bun.sleep(150)
      expect(client.frames.some((frame) => (frame as { method?: string }).method === 'attach_scope_rejected')).toBe(
        false,
      )
      host.pushTrace({
        kind: 'idle',
        space: 'tab_g',
        timestamp: 1,
        instanceId: 'i',
        sessionId: 's',
        step: 1,
      } as unknown as Trace)
      await client.waitFor<{ method: string; params: { space?: string } }>(
        (frame) =>
          (frame as { method?: string }).method === 'trace' &&
          (frame as { params?: { space?: string } }).params?.space === 'tab_g',
        'the composition trace',
      )
      client.close()
    } finally {
      await host.close()
    }
  })

  test('the faculty-wire bridge route is gated at the host: sessionless → 401, sessioned → upgrade attempted', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const { actuatorLaneBuilders } = await import('../serve.ts')
    const host = await createSocketHost({
      runtime: fake.runtime,
      home,
      facultyLanes: actuatorLaneBuilders(['store']),
    })
    try {
      // Fail-closed: no session, no faculty-wire traffic.
      const denied = await fetch('http://localhost/faculty-wire', {
        unix: host.path,
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      })
      expect(denied.status).toBe(401)

      // The session (bearer — the CLI attacher presentation) admits the
      // upgrade; a plain fetch has no WS handshake, so the host answers 426
      // (the upgrade was attempted, the gate passed).
      const token = (await Bun.file(sessionTokenPath(home)).text()).trim()
      const admitted = await fetch('http://localhost/faculty-wire', {
        unix: host.path,
        headers: { connection: 'upgrade', upgrade: 'websocket', authorization: `Bearer ${token}` },
      })
      expect(admitted.status).toBe(426)
    } finally {
      await host.close()
    }
  })

  test('the faculty-wire bridge route is closed when the host configures no lanes', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      const token = (await Bun.file(sessionTokenPath(home)).text()).trim()
      const res = await fetch('http://localhost/faculty-wire', {
        unix: host.path,
        headers: { connection: 'upgrade', upgrade: 'websocket', authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(404)
    } finally {
      await host.close()
    }
  })

  test('a plain HTTP request on the carrier is refused with 426', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    const response = await fetch('http://localhost/', { unix: host.path })
    expect(response.status).toBe(426)
    await host.close()
  })

  test('the reload ingress: a driver triggers it; an unauthenticated composition client CANNOT', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      // THE DRIVER: reload dispatches — the trigger lands on the runtime.
      const driver = await attachClient(host.path)
      driver.sendRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r1',
          method: 'plugin_threads_reload',
          params: { id: 'driver-reload' },
        }),
      )
      const ack = await driver.waitFor<{ id?: string; result?: { accepted?: boolean } }>(
        (frame) => (frame as { id?: string }).id === 'r1',
        'the reload ack',
      )
      expect(ack.result?.accepted).toBe(true)
      expect(
        fake.triggers.some(
          (t) => t.type === 'plugin_threads_reload' && (t.detail as { id?: string })?.id === 'driver-reload',
        ),
      ).toBe(true)

      // THE UNAUTHENTICATED COMPOSITION CLIENT: the scope declaration is
      // rejected loud (no session) — the client is TAINTED for the reload
      // capability; the trigger NEVER dispatches.
      const stranger = await attachClient(host.path)
      stranger.sendRaw(
        JSON.stringify({ jsonrpc: '2.0', method: 'attach_scope', params: { scope: 'composition', space: 'tab_x' } }),
      )
      await stranger.waitFor<{ method: string }>(
        (frame) => (frame as { method?: string }).method === 'attach_scope_rejected',
        'the scope rejection',
      )
      stranger.sendRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r2',
          method: 'plugin_threads_reload',
          params: { id: 'stranger-reload' },
        }),
      )
      const refusal = await stranger.waitFor<{ id?: string; error?: { message?: string } }>(
        (frame) => (frame as { id?: string }).id === 'r2',
        'the reload refusal',
      )
      expect(refusal.error?.message).toContain('reload')
      expect(fake.triggers.some((t) => (t.detail as { id?: string } | undefined)?.id === 'stranger-reload')).toBe(false)
      driver.close()
      stranger.close()
    } finally {
      await host.close()
    }
  })

  test('the conventional worker route serves the self-booting composition bundle', async () => {
    const home = tempHome()
    const fake = fakeRuntime()
    const host = await createSocketHost({ runtime: fake.runtime, home })
    try {
      const response = await fetch(`http://localhost${B_PROGRAM_WORKER_PATH}`, { unix: host.path })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')?.startsWith('text/javascript')).toBe(true)
      // fetch transparently decompresses the gzip body — the composition's
      // wire markers (the bundler-visible faculty literals + the attach
      // protocol) ride the decoded text.
      const body = await response.text()
      expect(body).toContain('attach')
      expect(body).toContain('system-one.faculty.ts')
    } finally {
      await host.close()
    }
  })
})
