/**
 * Public type definitions for the behavioral controller system.
 *
 * @remarks
 * Defines the shapes for constructor arguments, extension registration, and
 * agent card metadata used by {@link Controller}.
 *
 * @packageDocumentation
 */

import type { BPEvent, Disconnect, JsonValue, Trigger } from '../behavioral/behavioral.types.ts'
import type {
  CONTROLLER_INCOMING_MESSAGE_TYPES,
  CONTROLLER_OUTGOING_MESSAGE_TYPES,
  PAGE_EVENTS,
  SCALE,
  SWAP_MODES,
} from './controller.constants.ts'

/**
 * Resolves the specific event map for a given concrete event target type.
 *
 * @template T - The event target (`HTMLElement` or `Window`)
 *
 * @remarks
 * Most HTML elements share the events defined in `HTMLElementEventMap`
 * (click, mouseenter, input, change, keydown, etc.). Only elements that
 * introduce **additional** unique events have their own maps:
 *
 * | Target | Unique events |
 * |---|---|
 * | `HTMLMediaElement` / `HTMLVideoElement` | `play`, `pause`, `seeking`, `volumechange`, etc. |
 * | `HTMLBodyElement` / `HTMLFrameSetElement` | `afterprint`, `beforeunload`, `hashchange`, `storage`, etc. |
 * | `Window` | Full set at {@link https://developer.mozilla.org/en-US/docs/Web/API/Window#events | MDN} |
 *
 * All other elements (`HTMLSpanElement`, `HTMLDivElement`, `HTMLInputElement`,
 * `HTMLButtonElement`, etc.) resolve to the shared `HTMLElementEventMap`.
 *
 * @see {@link ElementEvent} for resolving a single event payload from a target + key
 */
export type ElementEventMap<T extends HTMLElement | Window> = T extends Window
  ? WindowEventMap
  : T extends HTMLVideoElement
    ? HTMLVideoElementEventMap
    : T extends HTMLMediaElement
      ? HTMLMediaElementEventMap
      : T extends HTMLBodyElement
        ? HTMLBodyElementEventMap
        : /* fallback – div, span, input, button, form, section, p, h1–h6, a, etc. */
          HTMLElementEventMap

/**
 * Resolves the event payload type for a given event target and event name.
 *
 * @template T     - The event target (`HTMLElement` or `Window`)
 * @template TEvent - The event key to look up (defaults to a union of **all** event keys
 *                    for the target, so you get the union of all event payloads)
 *
 * @remarks
 * When **only the target type** is supplied, `TEvent` defaults to
 * `keyof ElementEventMap<T>` — a union of every event name — so the resulting
 * type resolves to a union of every possible event payload for that target.
 *
 * When **both** the target and a specific event name are supplied, the type
 * resolves to the single corresponding event payload (e.g. `MouseEvent` for
 * `'mouseenter'` on `HTMLSpanElement`, or `PageTransitionEvent` for
 * `'pageshow'` on `Window`).
 */
export type ElementEvent<
  T extends HTMLElement | Window,
  TEvent extends keyof ElementEventMap<T> = keyof ElementEventMap<T>,
> = ElementEventMap<T>[TEvent]

/**
 * Context object passed to imported controller extensions.
 *
 * @remarks
 * Provides the primitives a controller extension needs to read the DOM event
 * and trigger behavioral events back to the agent. Extensions are invoked
 * per matching DOM event (not once at setup), so any listener wiring that
 * needs to outlive a single event must be done against `event.currentTarget`
 * within the handler.
 *
 * @public
 */
export type ControllerExtensionParams<
  T extends HTMLElement | Window = HTMLElement,
  TEvent extends keyof ElementEventMap<T> = keyof ElementEventMap<T>,
> = {
  event: ElementEvent<T, TEvent>
  /** Triggers a behavioral event on the controller's page. */
  trigger: Trigger
}

/**
 * Type for a controller extension function.
 *
 * @remarks
 * Each extension is registered in the Controller constructor via the
 * `extensions` map keyed by trigger pair strings (e.g. `"click:my_action"`).
 * When a `b-trigger` attribute value matches an extension key, the function
 * is invoked on each matching DOM event and receives the event plus a
 * `trigger` for emitting behavioral events. It returns nothing (synchronous
 * or promise-based); rejected promises are reported to the agent as errors.
 *
 * @see {@link ControllerExtensionParams} for the received context
 * @public
 */
