import { ERROR_TYPES } from './controller.constants.ts'
import type { XssViolation } from './controller.types.ts'

/**
 * Thrown when a server-pushed render or attrs message names a `b-target` that
 * no longer exists in the DOM.
 *
 * @public
 */
export class ElementNotFoundError extends Error implements Error {
  override name = ERROR_TYPES.element_not_found
}

/**
 * Thrown when an inbound WebSocket message fails JSON parsing or schema
 * validation in the controller's listener.
 *
 * @public
 */
export class WebSocketMessageError extends Error implements Error {
  override name = ERROR_TYPES.web_socket_message
}

/**
 * Thrown when a `b-trigger` event handler (non-extension path) throws while
 * dispatching a behavioral event to the agent.
 *
 * @public
 */
export class TriggerError extends Error implements Error {
  override name = ERROR_TYPES.trigger
}

/**
 * Thrown when a page lifecycle listener (`pagehide`, `pagereveal`,
 * `pageshow`, `pageswap`) or its registered hook throws.
 *
 * @public
 */
export class PageExtensionError extends Error implements Error {
  override name = ERROR_TYPES.page_extension
}

/**
 * Thrown for WebSocket-level failures: error events, unexpected targets, or
 * listener callbacks that fail outside the message-handling path.
 *
 * @public
 */
export class WebSocketError extends Error implements Error {
  override name = ERROR_TYPES.web_socket
}

/**
 * Thrown when a `b-form` submission's HTTP POST fails or returns a non-OK
 * status, or when the form submit handler itself throws.
 *
 * @public
 */
export class FormSubmitError extends Error implements Error {
  override name = ERROR_TYPES.form_submit
}

export class RenderInvalidTriggerError extends Error implements Error {
  override name = ERROR_TYPES.render_invalid_trigger
  readonly violations: string[]
  constructor(violations: string[]) {
    super(`${violations.length} Invalid b-trigger attributes detected`)
    this.violations = violations
  }
}

export class UpdateTriggerAttributeError extends Error implements Error {
  override name = ERROR_TYPES.update_trigger_attribute
  readonly violations: string[]
  constructor(violation: string) {
    super(`Invalid b-trigger detected`)
    this.violations = [violation]
  }
}

/**
 * Thrown (reported-and-skipped per key) when a server-pushed `ui_attrs`
 * message carries an `on*` attribute key — an inline event-handler attribute
 * compiles a live handler on a connected element; the attrs lane never
 * installs executable code. Innocent keys around it still apply.
 *
 * @public
 */
export class OnStarAttributeError extends Error implements Error {
  override name = ERROR_TYPES.on_star_attribute
  readonly violations: string[]
  constructor(key: string) {
    super('Event-handler attribute keys are rejected in ui_attrs')
    this.violations = [key]
  }
}

export class XSSVectorsDetected extends Error implements Error {
  override name = ERROR_TYPES.xss_vectors_detected
  readonly violations: XssViolation[]
  constructor(violations: XssViolation[]) {
    super(`${violations.length} XSS vector(s) detected`)
    this.violations = violations
  }
}

export type ControllerErrors =
  | Error
  | ElementNotFoundError
  | WebSocketMessageError
  | TriggerError
  | PageExtensionError
  | WebSocketError
  | FormSubmitError
  | RenderInvalidTriggerError
  | UpdateTriggerAttributeError
  | XSSVectorsDetected
