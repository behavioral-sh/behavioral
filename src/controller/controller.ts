import type { BPEvent, Disconnect } from '../behavioral/behavioral.types.ts'
import {
  B_FORM,
  B_SCALE,
  B_TARGET,
  B_TRIGGER,
  BOOLEAN_ATTRS,
  CONTROLLER_INCOMING_MESSAGE_TYPES,
  CONTROLLER_OUTGOING_MESSAGE_TYPES,
  PAGE_EVENTS,
  SCALE,
  SCALE_RANK,
  SWAP_MODES,
  SWAP_TARGETS,
} from './controller.constants.ts'
import {
  type ControllerErrors,
  ElementNotFoundError,
  FormSubmitError,
  OnStarAttributeError,
  PageExtensionError,
  RenderInvalidTriggerError,
  TriggerError,
  UpdateTriggerAttributeError,
  WebSocketMessageError,
  XSSVectorsDetected,
} from './controller.errors.ts'
import type {
  AttrsMessage,
  ClientMessage,
  ControllerConstructorArgs,
  ControllerExtension,
  DispatchCustomEventMessage,
  NavigateMessage,
  RenderMessage,
  ScaleCheckMessage,
  ServerMessage,
  Transport,
} from './controller.types.ts'
import {
  DelegatedListener,
  detectXssVectors,
  isInvalidTrigger,
  isOnStarAttribute,
  swapBoundary,
} from './controller.utils.ts'
import { B_PROGRAM_WORKER_PATH, WorkerTransport } from './worker-transport.ts'

const delegates = new WeakMap<EventTarget, DelegatedListener>()

const getAttributes = (element: Element): Record<string, string> => {
  return Object.fromEntries(Array.from(element.attributes, (attr) => [attr.name, attr.value]))
}

const updateAttributes = ({
  element,
  attr,
  val,
}: {
  element: Element
  attr: string
  val: string | null | number | boolean
}) => {
  if (val === null && element.hasAttribute(attr)) return element.removeAttribute(attr)
  if (val === null) return
  if (BOOLEAN_ATTRS.has(attr)) {
    !element.hasAttribute(attr) && element.toggleAttribute(attr, true)
    return
  }
  if (element.getAttribute(attr) !== `${val}`) element.setAttribute(attr, `${val}`)
}

const isPageShow = (event: Event): event is PageTransitionEvent => event.type === PAGE_EVENTS.pageshow

const isPageHide = (event: Event): event is PageTransitionEvent => event.type === PAGE_EVENTS.pagehide
const isPageReveal = (event: Event): event is PageRevealEvent => event instanceof PageRevealEvent
const isPageSwap = (event: Event): event is PageSwapEvent => event instanceof PageSwapEvent
const isSubmit = (event: Event): event is SubmitEvent => event instanceof SubmitEvent

/**
 * Browser-side controller for an agent-rendered page in a multi-page app.
 *
 * @remarks
 * One instance per page, loaded via an async module script in `<head>`. The
 * controller talks to its serving agent over an injectable {@link Transport}
 * (the default built-in WebSocket carrier), binds `b-trigger` and `b-form`
 * declarations in the DOM, and applies server-pushed `render`, `attrs`,
 * `dispatch_custom_event`, and `navigate` messages. User interactions emit
 * `ui_event` messages back to the agent, which decides what to render in
 * response — a push-based model distinct from pull-based hypermedia clients.
 *
 * The browser owns document-bound teardown (listeners, sockets, timers) on
 * unload and bfcache freeze; the controller does not force-close the carrier on
 * `pagehide` so a queued snapshot can flush during teardown.
 *
 * @public
 */