export type ControllerExtension<
  T extends HTMLElement | Window = HTMLElement,
  TEvent extends keyof ElementEventMap<T> = keyof ElementEventMap<T>,
> = (params: ControllerExtensionParams<T, TEvent>) => void | Promise<void>

/**
 * Arguments for constructing a {@link Controller}.
 *
 * @public
 */
export type ControllerConstructorArgs = {
  /**
   * Optional map of trigger-pair keys to extension functions.
   * Keys follow the pattern `"<domEvent>:<action>"` (e.g. `"click:my_handler"`)
   * and are matched against `b-trigger` attribute values on elements.
   */
  extensions?: Map<string, ControllerExtension>
  /** Called on {@link https://developer.mozilla.org/en-US/docs/Web/API/Window/pagereveal_event | pagereveal}. */
  onPageReveal?: ControllerExtension<Window, 'pagereveal'>
  /** Called on {@link https://developer.mozilla.org/en-US/docs/Web/API/Window/pageswap_event | pageswap}. */
  onPageSwap?: ControllerExtension<Window, 'pageswap'>
  /** Called on {@link https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event | pageshow}. */
  onPageShow?: ControllerExtension<Window, 'pageshow'>
  /** Called on {@link https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event | pagehide}. */
  onPageHide?: ControllerExtension<Window, 'pagehide'>
  /**
   * Optional message carrier. The default is the worker carrier: a dedicated
   * module Worker spawned from the conventional `B_PROGRAM_WORKER_PATH`
   * serving path (the composition boots in the bProgram worker; the page
   * talks postMessage). An injected carrier always wins — a `Worker` or
   * `MessagePort` is wrapped in the built-in worker Transport; a full
   * `Transport` is used as-is (the injection point a non-worker carrier —
   * e.g. the WebSocket carrier for thin GUI clients of a remote host — plugs
   * into).
   */
  transport?: Transport | Worker | MessagePort
}

// ---------------------------------------------------------------------------
// Server → controller messages
// ---------------------------------------------------------------------------

/**
 * Schema for render messages that insert or replace DOM content.
 *
 * @public
 */
export type RenderMessage = {
  type: typeof CONTROLLER_INCOMING_MESSAGE_TYPES.ui_render
  detail: {
    id: string
    target: string
    html: string
    match?: SelectorMatch
    swap: (typeof SWAP_MODES)[keyof typeof SWAP_MODES]
  }
}

/**
 * Schema for controller runtime errors sent from a controller island to the server.
 *
 * @remarks
 * `name` carries the error class (e.g. `ElementNotFoundError`,
 * `ValidationError`); `error` carries the message and `stack` the optional
 * stack trace. These flow back to agent runtimes, so the fields are kept
 * human-readable rather than terse category literals.
 *
 * @public
 */
export type ErrorMessage = {
  type: typeof CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_error
  detail: { timeStamp: number; id?: string; name: string; error?: string; stack?: string; violations?: JsonValue[] }
}

/**
 * Element matching strategies in attribute selectors.
 * - '=':  Exact match
 * - '~=': Space-separated list contains
 * - '|=': Exact match or prefix followed by hyphen
 * - '^=': Starts with
 * - '$=': Ends with
 * - '*=': Contains
 */
export type SelectorMatch = '=' | '~=' | '|=' | '^=' | '$=' | '*='

/**
 * Schema for attrs messages that update element attributes.
 *
 * @public
 */
export type AttrsMessage = {
  type: typeof CONTROLLER_INCOMING_MESSAGE_TYPES.ui_attrs
  detail: {
    id: string
    target: string
    match?: SelectorMatch
    attr: Record<string, string | number | boolean | null>
  }
}

/**
 * Schema for dispatch-custom-event messages that instruct the controller to
 * dispatch a BP event as a custom DOM event on a target element.
 *
 * @public
 */
export type DispatchCustomEventMessage = {
  type: typeof CONTROLLER_INCOMING_MESSAGE_TYPES.ui_dispatch_custom_event
  detail: {
    id: string
    target: string
    event: BPEvent
    bubbles?: boolean
    cancelable?: boolean
    composed?: boolean
  }
}

/**
 * Schema for navigate messages that instruct the controller to navigate to a
 * URL.
 *
 * @remarks
 * When `replace` is `true` the controller uses `location.replace`, otherwise
 * it defaults to `location.assign`.
 *
 * @public
 */
