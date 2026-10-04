import { describe, expect, test } from 'bun:test'
import { CONTROLLER_DETAIL_SCHEMAS, validateControllerDetail } from '../controller.schemas.ts'

/** [type, valid detail, invalid detail] — the lockstep sample per message kind. */
const samples: Array<[string, unknown, unknown]> = [
  [
    'ui_render',
    { id: 'r1', target: 'main', html: '<p>x</p>', swap: 'innerHTML' },
    { id: 'r1', target: 'main', swap: 'innerHTML' },
  ],
  ['ui_attrs', { id: 'a1', target: 'main', attr: { class: 'x', hidden: true } }, { id: 'a1', target: 'main', attr: 5 }],
  ['ui_navigate', { id: 'n1', url: '/x' }, { id: 'n1' }],
  [
    'ui_dispatch_custom_event',
    { id: 'd1', target: 'main', event: { type: 'app:ping' } },
    { id: 'd1', target: 'main', event: {} },
  ],
  ['ui_scale_check', { id: 's1', target: 'slot', swap: 'outerHTML' }, { id: 's1', target: 'slot', swap: 'nope' }],
  ['ui_event', { event: { type: 'click' }, timeStamp: 1 }, { timeStamp: 1 }],
  ['ui_form_submit', { timeStamp: 1, action: '/x', data: { a: 'b' } }, {}],
  [
    'ui_snapshot',
    { timeStamp: 1, type: 'pagehide', serializedHTML: '<html>' },
    { timeStamp: 1, type: 'nope', serializedHTML: '' },
  ],
  ['ui_success', { id: 'x1', timeStamp: 1 }, { id: 'x1' }],
  ['ui_error', { timeStamp: 1, name: 'ElementNotFoundError' }, { timeStamp: 1 }],
  [
    'ui_scale_check_result',
    { id: 's1', target: 'slot', effectiveScale: 's3', timeStamp: 1 },
    { id: 's1', target: 'slot', effectiveScale: 'nope', timeStamp: 1 },
  ],
]

describe('the target constraint — the selector sites slug floor', () => {
  // Targets are b-target attribute VALUES feeding querySelectorAll in
  // #render/#attrs/#scaleCheck — the slug charset, pattern-constrained in
  // the detail schemas (the one pattern const home; the match nuance rides
  // the OPERATOR, never the target).
  const badTargets = ['main > div', 'a b', '[id=x]', 'main"div', '.cls', 'body; td', '']
  for (const [type, valid] of [
    ['ui_render', { id: 'r1', target: 'side-panel_2', html: '<p>x</p>', swap: 'innerHTML' }],
    ['ui_attrs', { id: 'a1', target: 'side-panel_2', attr: {} }],
    ['ui_scale_check', { id: 's1', target: 'side-panel_2', swap: 'innerHTML' }],
  ] as Array<[string, unknown]>) {
    test(`${type}: slug-ish targets accepted, selector-syntax targets rejected`, () => {
      expect(validateControllerDetail(type, valid)).toBe(true)
      for (const bad of badTargets) {
        expect(validateControllerDetail(type, { ...(valid as { id: string }), target: bad })).toBe(false)
      }
    })
  }
})

describe('controller detail schemas', () => {
  test('every controller message kind has a detail schema', () => {
    expect(Object.keys(CONTROLLER_DETAIL_SCHEMAS).sort()).toEqual([
      'ui_attrs',
      'ui_dispatch_custom_event',
      'ui_error',
      'ui_event',
      'ui_form_submit',
      'ui_navigate',
      'ui_render',
      'ui_scale_check',
      'ui_scale_check_result',
      'ui_snapshot',
      'ui_success',
    ])
  })

  for (const [type, valid, invalid] of samples) {
    test(`${type}: accepts well-formed, rejects malformed`, () => {
      expect(validateControllerDetail(type, valid)).toBe(true)
      expect(validateControllerDetail(type, invalid)).toBe(false)
    })
  }

  test('an unknown type is rejected', () => {
    expect(validateControllerDetail('ui_nope', {})).toBe(false)
  })
})
