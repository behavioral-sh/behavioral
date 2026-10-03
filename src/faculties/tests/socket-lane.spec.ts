import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { BPEvent, Thread } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { validateStoreRequestEvent } from '../../faculties/faculties.types.ts'
import { socketLane } from '../socket-lane.ts'

/**
 * The socket lane — the faculty wire's WS client, the ruled third lane beside
 * spawn and worker (the Decision Log's transport ruling). Lands DARK against
 * a fixture echo server: the daemon bridge (the thin faculty host) is later
 * work — these specs pin the lane's own contract: request out → result in
 * (the re-entry law holds over the socket), queue-before-open, reconnect
 * (the retryable close codes), malformed frames fail-visible, and the pin:
 * the returned lane is EXACTLY the ruled four-key interface.
 */

type StoredMessage = { data: string }

/** A fixture echo server: every `*_request` line answered with the paired result. */
const startEchoServer = async (port = 0) => {
  const received: StoredMessage[] = []
  let sockets: Set<{ send: (data: string) => void; close: (code?: number) => void }> = new Set()
  const server = Bun.serve({
    port,
    fetch: (request, server) => {
      if (server.upgrade(request)) return undefined
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      message: (ws, message) => {
        received.push({ data: String(message) })
        const event = JSON.parse(String(message)) as BPEvent
        if (!String(event.type).endsWith('_request')) return
        ws.send(
          JSON.stringify({
            type: `${event.type}_result`,
            detail: { id: (event.detail as { id?: string }).id, ok: true, result: event.detail },
            ...(event.space === undefined ? {} : { space: event.space }),
          }),
        )
      },
      open: (ws) => {
        sockets.add(ws as never)
      },
      close: (ws) => {
        sockets.delete(ws as never)
      },
    },
  })
  return {
    port: server.port,
    received,
    url: `ws://localhost:${server.port}`,
    /** Drop every open socket with the given close code (the reconnect fixture). */
    dropAll: (code = 1012): void => {
      for (const socket of sockets) socket.close(code)
      sockets = new Set()
    },
    send: (data: string): void => {
      for (const socket of sockets) socket.send(data)
    },
    stop: () => server.stop(true),
  }
}

