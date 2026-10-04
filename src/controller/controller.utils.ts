import { isTypeOf } from '../utils.ts'
import { SWAP_MODES, SWAP_TARGETS } from './controller.constants.ts'
import type { DetectXssViolations, XssViolation } from './controller.types.ts'

/**
 * EventListener adapter for delegated controller callbacks.
 *
 * @template T - Event type (MouseEvent, KeyboardEvent, etc.)
 * @implements {EventListener}
 *
 * @remarks
 * Wraps sync or async callbacks in an object accepted by native
 * `addEventListener`. Controller islands use it for `b-trigger` bindings and
 * imported modules can reuse it for their own delegated DOM listeners.
 *
 * @see {@link delegates} for the WeakMap storage
 *
 * @public
 */
export class DelegatedListener<T extends Event = Event> {
  callback: (ev: T) => void | Promise<void>
  constructor(callback: (ev: T) => void | Promise<void>) {
    this.callback = callback
  }
  handleEvent(evt: T) {
    void this.callback(evt)
  }
}

/**
 * The attrs lane's handler-attribute floor: an `on*` ATTRIBUTE KEY compiles
 * a live event handler the moment `setAttribute` runs (inline event-handler
 * attributes are live on connected elements) — the ui_attrs lane is
 * server-pushed, so a hostile or naive agent-supplied key must never
 * become executable code. Deterministic, report-and-skip per key (the
 * UpdateTriggerAttributeError precedent): errors-as-data, the innocent keys
 * around it still apply.
 *
 * @param key - The attribute key (a string expected; anything else rejects).
 * @returns true when the key is an event-handler attribute (`/^on[a-z]/i` —
 *   the HTML event-handler-content-attribute prefix).
 * @public
 */
export const isOnStarAttribute = (key: unknown): boolean => typeof key !== 'string' || /^on[a-z]/i.test(key)

/**
 * Classify whether a swap mode's structural boundary is the target element
 * itself (`'self'` — content nests *into* the target) or the target's parent
 * (`'parent'` — content *replaces or flanks* the target, so the parent is the
 * boundary).
 *
 * - **Into** (`afterbegin`, `beforeend`, `innerHTML`): the target IS the
 *   structural container → `'self'`.
 * - **Replace/beside** (`beforebegin`, `afterend`, `outerHTML`): the target's
 *   parent is the container → `'parent'`.
 *
 * Shared by the Renderer (SSR) and Controller (browser) so both surfaces apply
 * the same boundary rule before reading `b-scale`.
 *
 * @param swap - A {@link SWAP_MODES} value.
 * @returns `'self'` for into modes, `'parent'` for replace/beside modes.
 * @public
 */
export const swapBoundary = (swap: keyof typeof SWAP_MODES): keyof typeof SWAP_TARGETS => {
  switch (swap) {
    case SWAP_MODES.afterbegin:
    case SWAP_MODES.beforeend:
    case SWAP_MODES.innerHTML:
      return SWAP_TARGETS.self
    default:
      return SWAP_TARGETS.parent
  }
}

// Hoist static lookups outside the function call
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'data',
  'poster',
  'xlink:href',
  // SVG animation target attributes that can dynamically inject URLs
  'values',
  'to',
])

const DANGEROUS_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:text/html',
  'data:application/xhtml+xml',
  'data:text/xml',
  'data:image/svg+xml',
]

/**
 * Strips ASCII 0-32 (whitespace & control characters) to prevent scheme evasion
 * without triggering ESLint's no-control-regex rule.
 */
const normalizeUrl = (raw: string): string => {
  let cleaned = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 32) {
      cleaned += raw[i]
    }
  }
  return cleaned.toLowerCase()
}

/**
 * Recursively collects all elements, traversing through nested <template> fragments.
 */
const collectAllElements = (root: Element | DocumentFragment): Element[] => {
  const elements: Element[] = []
  const queue: (Element | DocumentFragment)[] = [root]

  while (queue.length > 0) {
    const current = queue.pop()!
    if (current instanceof Element) {
      elements.push(current)
    }

    const descendants = current.querySelectorAll('*')
    for (let i = 0; i < descendants.length; i++) {
      const el = descendants[i]!
      elements.push(el)

      // Traverse nested <template> DocumentFragments to prevent blind-spot bypasses
      if (el instanceof HTMLTemplateElement) {
        queue.push(el.content)
      }
    }
  }

  return elements
}

export const detectXssVectors: DetectXssViolations = (root) => {
  const target = root instanceof HTMLTemplateElement ? root.content : root
  const elements = collectAllElements(target)
  const violations: XssViolation[] = []

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!
    const tagName = el.tagName.toLowerCase()

    // 1. Disallow script execution, base hijacking, and active SVG animations
    if (tagName === 'script' || tagName === 'base') {
      violations.push({
        element: (el.cloneNode(false) as Element).outerHTML,
        reason: `Disallowed tag: <${tagName}>`,
      })
      continue
    }

    // 2. Scan attributes
    for (let j = 0; j < el.attributes.length; j++) {
      const attr = el.attributes[j]!
      const name = attr.name.toLowerCase()

      // Block native inline event attributes (e.g., onclick, onerror)
      // Preserves inert custom attributes (e.g., on-click, on:change)
      if (/^on[a-z]/.test(name)) {
        violations.push({
          element: (el.cloneNode(false) as Element).outerHTML,
          reason: `Disallowed native event attribute: "${attr.name}"`,
        })
        break
      }

      // Block inline iframe document injection
      if (name === 'srcdoc') {
        violations.push({
          element: (el.cloneNode(false) as Element).outerHTML,
          reason: 'Disallowed attribute: "srcdoc"',
        })
        break
      }

      // Block dangerous URL schemes
      if (URL_ATTRS.has(name) || name.endsWith(':href')) {
        const normalizedValue = normalizeUrl(attr.value)
        const matchedScheme = DANGEROUS_SCHEMES.find((scheme) => normalizedValue.startsWith(scheme))

        if (matchedScheme) {
          violations.push({
            element: (el.cloneNode(false) as Element).outerHTML,
            reason: `Dangerous scheme "${matchedScheme}" detected in attribute "${attr.name}"`,
          })
          break
        }
      }
    }
  }

  return violations
}

/**
 * Reports whether a `b-trigger` value is malformed.
 *
 * A value is valid only when it is a non-empty string of semicolon-separated
 * `event:action` pairs, each with a non-empty key and value after trimming,
 * and no duplicate keys. Returns `true` **only** for invalid values: non-string
 * input, no declarations, a declaration without a `:`, an empty key or value,
 * or a duplicate key.
 *
 * Kept local (not derived from the html.schemas.ts data) so the browser
 * controller bundle pulls in no ajv/css-tree.
 */
export const isInvalidTrigger = (data: unknown): boolean => {
  if (!isTypeOf<string>(data, 'string')) return true
  const declarations = data.split(';').filter(Boolean)
  if (!declarations.length) return true
  const seen = new Set<string>()
  for (const decl of declarations) {
    const colonIndex = decl.indexOf(':')
    if (colonIndex === -1) return true
    const key = decl.slice(0, colonIndex).trim()
    const value = decl.slice(colonIndex + 1).trim()
    if (!key || !value) return true
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}
