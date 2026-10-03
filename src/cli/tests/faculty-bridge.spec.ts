import { describe, expect, test } from 'bun:test'
import { ACTUATOR_MESSAGE_KINDS } from '../../actuators/actuators.constants.ts'
import { useActuator } from '../../actuators/use-actuator.ts'
import type { LaneBuilder } from '../../faculties/faculties.types.ts'
import { validateStoreRequestEvent } from '../../faculties/faculties.types.ts'
import { createFacultyBridge, DAEMON_BRIDGE_PATH, type FacultyBridgeSocketData } from '../faculty-bridge.ts'
import { validSession } from '../session.ts'

/**
 * The faculty bridge spec — the daemon's /faculty-wire relay, driven through
 * REAL round-trips: a real spawned actuator process behind the bridge, real
 * WebSocket clients, the landed socket-lane framing (one JSON line per wire
 * event). The crash-synthesis case runs the real useActuator death path (the
 * fixture process exits mid-flight, unsolicited).
 */

/** The real store actuator lane — the same construction createRuntime mints. */
const storeLane = (): LaneBuilder =>
  useActuator({
    command: ['bun', 'run', 'store.actuator.ts'],
    name: 'store',
    validateRequest: validateStoreRequestEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
  })

/** The mid-flight-death lane — the fixture process exits unsolicited on DIE_MARKER. */
const DIE_MARKER = 'trigger-die'
const dyingLane = (): LaneBuilder =>
  useActuator({
    command: ['bun', 'run', new URL('./fixtures/bridge-actuator.ts', import.meta.url).pathname],
    name: 'store',
    validateRequest: validateStoreRequestEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
  })

/** A real WS client on the bridge: JSON-line frames in, waitFor, close. */
type BridgeClient = {
  frames: unknown[]
  closed: boolean
  send: (frame: unknown) => void
  /** A raw (possibly non-JSON) line — the malformed-frame case. */
  sendRaw: (line: string) => void
  waitFor: <T>(pred: (frame: unknown) => boolean, what: string) => Promise<T>
  close: () => void
}

/** Mount the bridge on a real TCP loopback server (the socket-host's dispatch shape). */
const startBridge = (laneBuilders: LaneBuilder[]): { url: string; stop: () => void } => {
  const bridge = createFacultyBridge({ laneBuilders, session: (req) => validSession(req, 'sess-1') })
  const server = Bun.serve<FacultyBridgeSocketData>({
    port: 0,
    fetch: (req, srv) =>
      new URL(req.url).pathname === DAEMON_BRIDGE_PATH
        ? bridge.upgrade(req, (r, options) => srv.upgrade(r, options as never))
        : new Response('not found', { status: 404 }),
    websocket: {
      open: (ws) => bridge.open(ws),
      message: (ws, m) => bridge.message(ws, typeof m === 'string' ? m : new TextDecoder().decode(m)),
      close: (ws) => bridge.close(ws),
    },
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

const attach = async (bridgeUrl: string, token = 'sess-1'): Promise<BridgeClient> =>
  await new Promise((resolveClient, reject) => {
    const frames: unknown[] = []
    let ws: WebSocket
    const client: BridgeClient = {
      frames,
      closed: false,
      send: (frame) => ws.send(JSON.stringify(frame)),
      sendRaw: (line) => ws.send(line),
      waitFor: async <T>(pred: (frame: unknown) => boolean, what: string): Promise<T> => {
        const deadline = Date.now() + 10_000
        for (;;) {
          const found = frames.find(pred)
          if (found !== undefined) return found as T
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames)}`)
          await Bun.sleep(10)
        }
      },
      close: () => ws.close(),
    }
    ws = new WebSocket(`${bridgeUrl}${DAEMON_BRIDGE_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    } as never)
    ws.addEventListener('open', () => resolveClient(client))
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))))
    ws.addEventListener('close', () => {
      client.closed = true
    })
    ws.addEventListener('error', () => {
      client.closed = true
      reject(new Error('client socket error'))
    })
  })

const storeRequest = (
  id: string,
  input: Record<string, unknown> = { collection: 'docs', key: 'k', value: { v: 1 } },
) => ({
  type: 'store_request',
  detail: { id, op: 'put', input },
})