describe('the socket lane — the faculty wire over a WebSocket', () => {
  let server: Awaited<ReturnType<typeof startEchoServer>>

  beforeAll(async () => {
    server = await startEchoServer()
  })

  afterAll(() => {
    server.stop()
  })

  const buildLane = (addThreads: (threads: Thread[]) => void) =>
    socketLane({
      url: server.url,
      name: 'store',
      validateRequest: validateStoreRequestEvent,
      resultKind: FACULTY_MESSAGE_KINDS.store_request_result,
    })(addThreads)

  test('the returned lane is EXACTLY the ruled four-key interface (the pin)', () => {
    const lane = buildLane(() => {})
    expect(Object.keys(lane).sort()).toEqual(['invalidEventGate', 'name', 'send', 'terminate'])
    expect(lane.name).toBe('store')
    lane.terminate()
  })

  test('request out -> result in: the result re-enters under the re-entry law', async () => {
    const reentered: Thread[] = []
    const lane = buildLane((threads) => reentered.push(...threads))
    try {
      lane.send({
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: { id: 'ws_1', op: 'get', input: { collection: 'docs', key: 'a' } },
      })
      // The re-entry is the once-thread whose request IS the result event —
      // the engine's addThread + step takes it from here (the worker lane's
      // own shape).
      const deadline = Date.now() + 5_000
      while (
        !reentered.some((t) => (t.rules[0]?.request as { type?: string } | undefined)?.type?.endsWith('_result'))
      ) {
        if (Date.now() > deadline) throw new Error(`no result re-entry; saw: ${JSON.stringify(reentered)}`)
        await Bun.sleep(10)
      }
      const thread = reentered.find((t) =>
        (t.rules[0]?.request as { type?: string } | undefined)?.type?.endsWith('_result'),
      )!
      expect(thread.once).toBe(true)
      expect(thread.name).toContain('ws_1')
      const request = thread.rules[0]!.request as { type: string; detail: { id?: string; ok?: boolean } }
      expect(request.type).toBe(FACULTY_MESSAGE_KINDS.store_request_result)
      expect(request.detail.id).toBe('ws_1')
      expect(request.detail.ok).toBe(true)
    } finally {
      lane.terminate()
    }
  })

  test('queue-before-open: sends before the socket opens deliver in order', async () => {
    // A lane aimed at a server that is not listening yet — the sends queue.
    const late = await startEchoServer()
    late.stop()
    const latePort: number = (late.port as number) + 1
    const lane = socketLane({
      url: `ws://localhost:${latePort}`,
      name: 'store',
      validateRequest: validateStoreRequestEvent,
      resultKind: FACULTY_MESSAGE_KINDS.store_request_result,
    })(() => {})
    // The first send constructs + queues; the second queues behind it.
    lane.send({ type: FACULTY_MESSAGE_KINDS.store_request, detail: { id: 'q1', input: {} } })
    lane.send({ type: FACULTY_MESSAGE_KINDS.store_request, detail: { id: 'q2', input: {} } })
    // Bring the port alive: the reconnect machinery finds the echo server.
    const revived = await startEchoServer(latePort)
    try {
      const deadline = Date.now() + 10_000
      while (revived.received.length < 2) {
        if (Date.now() > deadline)
          throw new Error(`queued sends never delivered; saw: ${JSON.stringify(revived.received)}`)
        await Bun.sleep(10)
      }
      const ids = revived.received.map((m) => (JSON.parse(m.data) as { detail: { id: string } }).detail.id)
      expect(ids).toEqual(['q1', 'q2'])
    } finally {
      lane.terminate()
      revived.stop()
    }
  })

  test('a retryable close reconnects — the lane recovers and round-trips again', async () => {
    const reentered: Thread[] = []
    const lane = buildLane((threads) => reentered.push(...threads))
    try {
      lane.send({ type: FACULTY_MESSAGE_KINDS.store_request, detail: { id: 'r1', input: {} } })
      const deadline = Date.now() + 5_000
      while (reentered.length === 0) {
        if (Date.now() > deadline) throw new Error('first round-trip never landed')
        await Bun.sleep(10)
      }
      // The fixture drops every socket with a retryable close code — the
      // lane's backoff reconnects (the same URL, the same server).
      server.dropAll(1012)
      // The requester retries until the lane recovers: a send racing the
      // server-side close can be lost (the socket reads OPEN until the close
      // frame lands — undetectable client-side; the daemon bridge's ack layer
      // is the upgrade path). The judge-retry precedent shapes the loop.
      const deadline2 = Date.now() + 10_000
      let lastSend = 0
      while (
        !reentered.some((t) => (t.rules[0]?.request as { detail?: { id?: string } } | undefined)?.detail?.id === 'r2')
      ) {
        if (Date.now() > deadline2)
          throw new Error(`no re-entry after reconnect; saw: ${JSON.stringify(reentered.map((t) => t.name))}`)
        if (Date.now() - lastSend > 300) {
          lastSend = Date.now()
          lane.send({ type: FACULTY_MESSAGE_KINDS.store_request, detail: { id: 'r2', input: {} } })
        }
        await Bun.sleep(10)
      }
    } finally {
      lane.terminate()
    }
  })

  test('a malformed frame fails visible — a faculty_error re-entry names the problem', async () => {
    const reentered: Thread[] = []
    const lane = buildLane((threads) => reentered.push(...threads))
    try {
      // Wait for the socket to open (the first round-trip), then push garbage
      // from the server side.
      lane.send({ type: FACULTY_MESSAGE_KINDS.store_request, detail: { id: 'm0', input: {} } })
      const deadline = Date.now() + 5_000
      while (reentered.length === 0) {
        if (Date.now() > deadline) throw new Error('the round-trip never landed')
        await Bun.sleep(10)
      }
      const errorsBefore = reentered.filter(
        (t) => (t.rules[0]?.request as { type?: string } | undefined)?.type === 'faculty_error',
      )
      expect(errorsBefore).toEqual([])
      server.send('this is not json')
      const deadline2 = Date.now() + 5_000
      while (
        !reentered.some(
          (t) =>
            (t.rules[0]?.request as { type?: string; detail?: { message?: string } } | undefined)?.type ===
            'faculty_error',
        )
      ) {
        if (Date.now() > deadline2)
          throw new Error(`no faculty_error; saw: ${JSON.stringify(reentered.map((t) => t.name))}`)
        await Bun.sleep(10)
      }
      const errorThread = reentered.find(
        (t) => (t.rules[0]?.request as { type?: string } | undefined)?.type === 'faculty_error',
      )!
      const request = errorThread.rules[0]!.request as { detail: { faculty?: string; message?: string } }
      expect(request.detail.faculty).toBe('store')
      expect(request.detail.message).toContain('malformed frame')
    } finally {
      lane.terminate()
    }
  })
})
