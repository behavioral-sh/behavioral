/**
 * The trace-pipe spec's fixture server — a real WS endpoint that records
 * every `{ type: 'trace', detail }` line it receives (the landed faculty-wire
 * framing), can drop its connections (the retryable-service-restart case),
 * and answers structured waits for the spec.
 */

import { TRACE_PUSH_KIND } from '../../faculties.constants.ts'

export type TracePipeServer = {
  url: string
  traces: Array<{ kind?: string }>
  /** The raw frames received, in order (the framing assertions). */
  frames: Array<{ type?: string; detail?: { kind?: string } }>
  waitForTrace: (pred?: (trace: { kind?: string }) => boolean) => Promise<{ kind?: string }>
  traceOrder: () => string[]
  dropConnections: () => Promise<void>
  close: () => Promise<void>
}

export const createTracePipeServer = async (): Promise<TracePipeServer> => {
  const traces: Array<{ kind?: string }> = []
  const frames: Array<{ type?: string; detail?: { kind?: string } }> = []
  const sockets = new Set<{ send: (line: string) => void; close: (code?: number) => void }>()
  let resolveWait: ((trace: { kind?: string }) => void) | undefined
  let predicate: ((trace: { kind?: string }) => boolean) | undefined

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 426 })),
    websocket: {
      open: (ws) => {
        sockets.add(ws)
      },
      message: (ws, raw) => {
        let frame: { type?: string; detail?: { kind?: string } }
        try {
          frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
        } catch {
          return
        }
        frames.push(frame)
        if (frame.type !== TRACE_PUSH_KIND || typeof frame.detail !== 'object' || frame.detail === null) return
        traces.push(frame.detail)
        sockets.add(ws)
        if (resolveWait !== undefined && (predicate === undefined || predicate(frame.detail))) {
          const resolve = resolveWait
          resolveWait = undefined
          predicate = undefined
          resolve(frame.detail)
        }
      },
      close: (ws) => {
        sockets.delete(ws)
      },
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    traces,
    frames,
    waitForTrace: (pred) =>
      new Promise((resolve, reject) => {
        const found = traces.find((t) => (pred ?? (() => true))(t))
        if (found !== undefined) return resolve(found)
        const deadline = Date.now() + 10_000
        const timer = setInterval(() => {
          const hit = traces.find((t) => (pred ?? (() => true))(t))
          if (hit !== undefined) {
            clearInterval(timer)
            resolveWait = undefined
            predicate = undefined
            resolve(hit)
          } else if (Date.now() > deadline) {
            clearInterval(timer)
            resolveWait = undefined
            reject(new Error(`timed out waiting for trace; saw: ${JSON.stringify(traces.map((t) => t.kind))}`))
          }
        }, 10)
        resolveWait = (trace) => {
          clearInterval(timer)
          resolve(trace)
        }
        predicate = pred
      }),
    traceOrder: () => traces.map((t) => t.kind ?? ''),
    dropConnections: async () => {
      for (const ws of [...sockets]) ws.close(1012)
      sockets.clear()
      await Bun.sleep(50)
    },
    close: async () => {
      server.stop(true)
    },
  }
}