describe('the faculty bridge', () => {
  test('an unauthenticated attach is rejected closed — 401, no upgrade, no faculty-wire traffic', async () => {
    const { url, stop } = startBridge([storeLane()])
    try {
      const res = await fetch(`${url}${DAEMON_BRIDGE_PATH}`, {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      })
      expect(res.status).toBe(401)
    } finally {
      stop()
    }
  })

  test('a sessioned attach round-trips a store_request through the real spawned actuator', async () => {
    const { url, stop } = startBridge([storeLane()])
    let client: BridgeClient | undefined
    try {
      client = await attach(url)
      client.send(storeRequest('s1'))
      const result = await client.waitFor<{ type: string; detail: { id: string; ok: boolean } }>(
        (frame) => (frame as { type?: string }).type === 'store_request_result',
        'the store result',
      )
      expect(result.detail.id).toBe('s1')
      expect(result.detail.ok).toBe(true)
      expect(client.closed).toBe(false)
    } finally {
      client?.close()
      stop()
    }
  })

  test('an actuator death mid-flight arrives as exactly ONE faculty_error; the connection stays; the next request respawns', async () => {
    const { url, stop } = startBridge([dyingLane()])
    let client: BridgeClient | undefined
    try {
      client = await attach(url)
      // The request goes out; the actuator dies mid-flight without answering.
      client.send(storeRequest('d1', { die: DIE_MARKER }))
      const error = await client.waitFor<{ type: string; detail: { faculty: string; message: string } }>(
        (frame) =>
          (frame as { type?: string }).type === 'faculty_error' &&
          String((frame as { detail?: { message?: string } }).detail?.message).includes('process exited'),
        'the crash faculty_error',
      )
      expect(error.detail.faculty).toBe('store')
      // Exactly ONE death synthesis crossed the wire for the one death.
      const deaths = client.frames.filter(
        (frame) =>
          (frame as { type?: string }).type === 'faculty_error' &&
          String((frame as { detail?: { message?: string } }).detail?.message).includes('process exited'),
      )
      expect(deaths).toHaveLength(1)
      // The connection stayed; the lane respawns on demand and answers.
      expect(client.closed).toBe(false)
      client.send(storeRequest('d2'))
      const result = await client.waitFor<{ type: string; detail: { id: string; ok: boolean } }>(
        (frame) => (frame as { type?: string; detail?: { id?: string } }).detail?.id === 'd2',
        'the post-respawn result',
      )
      expect(result.detail.ok).toBe(true)
    } finally {
      client?.close()
      stop()
    }
  })

  test('a malformed frame fails visibly and the connection stays', async () => {
    const { url, stop } = startBridge([storeLane()])
    let client: BridgeClient | undefined
    try {
      client = await attach(url)
      client.sendRaw('this is not json at all')
      const error = await client.waitFor<{ type: string; detail: { faculty: string; message: string } }>(
        (frame) => (frame as { type?: string }).type === 'faculty_error',
        'the malformed faculty_error',
      )
      expect(error.detail.message).toContain('malformed frame')
      expect(client.closed).toBe(false)
      // The connection still relays.
      client.send(storeRequest('s2'))
      const result = await client.waitFor<{ detail: { id: string } }>(
        (frame) => (frame as { detail?: { id?: string } }).detail?.id === 's2',
        'the post-error result',
      )
      expect(result).toBeDefined()
    } finally {
      client?.close()
      stop()
    }
  })

  test('an unroutable kind fails visibly and the connection stays', async () => {
    const { url, stop } = startBridge([storeLane()])
    let client: BridgeClient | undefined
    try {
      client = await attach(url)
      client.send({ type: 'frontier_analysis_request', detail: { id: 'x1', op: 'replay', input: {} } })
      const error = await client.waitFor<{ type: string; detail: { faculty: string; message: string } }>(
        (frame) => (frame as { type?: string }).type === 'faculty_error',
        'the unroutable faculty_error',
      )
      expect(error.detail.message).toContain('frontier_analysis_request')
      expect(client.closed).toBe(false)
      // The connection still relays.
      client.send(storeRequest('s2'))
      const result = await client.waitFor<{ detail: { id: string } }>(
        (frame) => (frame as { detail?: { id?: string } }).detail?.id === 's2',
        'the post-error result',
      )
      expect(result).toBeDefined()
    } finally {
      client?.close()
      stop()
    }
  })

  test('an event failing the lane boundary never reaches the actuator — fail-visible', async () => {
    const { url, stop } = startBridge([storeLane()])
    let client: BridgeClient | undefined
    try {
      client = await attach(url)
      // A store_request without `op` fails the wire home's request schema.
      client.send({ type: 'store_request', detail: { id: 'bad1', input: { collection: 'docs' } } })
      const error = await client.waitFor<{ type: string; detail: { faculty: string; message: string } }>(
        (frame) => (frame as { type?: string }).type === 'faculty_error',
        'the boundary faculty_error',
      )
      expect(error.detail.faculty).toBe('store')
      expect(client.closed).toBe(false)
    } finally {
      client?.close()
      stop()
    }
  })
})