export class Controller {
  constructor({ extensions, onPageReveal, onPageSwap, onPageHide, onPageShow, transport }: ControllerConstructorArgs) {
    this.#extensions = extensions
    this.#onPageHide = onPageHide
    this.#onPageReveal = onPageReveal
    this.#onPageShow = onPageShow
    this.#onPageSwap = onPageSwap
    this.#injectedTransport = transport
  }
  #extensions?: Map<string, ControllerExtension>
  #onPageHide: ControllerConstructorArgs['onPageHide']
  #onPageReveal: ControllerConstructorArgs['onPageReveal']
  #onPageShow: ControllerConstructorArgs['onPageShow']
  #onPageSwap: ControllerConstructorArgs['onPageSwap']
  #disconnectSet = new Set<Disconnect>()
  #injectedTransport?: Transport | Worker | MessagePort
  #transport: Transport | undefined
  #transportWired = false
  #addDisconnect(disconnect: Disconnect) {
    this.#disconnectSet.add(disconnect)
  }
  /**
   * @internal
   * Resolves the active carrier. The default is the worker carrier: a
   * dedicated module Worker spawned from the conventional
   * {@link B_PROGRAM_WORKER_PATH} serving path — the composition (the
   * bProgram worker) boots in the worker, and the page talks postMessage.
   * An injected carrier always wins: a `Worker`/`MessagePort` is wrapped in
   * the worker Transport; a full `Transport` is used as-is. The carrier is
   * wired for incoming dispatch + status/error reporting exactly once.
   */
  #getTransport(): Transport {
    if (!this.#transport) {
      const injected = this.#injectedTransport
      if (injected instanceof Worker || injected instanceof MessagePort) {
        this.#transport = new WorkerTransport({ worker: injected })
      } else {
        this.#transport =
          injected ??
          new WorkerTransport({
            worker: new Worker(new URL(B_PROGRAM_WORKER_PATH, self.location.origin), { type: 'module' }),
          })
      }
      this.#wireTransport(this.#transport)
    }
    return this.#transport
  }
  /**
   * @internal
   * Registers the incoming-dispatch and status/error handlers on the carrier.
   * Idempotent — safe whether the carrier was injected or lazily created.
   */
  #wireTransport(transport: Transport) {
    if (this.#transportWired) return
    this.#transportWired = true
    transport.onMessage((message) => this.#handleIncoming(message))
    transport.onStatus((event) => {
      // open/close are carrier state; only errors surface to the agent
      // (matching the pre-seam listener's catch → #reportError path).
      if (event.type === 'error') this.#reportError(event.error)
    })
  }
  #send(message: ClientMessage) {
    this.#getTransport().send(message)
  }
  #sendSnapshot(type: keyof typeof PAGE_EVENTS) {
    this.#send({
      type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_snapshot,
      detail: {
        timeStamp: Date.now(),
        type,
        serializedHTML: document.documentElement.getHTML({ serializableShadowRoots: true }),
      },
    })
  }
  #reportError(error: ControllerErrors, id?: string) {
    this.#send({
      type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_error,
      detail: {
        timeStamp: Date.now(),
        id,
        name: error.name,
        error: error.toString(),
        stack: error.stack,
        violations: 'violations' in error ? error.violations : undefined,
      },
    })
  }
  #trigger(event: BPEvent) {
    this.#send({
      type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_event,
      detail: {
        event,
        timeStamp: Date.now(),
      },
    })
  }
  #bindTriggers(subtree: DocumentFragment | HTMLBodyElement) {
    const elements = subtree.querySelectorAll(`[${B_TRIGGER}]`)
    for (const element of elements) {
      const raw = element.getAttribute(B_TRIGGER)
      if (!raw) continue
      const handlers = new Map<string, (event: Event) => void>()
      for (const pair of raw.split(';')) {
        const separator = pair.indexOf(':')
        if (separator <= 0) continue

        const domEvent = pair.slice(0, separator)
        const type = pair.slice(separator + 1)
        if (!domEvent || !type) continue
        const handleEvent = async (event: Event) => {
          try {
            if (this.#extensions?.has(pair)) {
              const extension = this.#extensions.get(pair)!
              await extension({
                event,
                trigger: this.#trigger.bind(this),
              })
            } else {
              this.#trigger({
                type,
                detail: getAttributes(element),
              })
            }
          } catch (err) {
            const error = err instanceof Error ? err : new TriggerError('trigger error', { cause: err })
            this.#reportError(error)
          }
        }
        handlers.set(domEvent, handleEvent)
      }
      const listener =
        delegates.get(element) ??
        new DelegatedListener((event: Event) => {
          const type = event.type
          const handler = handlers.get(type)
          handler?.(event)
        })
      delegates.set(element, listener)
      for (const type of handlers.keys()) {
        element.addEventListener(type, listener)
      }
    }
  }
  #bindForms(subtree: DocumentFragment | HTMLBodyElement) {
    const elements = subtree.querySelectorAll<HTMLFormElement>(`form[${B_FORM}]`)
    for (const element of elements) {
      const listener =
        delegates.get(element) ??
        new DelegatedListener(async (event: Event) => {
          try {
            if (!isSubmit(event)) return
            event.preventDefault()
            const form = event.currentTarget as HTMLFormElement
            const formData = new FormData(form)
            const response = await fetch(window.location.href, {
              method: 'POST',
              body: formData,
              headers: {
                [B_TRIGGER]: element.getAttribute(B_FORM)!,
              },
            })
            if (!response.ok) {
              const errorText = await response.text().catch(() => 'No error body details')
              throw new FormSubmitError('Form submission failed with status', {
                cause: {
                  status: response.status,
                  errorText,
                },
              })
            }
          } catch (err) {
            const error =
              err instanceof Error ? err : new FormSubmitError('Form data event handler threw an error', { cause: err })
            this.#reportError(error)
          }
        })
      delegates.set(element, listener)
      element.addEventListener('submit', listener)
    }
  }
  #bind() {
    const body = document.querySelector('body')
    if (body) {
      this.#bindForms(body)
      this.#bindTriggers(body)
    }
  }
  // Server Message Handlers
  #performSwap({
    element,
    html,
    swap,
    id,
  }: {
    element: Element
    html: string
    swap: keyof typeof SWAP_MODES
    id: string
  }) {
    const template = document.createElement('template')
    template.setHTMLUnsafe(html)
    const content = template.content
    const invalidTriggers = Array.from(content.querySelectorAll(`[${B_TRIGGER}]`)).flatMap((element) => {
      const value = element.getAttribute(B_TRIGGER)!
      return isInvalidTrigger(value) ? (element.cloneNode(false) as Element).outerHTML : []
    })

    if (invalidTriggers.length) {
      this.#reportError(new RenderInvalidTriggerError(invalidTriggers), id)
      return
    }
    const xssVectors = detectXssVectors(content)
    if (xssVectors.length) {
      this.#reportError(new XSSVectorsDetected(xssVectors), id)
      return
    }

    this.#bindTriggers(content)
    this.#bindForms(content)
    switch (swap) {
      case SWAP_MODES.afterbegin:
        element.prepend(content)
        break
      case SWAP_MODES.afterend:
        element.after(content)
        break
      case SWAP_MODES.beforebegin:
        element.before(content)
        break
      case SWAP_MODES.beforeend:
        element.append(content)
        break
      case SWAP_MODES.innerHTML:
        element.replaceChildren(content)
        break
      case SWAP_MODES.outerHTML:
        element.replaceWith(content)
        break
    }
  }
  #render({ target, html, swap, id, match = '=' }: RenderMessage['detail']) {
    const nodelist = document.querySelectorAll(`[${B_TARGET}${match}"${target}"]`)
    const length = nodelist.length
    for (let i = 0; i < length; i++) {
      const element = nodelist[i]
      if (!element)
        throw new ElementNotFoundError(`${CONTROLLER_INCOMING_MESSAGE_TYPES.ui_render}`, {
          cause: {
            id,
            target,
          },
        })
      this.#performSwap({
        element,
        html: html,
        swap,
        id,
      })
    }
  }
  #attrs({ target, attr, id, match = '=' }: AttrsMessage['detail']) {
    const nodelist = document.querySelectorAll(`[${B_TARGET}${match}"${target}"]`)
    const length = nodelist.length
    for (let i = 0; i < length; i++) {
      const element = nodelist[i]
      if (!element)
        throw new ElementNotFoundError(`${CONTROLLER_INCOMING_MESSAGE_TYPES.ui_attrs}`, {
          cause: {
            id,
            target,
          },
        })
      for (const key in attr) {
        // The on* floor (the #style-deletion ruling's amendment): an inline
        // event-handler attribute compiles a LIVE handler on a connected
        // element — report-and-skip per key, errors-as-data; innocent keys
        // around it still apply.
        if (isOnStarAttribute(key)) {
          this.#reportError(new OnStarAttributeError(key), id)
          continue
        }
        if (key === B_TRIGGER && attr[key] !== null && isInvalidTrigger(attr[key])) {
          this.#reportError(new UpdateTriggerAttributeError(`${attr[key]}`), id)
          continue
        }
        updateAttributes({
          element,
          attr: key,
          val: attr[key]!,
        })
      }
    }
  }
  #dispatchCustomEvent({
    id,
    target,
    event: { type, detail },
    bubbles,
    cancelable,
    composed,
  }: DispatchCustomEventMessage['detail']) {
    const element = document.querySelector(`[${B_TARGET}="${target}"]`)
    if (!element)
      throw new ElementNotFoundError(`${CONTROLLER_INCOMING_MESSAGE_TYPES.ui_dispatch_custom_event}`, {
        cause: {
          id,
          target,
        },
      })
    const event = new CustomEvent(type, {
      bubbles,
      cancelable,
      composed,
      detail,
    })
    element.dispatchEvent(event)
  }
  #navigate({ url, replace }: NavigateMessage['detail']) {
    if (replace) window.location.replace(url)
    else window.location.assign(url)
  }
  #scaleCheck({ target, swap, id, match = '=' }: ScaleCheckMessage['detail']) {
    const nodelist = document.querySelectorAll(`[${B_TARGET}${match}"${target}"]`)
    const boundary = swapBoundary(swap)
    const scales: (keyof typeof SCALE)[] = []
    for (const element of nodelist) {
      const scaleEl =
        boundary === SWAP_TARGETS.self
          ? element.closest(`[${B_SCALE}]`)
          : element.parentElement?.closest(`[${B_SCALE}]`)
      const scale = scaleEl?.getAttribute(B_SCALE) ?? SCALE.rel
      scales.push(scale as keyof typeof SCALE)
    }
    const effectiveScale =
      scales.filter((s) => s !== SCALE.rel).sort((a, b) => SCALE_RANK[a] - SCALE_RANK[b])[0] ?? SCALE.rel
    this.#send({
      type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_scale_check_result,
      detail: { id, target, effectiveScale, timeStamp: Date.now() },
    })
  }
  /**
   * @internal
   * Incoming dispatch — the carrier delivers a parsed {@link ServerMessage};
   * this is the pre-seam `#webSocketListener` body minus the JSON.parse (now
   * in the carrier). Ingress stays ungated here as before — the carrier's
   * parse is the only admission check today (MINIMAL: the Phase 6
   * `validateBPEvent` boundary gate is a separate, future admission layer).
   */
  #handleIncoming(message: ServerMessage) {
    let id: string | undefined
    try {
      const { type, detail } = message
      id = detail.id
      switch (type) {
        case CONTROLLER_INCOMING_MESSAGE_TYPES.ui_render: {
          this.#render(detail)
          break
        }
        case CONTROLLER_INCOMING_MESSAGE_TYPES.ui_attrs: {
          this.#attrs(detail)
          break
        }
        case CONTROLLER_INCOMING_MESSAGE_TYPES.ui_dispatch_custom_event: {
          this.#dispatchCustomEvent(detail)
          break
        }
        case CONTROLLER_INCOMING_MESSAGE_TYPES.ui_navigate: {
          this.#navigate(detail)
          break
        }
        case CONTROLLER_INCOMING_MESSAGE_TYPES.ui_scale_check: {
          this.#scaleCheck(detail)
          return
        }
      }
      this.#send({
        type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_success,
        detail: {
          id,
          timeStamp: Date.now(),
        },
      })
    } catch (err) {
      const error = err instanceof Error ? err : new WebSocketMessageError('web socket listener error', { cause: err })
      this.#reportError(error, id)
    }
  }
  async #pageHideListener(event: PageTransitionEvent) {
    await this.#onPageHide?.({
      event,
      trigger: this.#trigger.bind(this),
    })
    this.#sendSnapshot(PAGE_EVENTS.pagehide)
    for (const cb of this.#disconnectSet) void cb()
    this.#disconnectSet.clear()
  }
  async #pageRevealListener(event: PageRevealEvent) {
    await this.#onPageReveal?.({
      event,
      trigger: this.#trigger.bind(this),
    })
    this.#sendSnapshot(PAGE_EVENTS.pagereveal)
  }
  async #pageShowListener(event: PageTransitionEvent) {
    await this.connect()
    await this.#onPageShow?.({
      event,
      trigger: this.#trigger.bind(this),
    })
    this.#sendSnapshot(PAGE_EVENTS.pageshow)
  }
  async #pageSwapListener(event: PageSwapEvent) {
    await this.#onPageSwap?.({
      event,
      trigger: this.#trigger.bind(this),
    })
    this.#sendSnapshot(PAGE_EVENTS.pageswap)
  }
  #connectPage() {
    const listener =
      delegates.get(window) ??
      new DelegatedListener((event: Event) => {
        try {
          isPageHide(event) && void this.#pageHideListener(event)
          isPageReveal(event) && void this.#pageRevealListener(event)
          isPageShow(event) && void this.#pageShowListener(event)
          isPageSwap(event) && void this.#pageSwapListener(event)
        } catch (err) {
          const error = err instanceof Error ? err : new PageExtensionError('page listener error', { cause: err })
          this.#reportError(error)
        }
      })
    window.addEventListener(PAGE_EVENTS.pagehide, listener)
    window.addEventListener(PAGE_EVENTS.pagereveal, listener)
    window.addEventListener(PAGE_EVENTS.pageshow, listener)
    window.addEventListener(PAGE_EVENTS.pageswap, listener)
    const disconnect = () => {
      window.removeEventListener(PAGE_EVENTS.pagehide, listener)
      window.removeEventListener(PAGE_EVENTS.pagereveal, listener)
      window.removeEventListener(PAGE_EVENTS.pageshow, listener)
      window.removeEventListener(PAGE_EVENTS.pageswap, listener)
    }
    this.#addDisconnect(disconnect)
  }
  async connect() {
    this.#connectPage()
    this.#getTransport()
    this.#bind()
  }
}
