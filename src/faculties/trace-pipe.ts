import type { Trace } from '../behavioral/behavioral.types.ts'
import { TRACE_PUSH_KIND } from './faculties.constants.ts'
import type { FacultyWireFrame } from './faculties.types.ts'

/**
 * The trace pipe — the composition worker's upstream trace leg (the
 * one-observability-stream ruling): the worker's REDACTED trace stream
 * pushes to the daemon bridge, where it folds into the daemon's one
 * observability stream (the JSONL persistence home) and fans out to scoped
 * clients only. Push-only: no re-entries, no result seal — the worker's
 * stream has no inbound half.
 *
 * @remarks
 * The transport discipline mirrors the socket lane's (the ruled third
 * lane's): queue-before-open (sends queue as JSON lines and flush in order
 * on open), bounded reconnect (a retryable close — abnormal drop / service
 * restart — retries with capped exponential backoff; exhausted retries drop
 * the stream VISIBLY — one console warning, never a silent dead pipe), and
 * the landed framing (one JSON line per event — a trace rides
 * `{ type: TRACE_PUSH_KIND, detail: <trace> }`, the shared frame home).
 *
 * Scoped by construction (pin 3): the pipe connects to the daemon bridge —
 * the composition capability — which is session-gated; an unauthenticated
 * worker never pushes trace traffic. The browser attaches the session
 * cookie itself; no token rides any frame.
 *
 * @packageDocumentation
 */

/** The retryable close codes — abnormal drop (1006), service restart (1012/1013). */
const RETRYABLE_CLOSE_CODES = new Set([1006, 1012, 1013])
/** The reconnect budget — bounded, then the stream drops visibly. */
const MAX_RETRIES = 3

export type TracePipe = {
  /** Push one (already-redacted) trace upstream — queues when the socket is down. */
  push: (trace: Trace) => void
  terminate: () => void
}

export type TracePipeOptions = {
  /** The daemon bridge's WS URL — a string, or a lazy resolver (boot-time config). */
  url: string | (() => string)
}

export const tracePipe = ({ url }: TracePipeOptions): TracePipe => {
  const resolveUrl = (): string => (typeof url === 'function' ? url() : url)
  let socket: WebSocket | undefined
  let terminated = false
  let retryCount = 0
  let warned = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const queue: string[] = []

  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    console.warn(`[trace-pipe] ${message}`)
  }

  const closeSocket = (): void => {
    const current = socket
    socket = undefined
    if (current === undefined) return
    current.onopen = null
    current.onmessage = null
    current.onerror = null
    current.onclose = null
    if (current.readyState !== WebSocket.CLOSED && current.readyState !== WebSocket.CLOSING) current.close()
  }

  const connect = (): void => {
    if (terminated || socket !== undefined) return
    let next: WebSocket
    try {
      next = new WebSocket(resolveUrl())
    } catch (error) {
      warnOnce(`connect failed: ${(error as Error).message}`)
      return
    }
    socket = next
    next.onopen = () => {
      retryCount = 0
      for (const line of queue) next.send(line)
      queue.length = 0
    }
    next.onmessage = () => {
      // Push-only: the pipe has no inbound half — anything arriving is ignored.
    }
    next.onerror = () => {
      // The close event follows; the close handler owns the verdict.
    }
    next.onclose = (event: CloseEvent) => {
      socket = undefined
      if (terminated) return
      if (RETRYABLE_CLOSE_CODES.has(event.code) && retryCount < MAX_RETRIES) {
        const delay = Math.min(9_999, 1_000 * 2 ** retryCount)
        retryTimer = setTimeout(
          () => {
            retryTimer = undefined
            connect()
          },
          Math.floor(Math.random() * delay),
        )
        retryCount++
        return
      }
      warnOnce(
        retryCount >= MAX_RETRIES
          ? `reconnect exhausted after ${MAX_RETRIES} attempts — the upstream stream dropped`
          : `closed unexpectedly (code ${event.code}) — the upstream stream dropped`,
      )
    }
  }

  return {
    push: (trace: Trace): void => {
      if (terminated) return
      const frame: FacultyWireFrame = { type: TRACE_PUSH_KIND, detail: trace as unknown as Record<string, unknown> }
      const line = JSON.stringify(frame)
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(line)
        return
      }
      queue.push(line)
      if (socket === undefined) connect()
    },
    terminate: (): void => {
      terminated = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      closeSocket()
    },
  }
}
