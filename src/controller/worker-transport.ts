import type { Disconnect, Trace } from '../behavioral/behavioral.types.ts'
import { keyMirror } from '../utils.ts'
import type { ClientMessage, ServerMessage, Transport, TransportEvent } from './controller.types.ts'

/**
 * The composition port protocol — the frame vocabulary shared by the
 * bProgram worker entry (which validates inbound frames at its trust edge)
 * and this page-side transport (a dumb relay, no AJV in the page bundle).
 *
 * Frames are discriminated: control frames carry `kind`; the controller's
 * ingress/egress messages ride their own unions (a `ClientMessage` is sent
 * raw; a `ServerMessage` arrives wrapped in a `message` frame). Egress is ONE
 * redacted trace stream per worker, filterable by kind, space-isolated per
 * attached page (root-space traces broadcast; stamped traces deliver to the
 * owning page only) — the egress-as-selection ruling.
 *
 * MINIMAL: the vocabulary lives beside the transport until Slice 4 ports the
 * worker entry (`b-program.worker.ts`) — if the worker side wants its own
 * protocol home, the constants move there and this file imports them back.
 *
 * @public
 */

/** The port frame discriminants (control frames only; messages ride raw). */
export const COMPOSITION_PORT_KINDS = keyMirror('attach', 'hello', 'trace', 'message', 'trace_subscribe')

/** Page → worker: claim the page's space. Omitted = the worker mints one. */
export type CompositionPortAttachFrame = { kind: typeof COMPOSITION_PORT_KINDS.attach; space?: string }

/** Page → worker: scope the trace stream. Omitted kinds = all (full fidelity). */
export type CompositionPortTraceSubscribeFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.trace_subscribe
  kinds?: string[]
}

/** Worker → page: the attach's answer — the engine identity + the page's space. */
export type CompositionPortHelloFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.hello
  space: string
  identity: unknown
}

/** Worker → page: one redacted trace of the page's subscribed stream. */
export type CompositionPortTraceFrame = { kind: typeof COMPOSITION_PORT_KINDS.trace; trace: Trace }

/** Worker → page: a `ui_*` selection as a controller ServerMessage. */
export type CompositionPortMessageFrame = {
  kind: typeof COMPOSITION_PORT_KINDS.message
  message: ServerMessage
}

/**
 * The conventional serving path of the bProgram worker script — the URL the
 * controller's default transport spawns a dedicated module Worker from.
 *
 * THE WORKER URL IS A SERVING CONTRACT, NOT A BUNDLER-DETECTED ENTRY: Bun
 * does not detect `new Worker(new URL(...))` for browser targets (open
 * enhancement oven-sh/bun#18601), so the serving side — the dev host's
 * Bun.serve, the AOT build, the WebView fixture server — must emit the
 * bundled worker at exactly this path. The `.ts` extension is cosmetic (the
 * browser enforces the response's Content-Type, not the URL's); its
 * acceptance is pinned by the `.ts`-URL probe in
 * `worker-transport.webview.spec.ts`.
 *
 * @public
 */
export const B_PROGRAM_WORKER_PATH = '/b-program.worker.ts'

/** Options for the built-in worker carrier. */
export type WorkerTransportOptions = {
  /** The dedicated Worker or a SharedWorker/MessageChannel MessagePort. */
  worker: Worker | MessagePort
  /** Claim the page's space at attach; omitted = the worker mints one. */
  space?: string
  /** Trace kinds to subscribe to; omitted = all (full fidelity). */
  traceKinds?: string[]
  /** Tap for the redacted traces arriving on the port. */
  onTrace?: (trace: Trace) => void
  /** Tap for the hello frame — the engine identity + this page's space. */
  onHello?: (frame: CompositionPortHelloFrame) => void
}

/**
 * The composition port carrier — the controller's Transport over a dedicated
 * `Worker` or a `MessagePort` (the WebSocket twin's shape, mirrored): outgoing
 * ClientMessages post raw, incoming `message` frames forward as
 * ServerMessages, the `hello` frame opens the carrier (and names the page's
 * space), and the full-fidelity redacted trace stream taps `onTrace`.
 *
 * Worker-level failures (script load, runtime errors) surface as `error`
 * status events — never thrown into the page.
 *
 * Dumb relay — the controller owns no AJV and this transport compiles no
 * schemas; the composition worker validates at its trust edge.
 *
 * @public
 */
export class WorkerTransport implements Transport {
  #worker: Worker | MessagePort
  #messageHandlers = new Set<(message: ServerMessage) => void>()
  #statusHandlers = new Set<(event: TransportEvent) => void>()
  #onTrace: ((trace: Trace) => void) | undefined
  #onHello: ((frame: CompositionPortHelloFrame) => void) | undefined
  #space: string | undefined

  constructor({ worker, space, traceKinds, onTrace, onHello }: WorkerTransportOptions) {
    this.#worker = worker
    this.#onTrace = onTrace
    this.#onHello = onHello
    worker.onmessage = (event: MessageEvent) => this.#handle(event.data)
    worker.addEventListener('messageerror', (event: Event) => this.#onWorkerFailure(event))
    // Dedicated Workers fire `error` for script-load and runtime failures;
    // MessagePorts only `messageerror` — the extra registration is inert there.
    worker.addEventListener('error', (event: Event) => this.#onWorkerFailure(event))
    worker.postMessage({
      kind: COMPOSITION_PORT_KINDS.attach,
      ...(space === undefined ? {} : { space }),
    } satisfies CompositionPortAttachFrame)
    worker.postMessage({
      kind: COMPOSITION_PORT_KINDS.trace_subscribe,
      ...(traceKinds === undefined ? {} : { kinds: traceKinds }),
    } satisfies CompositionPortTraceSubscribeFrame)
  }

  /** The page's space (assigned by the worker at attach; set after hello). */
  get space(): string | undefined {
    return this.#space
  }

  /** Send a ClientMessage to the composition worker — raw, no envelope. */
  send(message: ClientMessage): void {
    this.#worker.postMessage(message)
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

  #handle(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>
    if (record.kind === COMPOSITION_PORT_KINDS.hello) {
      this.#space = (record as CompositionPortHelloFrame).space
      this.#onHello?.(record as CompositionPortHelloFrame)
      this.#emitStatus({ type: 'open' })
      return
    }
    if (record.kind === COMPOSITION_PORT_KINDS.trace) {
      this.#onTrace?.((record as CompositionPortTraceFrame).trace)
      return
    }
    if (record.kind === COMPOSITION_PORT_KINDS.message) {
      const message = (record as CompositionPortMessageFrame).message
      for (const handler of this.#messageHandlers) handler(message)
    }
  }

  #onWorkerFailure(event: Event): void {
    const message = event instanceof ErrorEvent ? event.message : 'worker messageerror'
    this.#emitStatus({ type: 'error', error: new Error(message, { cause: event }) })
  }

  #emitStatus(event: TransportEvent): void {
    for (const handler of this.#statusHandlers) handler(event)
  }
}