export type NavigateMessage = {
  type: typeof CONTROLLER_INCOMING_MESSAGE_TYPES.ui_navigate
  detail: { id: string; url: string; replace?: boolean }
}

/**
 * Schema for scale-check messages that pre-flight a `render` to learn the
 * structural scale context the content must respect.
 *
 * @remarks
 * Advisory only — does not enforce nesting. The agent sends this before
 * `render` to learn the `b-scale` boundary. The Controller/Renderer walk the
 * matched target's `b-scale` (or nearest ancestor's) and reply with a
 * {@link ScaleCheckResultMessage}.
 *
 * @public
 */
export type ScaleCheckMessage = {
  type: typeof CONTROLLER_INCOMING_MESSAGE_TYPES.ui_scale_check
  detail: { id: string; target: string; swap: (typeof SWAP_MODES)[keyof typeof SWAP_MODES]; match?: SelectorMatch }
}

/**
 * Discriminated union of all server-to-controller message kinds.
 * Consumers narrow by the `type` field.
 *
 * @public
 */
export type ServerMessage =
  | RenderMessage
  | AttrsMessage
  | DispatchCustomEventMessage
  | NavigateMessage
  | ScaleCheckMessage

// ---------------------------------------------------------------------------
// Client → server messages
// ---------------------------------------------------------------------------

/**
 * Schema for BP events sent from a controller island to the server.
 *
 * @public
 */
export type UiEventMessage = {
  type: typeof CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_event
  detail: { event: BPEvent; timeStamp: number }
}

/**
 * Schema for form submissions emitted directly by controller islands.
 *
 * @public
 */
export type FormSubmitMessage = {
  type: typeof CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_form_submit
  detail: {
    name?: string | null
    timeStamp: number
    action?: string | null
    data?: Record<string, string | string[]>
  }
}

/**
 * Schema for success acknowledgements sent from a controller island to the
 * server, keyed by the originating command id.
 *
 * @public
 */
export type SuccessMessage = {
  type: typeof CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_success
  detail: { id: string; timeStamp: number }
}

/**
 * Schema for page snapshots sent from the controller to the server, capturing
 * the serialized DOM at a page lifecycle event.
 *
 * @public
 */
export type PageSnapshot = {
  type: typeof CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_snapshot
  detail: { timeStamp: number; type: (typeof PAGE_EVENTS)[keyof typeof PAGE_EVENTS]; serializedHTML: string }
}

/**
 * Schema for scale-check results sent from the controller/renderer back to the
 * behavioral engine, carrying the resolved effective structural scale.
 *
 * @public
 */
export type ScaleCheckResultMessage = {
  type: typeof CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_scale_check_result
  detail: { id: string; target: string; effectiveScale: (typeof SCALE)[keyof typeof SCALE]; timeStamp: number }
}

/**
 * Discriminated union of all controller-to-server message kinds.
 * Consumers narrow by the `type` field.
 *
 * @public
 */
export type ClientMessage =
  | UiEventMessage
  | FormSubmitMessage
  | ErrorMessage
  | SuccessMessage
  | PageSnapshot
  | ScaleCheckResultMessage

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * A transport status event. `open`/`close` report carrier state; `error`
 * reports a carrier-level failure for the controller to surface to the agent.
 *
 * @public
 */
export type TransportEvent =
  | { type: 'open' }
  | { type: 'close'; code?: number; reason?: string }
  | { type: 'error'; error: Error }

/**
 * The controller's message carrier — the seam a non-WebSocket transport
 * (native IPC, etc.) plugs into without touching controller logic.
 *
 * @remarks
 * The controller sends outgoing {@link ClientMessage}s via `send`, registers
 * for incoming {@link ServerMessage}s via `onMessage`, and registers for
 * carrier status/error events via `onStatus`. The default carrier is the
 * built-in WebSocket implementation (queueing, flush-on-open, randomized
 * backoff reconnect live there); an injected transport replaces it wholesale.
 *
 * @public
 */
export type Transport = {
  /** Send a ClientMessage to the server. */
  send: (message: ClientMessage) => void
  /** Register for incoming ServerMessages. Returns a disconnect. */
  onMessage: (handler: (message: ServerMessage) => void) => Disconnect
  /** Register for carrier status/error events. Returns a disconnect. */
  onStatus: (handler: (event: TransportEvent) => void) => Disconnect
}

export type XssViolation = {
  element: string
  reason: string
}

export type DetectXssViolations = (root: Element | HTMLTemplateElement | DocumentFragment) => XssViolation[]
