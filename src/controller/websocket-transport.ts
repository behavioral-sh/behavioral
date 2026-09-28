import type { Disconnect } from '../behavioral/behavioral.types.ts'
import { UI_CORE_MAX_RETRIES, UI_CORE_RETRY_STATUS_CODES } from './controller.constants.ts'
import { WebSocketError, WebSocketMessageError } from './controller.errors.ts'
import type { ClientMessage, ServerMessage, Transport, TransportEvent } from './controller.types.ts'

/** Options passed to the built-in WS carrier. */
export type WebSocketTransportOptions = {
  /**
   * Registers a teardown callback with the controller's disconnect set so a
   * pending reconnect timer is cleared on pagehide (preserving the pre-seam
   * teardown semantics). Defaults to a no-op for non-controller callers.
   */
  registerDisconnect?: (disconnect: Disconnect) => void
}

export class WebSocketTransport implements Transport {
  #url: string
  #socket: WebSocket | undefined
  #queue: string[] = []
  #retryCount = 0
  #messageHandlers = new Set<(message: ServerMessage) => void>()
  #statusHandlers = new Set<(event: TransportEvent) => void>()
  #registerDisconnect: (disconnect: Disconnect) => void

  constructor(url: string, options: WebSocketTransportOptions = {}) {
    this.#url = url
    this.#registerDisconnect = options.registerDisconnect ?? (() => {})
    this.#connect()
  }

  send(message: ClientMessage): void {
    const onOpen = () => {
      for (const msg of this.#queue) this.#socket?.send(msg)
      this.#queue = []
      this.#socket?.removeEventListener('open', onOpen)
    }
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message))
      return
    }
    this.#queue.push(JSON.stringify(message))
    if (!this.#socket) this.#connect()
    this.#socket?.addEventListener('open', onOpen)
  }

  onMessage(handler: (message: ServerMessage) => void): Disconnect {
    this.#messageHandlers.add(handler)
    return () => {
      this.#messageHandlers.delete(handler)
    }
  }

  onStatus(handler: (event: TransportEvent) => void): Disconnect {
    this.#statusHandlers.add(handler)
    return () => {
      this.#statusHandlers.delete(handler)
    }
  }

  #connect(): void {
    this.#closeSocket(this.#socket)
    this.#socket = new WebSocket(this.#url)
    this.#socket.addEventListener('open', this.#onSocketEvent)
    this.#socket.addEventListener('message', this.#onSocketEvent)
    this.#socket.addEventListener('error', this.#onSocketEvent)
    this.#socket.addEventListener('close', this.#onSocketEvent)
  }

  #onSocketEvent = (event: Event): void => {
    try {
      const target = event.target
      if (!(target instanceof WebSocket)) {
        throw new WebSocketError(`WebSocket listener received event without WebSocket target`, {
          cause: {
            eventType: event.type,
            socketUrl: target instanceof WebSocket ? target.url : null,
            socketReadyState: target instanceof WebSocket ? target.readyState : null,
          },
        })
      }
      if (target !== this.#socket) return
      if (event.type === 'open') {
        this.#retryCount = 0
        for (const msg of this.#queue) this.#socket?.send(msg)
        this.#queue = []
        this.#socket.removeEventListener('open', this.#onSocketEvent)
        return
      }
      if (event instanceof MessageEvent) {
        this.#handleMessage(event)
        return
      }
      if (event instanceof CloseEvent && UI_CORE_RETRY_STATUS_CODES.has(event.code)) this.#retry()
      if (event.type === 'error') {
        throw new WebSocketError(`WebSocket error on ${target.url} (readyState: ${target.readyState})`, {
          cause: {
            eventType: event.type,
            socketUrl: target instanceof WebSocket ? target.url : null,
            socketReadyState: target instanceof WebSocket ? target.readyState : null,
          },
        })
      }
    } catch (err) {
      const error = err instanceof Error ? err : new WebSocketError('page listener error', { cause: err })
      this.#emitError(error)
    }
  }

  #handleMessage(event: MessageEvent): void {
    let parsed: ServerMessage
    try {
      parsed = JSON.parse(String(event.data)) as ServerMessage
    } catch (err) {
      const error = err instanceof Error ? err : new WebSocketMessageError('web socket listener error', { cause: err })
      this.#emitError(error)
      return
    }
    for (const handler of this.#messageHandlers) handler(parsed)
  }

  #retry(): void {
    this.#closeSocket(this.#socket)
    if (this.#retryCount >= UI_CORE_MAX_RETRIES) return
    const maxDelay = Math.min(9_999, 1_000 * 2 ** this.#retryCount)
    const id = setTimeout(() => this.#connect(), Math.floor(Math.random() * maxDelay))
    this.#registerDisconnect(() => clearTimeout(id))
    this.#retryCount++
  }

  #closeSocket(socket?: WebSocket): void {
    if (!socket) return
    this.#socket = undefined
    socket.removeEventListener('open', this.#onSocketEvent)
    socket.removeEventListener('message', this.#onSocketEvent)
    socket.removeEventListener('error', this.#onSocketEvent)
    socket.removeEventListener('close', this.#onSocketEvent)
    if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close()
  }

  #emitError(error: Error): void {
    for (const handler of this.#statusHandlers) handler({ type: 'error', error })
  }
}
