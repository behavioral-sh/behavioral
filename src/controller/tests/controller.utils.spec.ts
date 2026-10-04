import { describe, expect, test } from 'bun:test'
import { SWAP_MODES, SWAP_TARGETS } from '../controller.constants.ts'
import { DelegatedListener, isInvalidTrigger, isOnStarAttribute, swapBoundary } from '../controller.utils.ts'

describe('swapBoundary — into modes return self', () => {
  test('afterbegin, beforeend, innerHTML are self boundaries', () => {
    expect(swapBoundary(SWAP_MODES.afterbegin)).toBe(SWAP_TARGETS.self)
    expect(swapBoundary(SWAP_MODES.beforeend)).toBe(SWAP_TARGETS.self)
    expect(swapBoundary(SWAP_MODES.innerHTML)).toBe(SWAP_TARGETS.self)
  })
})

describe('swapBoundary — replace/beside modes return parent', () => {
  test('beforebegin, afterend, outerHTML are parent boundaries', () => {
    expect(swapBoundary(SWAP_MODES.beforebegin)).toBe(SWAP_TARGETS.parent)
    expect(swapBoundary(SWAP_MODES.afterend)).toBe(SWAP_TARGETS.parent)
    expect(swapBoundary(SWAP_MODES.outerHTML)).toBe(SWAP_TARGETS.parent)
  })
})

const delegates = new WeakMap<EventTarget, DelegatedListener>()

describe('DelegatedListener', () => {
  test('handleEvent calls callback with the event', () => {
    const events: Event[] = []
    const listener = new DelegatedListener((ev: Event) => {
      events.push(ev)
    })
    const event = new Event('click')
    listener.handleEvent(event)
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(event)
  })

  test('handleEvent handles async callback (void coalesced)', () => {
    const listener = new DelegatedListener(async (_ev: Event) => {
      await Promise.resolve()
    })
    // Should not throw — the async return is void-coalesced by handleEvent
    expect(() => listener.handleEvent(new Event('click'))).not.toThrow()
  })

  test('callback property is assignable and readable', () => {
    const cb1 = (_ev: Event) => {}
    const cb2 = (_ev: Event) => {}
    const listener = new DelegatedListener(cb1)
    expect(listener.callback).toBe(cb1)
    listener.callback = cb2
    expect(listener.callback).toBe(cb2)
  })
})

describe('delegates WeakMap', () => {
  test('stores and retrieves by EventTarget key', () => {
    const target = new EventTarget()
    const listener = new DelegatedListener(() => {})
    delegates.set(target, listener)
    expect(delegates.get(target)).toBe(listener)
  })

  test('returns undefined for unset targets', () => {
    const target = new EventTarget()
    expect(delegates.get(target)).toBeUndefined()
  })
})

describe('isInvalidTrigger — accepted declarations', () => {
  test('a single event:action pair is valid', () => {
    expect(isInvalidTrigger('click:do_thing')).toBe(false)
  })

  test('semicolon-separated pairs with surrounding whitespace are valid', () => {
    expect(isInvalidTrigger('click:a; change:b')).toBe(false)
  })

  test('a trailing or duplicated separator is tolerated', () => {
    expect(isInvalidTrigger('click:a;')).toBe(false)
    expect(isInvalidTrigger('click:a;;')).toBe(false)
  })
})

describe('isOnStarAttribute — the attrs lane handler-attribute floor', () => {
  test('on* KEYS are rejected: event-handler attributes compile live handlers', () => {
    expect(isOnStarAttribute('onclick')).toBe(true)
    expect(isOnStarAttribute('onerror')).toBe(true)
    expect(isOnStarAttribute('onmouseover')).toBe(true)
    expect(isOnStarAttribute('OnClick')).toBe(true)
    expect(isOnStarAttribute('onload')).toBe(true)
  })

  test('innocent attribute keys pass — including names that merely contain on', () => {
    expect(isOnStarAttribute('style')).toBe(false)
    expect(isOnStarAttribute('class')).toBe(false)
    expect(isOnStarAttribute('data-on-click')).toBe(false)
    expect(isOnStarAttribute('font')).toBe(false)
  })

  test('the ruling regex is PREFIX-form — an innocent key that starts with on over-flags (the conservative fail-safe)', () => {
    expect(isOnStarAttribute('once')).toBe(true)
  })

  test('non-string keys are rejected', () => {
    expect(isOnStarAttribute(undefined)).toBe(true)
    expect(isOnStarAttribute(42 as unknown as string)).toBe(true)
  })
})

describe('isInvalidTrigger — rejected values', () => {
  test('empty and non-string values are invalid', () => {
    expect(isInvalidTrigger('')).toBe(true)
    expect(isInvalidTrigger('   ')).toBe(true)
    expect(isInvalidTrigger(null)).toBe(true)
    expect(isInvalidTrigger(42)).toBe(true)
    expect(isInvalidTrigger(['click:a'])).toBe(true)
  })

  test('a declaration without a colon is invalid', () => {
    expect(isInvalidTrigger('click')).toBe(true)
  })

  test('an empty key or empty value is invalid', () => {
    expect(isInvalidTrigger(':foo')).toBe(true)
    expect(isInvalidTrigger('click:')).toBe(true)
  })

  test('duplicate keys are invalid', () => {
    expect(isInvalidTrigger('click:a;click:b')).toBe(true)
  })

  test('one malformed declaration invalidates the whole value', () => {
    expect(isInvalidTrigger('nocolon;click:a')).toBe(true)
  })

  test('a separator-only value is invalid', () => {
    expect(isInvalidTrigger(';')).toBe(true)
  })
})
