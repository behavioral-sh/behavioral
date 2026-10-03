import type { ValidateFunction } from 'ajv'
import type { BPEvent, JsonObject } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from './faculties.constants.ts'
import type { AddThreads, FacultyLane } from './faculties.types.ts'

/**
 * The socket lane — the faculty wire's WebSocket client, the ruled third lane
 * beside spawn (the actuator processes) and worker (`useWorker`). The
 * browser's actuator reach: a bProgram worker cannot spawn processes, so the
 * shell/store/security lanes speak the faculty wire over a WebSocket to the
 * daemon bridge (the thin faculty host, later work — this lane lands DARK
 * against fixture servers). Tauri/native-bridge transports swap behind the
 * same interface later.
 *
 * @remarks
 * The machinery is the controller's WS transport's proven shape, re-homed to
 * the faculty wire:
 *
 * - **queue-before-open** — sends before the socket opens queue (JSON lines)
 *   and flush in order on open;
 * - **reconnect** — a retryable close (abnormal drop / service restart) is
 *   retried with capped exponential backoff, bounded; exhausted retries
 *   surface as ONE `faculty_error` re-entry (fail-visible, never a silent
 *   dead lane);
 * - **re-entry law** — a result event re-enters as ONE once-thread through
 *   `addThreads` (the worker lane's own shape): the composition's addThread +
 *   step owns every re-entry;
 * - **fail-visible inbound** — a malformed frame (unparseable, wrong kind,
 *   no correlation id) re-enters ONE `faculty_error` naming the problem;
 *   an unexpected socket death synthesizes the crash event exactly once
 *   (the worker lane's crash synthesis — in-flight requests never answer;
 *   the engine's `waitFor [result, faculty_error]` pattern covers it).
 *
 * No `threads` parameter, no spawn machinery — the packs are host-minted;
 * this is a wire lane only. The returned builder takes the composition's
 * `addThreads` and yields EXACTLY the ruled four-key lane.
 *
 * @packageDocumentation
 */

/** The retryable close codes — abnormal drop (1006), service restart (1012/1013). */
const RETRYABLE_CLOSE_CODES = new Set([1006, 1012, 1013])
/** The reconnect budget — bounded, then the lane fails visibly. */
const MAX_RETRIES = 3

export type SocketLaneOptions = {
  /** The daemon bridge's WS URL — a string, or a lazy resolver (boot-time config). */
  url: string | (() => string)
  /** The lane's wire name (the composition routes by it). */
  name: string
  /** The wire home's once-compiled request validator (the outbound gate). */
  validateRequest: ValidateFunction
  /** The wire home's once-compiled cancel validator — absent for faculties with no cancel contract. */
  validateCancel?: ValidateFunction
  /** The inbound lane's seal: only this result kind re-enters. */
  resultKind: string
}

type SocketLine = { type: string; detail?: Record<string, unknown>; space?: string }

/**
 * The socket lane's factory — `socketLane({ url, name, validateRequest,
 * validateCancel?, resultKind })` returns the curried builder the composition
 * consumes (a `LaneBuilder`): invoke it with `addThreads` to bind the
 * re-entries and own the lifecycle.
 */
export const socketLane =
  ({ url, name, validateRequest, validateCancel, resultKind }: SocketLaneOptions) =>
  (addThreads: AddThreads): FacultyLane => {
    // The URL resolves at CONNECT time (first send or reconnect) — a lazy
    // resolver reads boot-time config (the worker location, the daemon bridge
    // path) only when the lane is actually used.
    const resolveUrl = (): string => (typeof url === 'function' ? url() : url)
    let socket: WebSocket | undefined
    let terminated = false
    let retryCount = 0
    let synthesizedDeath = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const queue: string[] = []

    /** Re-enter one event as a once-thread, space preserved (root stays root) — the worker lane's shape. */
    const reenter = (message: SocketLine): void => {
      const detail = (message.detail ?? {}) as JsonObject
      addThreads([
        {
          ...(message.space === undefined ? {} : { space: message.space }),
          name: `on_${message.type}_${typeof message.detail?.id === 'string' ? message.detail.id : name}`,
          description: `Socket re-entry — once-thread re-emitting the ${message.type} wire event.`,
          once: true,
          rules: [{ request: { type: message.type, detail } }],
        },
      ])
    }

    /** One crash-synthesis re-entry: the lane died without an answer. */
    const synthesizeDeath = (message: string): void => {
      if (synthesizedDeath) return
      synthesizedDeath = true
      reenter({
        type: FACULTY_MESSAGE_KINDS.faculty_error,
        detail: { id: `crash_${name}_socket`, faculty: name, message },
      })
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
        synthesizeDeath(`socket connect failed: ${(error as Error).message}`)
        return
      }
      socket = next
      next.onopen = () => {
        retryCount = 0
        for (const line of queue) next.send(line)
        queue.length = 0
      }
      next.onmessage = (event: MessageEvent) => {
        let line: SocketLine
        try {
          line = JSON.parse(String(event.data)) as SocketLine
        } catch (error) {
          // Malformed inbound: fail-visible, never a silent drop.
          reenter({
            type: FACULTY_MESSAGE_KINDS.faculty_error,
            detail: {
              id: `malformed_${name}_socket`,
              faculty: name,
              message: `malformed frame: ${(error as Error).message}`,
            },
          })
          return
        }
        if (line.type !== resultKind || typeof line.detail?.id !== 'string') {
          reenter({
            type: FACULTY_MESSAGE_KINDS.faculty_error,
            detail: {
              id: `malformed_${name}_socket`,
              faculty: name,
              message: `malformed frame: expected ${resultKind} with a string id, got ${line.type ?? 'no type'}`,
            },
          })
          return
        }
        synthesizedDeath = false
        reenter(line)
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
        synthesizeDeath(
          retryCount >= MAX_RETRIES
            ? `socket reconnect exhausted after ${MAX_RETRIES} attempts`
            : `socket closed unexpectedly (code ${event.code})`,
        )
      }
    }

    const send = (event: BPEvent): void => {
      if (terminated) return
      // MINIMAL: a send racing a server-side close can be lost (the socket
      // reads OPEN until the close frame lands — undetectable client-side).
      // The daemon bridge's ack/replay layer is the upgrade path; the engine's
      // own retry patterns (the judge-retry precedent) cover the requester
      // meanwhile.
      const line = JSON.stringify(event)
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(line)
        return
      }
      // Queue-before-open: the sends flush in order on open (or on reconnect).
      queue.push(line)
      if (socket === undefined) connect()
    }

    return {
      name,
      send,
      invalidEventGate: (event: BPEvent): boolean =>
        !validateRequest(event) && (validateCancel === undefined || !validateCancel(event)),
      terminate: (): void => {
        terminated = true
        if (retryTimer !== undefined) clearTimeout(retryTimer)
        closeSocket()
      },
    }
  }
