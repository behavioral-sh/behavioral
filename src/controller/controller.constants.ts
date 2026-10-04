import { keyMirror } from '../utils.ts'

/*
 * @internal
 *
 * Central constants for hyperscript runtime, template creation, and DOM serialization.
 * Defines the behavioral harness's special attributes and DOM behavior.
 *
 * @remarks
 * Implementation details:
 * - VOID_TAGS and BOOLEAN_ATTRS align with HTML5 and SVG specs
 * - B_TARGET & B_TRIGGER declare controller update and event wiring
 * - Sets provide O(1) lookup performance for validation
 *
 * Known limitations:
 * - Static lists may become outdated with HTML spec changes
 * - No support for custom elements' boolean attributes
 * - Electron-specific attributes hardcoded
 * - Case-sensitive attribute matching
 */

/**
 * Constant representing the attribute name (`b-target`) used to identify specific elements
 * within a controller island for server-pushed render and attribute updates.
 */
export const B_TARGET = 'b-target'
/**
 * Constant representing the attribute name (`b-trigger`) used for declarative event binding,
 * connecting DOM events to BP events sent by a controller island. Serialized values contain
 * umwelt-separated pairs of `event:action` (e.g., "click:doSomething focus:notify").
 */
export const B_TRIGGER = 'b-trigger'

export const B_SCALE = 'b-scale'

export const B_FORM = 'b-form'

/**
 * A Set containing HTML attribute names that are considered boolean attributes.
 * Their presence on an element implies a `true` value, and their absence implies `false`.
 * The attribute value itself is typically omitted in HTML serialization (e.g., `<input disabled>`).
 * This set includes standard HTML boolean attributes and some specific to environments like Electron (`<webview>`).
 */
export const BOOLEAN_ATTRS = new Set([
  // Media and content loading attributes.
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'controls',
  'default',
  'defer',
  'disablepictureinpicture',
  'disableremoteplayback',
  'download',
  'loop',
  'muted',
  'nomodule',
  'playsinline',
  // Form and input state attributes.
  'checked',
  'disabled',
  'formnovalidate',
  'multiple',
  'novalidate',
  'readonly',
  'required',
  'reversed',
  'selected',
  // Accessibility and semantic attributes.
  'inert',
  'ismap',
  'itemscope',
  'open',
  'popover',
  'shadowrootdelegatesfocus',
])

/** @internal WebSocket close codes that warrant reconnect attempts. */
export const UI_CORE_RETRY_STATUS_CODES = new Set([1006, 1012, 1013])

/** @internal Maximum reconnect attempts before a controller island gives up. */
export const UI_CORE_MAX_RETRIES = 3

/**
 * @internal
 * Error name registry mirrored by the `name` field of every controller error
 * class, so the agent can categorize reported errors by stable string key
 * rather than parsing class names.
 */
export const ERROR_TYPES = keyMirror(
  'element_not_found',
  'web_socket_message',
  'trigger',
  'page_extension',
  'web_socket',
  'form_submit',
  'update_trigger_attribute',
  'render_invalid_trigger',
  'xss_vectors_detected',
  'on_star_attribute',
)

/**
 * Event keys used for messages emitted by the browser controller to the
 * behavioral engine.
 *
 * @public
 */
export const CONTROLLER_OUTGOING_MESSAGE_TYPES = keyMirror(
  'ui_event',
  'ui_error',
  'ui_form_submit',
  'ui_success',
  'ui_snapshot',
  'ui_scale_check_result',
)

/**
 * Event keys used for messages emitted by the behavioral engine to the browser
 * controller.
 *
 * @public
 */
export const CONTROLLER_INCOMING_MESSAGE_TYPES = keyMirror(
  'ui_attrs',
  'ui_render',
  'ui_dispatch_custom_event',
  'ui_navigate',
  'ui_scale_check',
)

/**
 * Page lifecycle event keys observed by the browser controller and reported
 * back to the server via snapshot messages.
 *
 * @public
 */
export const PAGE_EVENTS = keyMirror('pagereveal', 'pageswap', 'pagehide', 'pageshow')

export const SCALE = keyMirror('s1', 's2', 's3', 's4', 's5', 's6', 'rel')

export const SCALE_RANK = {
  [SCALE.s1]: 1,
  [SCALE.s2]: 2,
  [SCALE.s3]: 3,
  [SCALE.s4]: 4,
  [SCALE.s5]: 5,
  [SCALE.s6]: 6,
  [SCALE.rel]: 0,
} as const

/**
 * Supported DOM insertion modes for `render` protocol messages.
 *
 * @remarks
 * These values align with the insertion positions accepted by the controller's
 * DOM update path, plus `innerHTML` and `outerHTML` replacement modes.
 *
 * @public
 */
export const SWAP_MODES = keyMirror('afterbegin', 'afterend', 'beforebegin', 'beforeend', 'innerHTML', 'outerHTML')

export const SWAP_TARGETS = keyMirror('parent', 'self')
