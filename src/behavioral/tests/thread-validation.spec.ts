import { describe, expect, test } from 'bun:test'
import { validateThread } from '../behavioral.types.ts'

const onType = (type: string) => ({ type })

describe('validateThread — idiom combinations', () => {
  // ── single-idiom threads ─────────────────────────────────────────────────

  test('request only', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { type: 'a' } }] })).toBe(true)
  })

  test('waitFor only', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ waitFor: [onType('a')] }] })).toBe(true)
  })

  test('block only', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ block: [onType('a')] }] })).toBe(true)
  })

  test('interrupt only', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ interrupt: [onType('a')] }] })).toBe(true)
  })

  test('transform only', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ transform: [{ type: 'a', query: '.', target: 'b' }] }],
      }),
    ).toBe(true)
  })

  // ── multi-idiom sync points ──────────────────────────────────────────────

  test('request + waitFor in same sync point', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ request: { type: 'a' }, waitFor: [onType('b')] }],
      }),
    ).toBe(true)
  })

  test('waitFor + block (guard pattern)', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [onType('a')], block: [onType('b')] }],
      }),
    ).toBe(true)
  })

  test('request + block (request blocked by same thread)', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ request: { type: 'a' }, block: [onType('a')] }],
      }),
    ).toBe(true)
  })

  test('waitFor + interrupt (interruptible waiter)', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [onType('a')], interrupt: [onType('kill')] }],
      }),
    ).toBe(true)
  })

  test('transform + waitFor in same sync point', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ transform: [{ type: 'a', query: '.', target: 'b' }], waitFor: [onType('c')] }],
      }),
    ).toBe(true)
  })

  test('all five idioms in one sync point', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            request: { type: 'req' },
            waitFor: [onType('wait')],
            block: [onType('blk')],
            interrupt: [onType('kill')],
            transform: [{ type: 'tr', query: '.', target: 'out' }],
          },
        ],
      }),
    ).toBe(true)
  })

  // ── multi-rule threads (sequence) ────────────────────────────────────────

  test('sequential sync points (waitFor then request)', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [onType('start')] }, { request: { type: 'done' } }],
        once: true,
      }),
    ).toBe(true)
  })

  test('alternating waitFor/request across multiple rules', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          { waitFor: [onType('a')] },
          { request: { type: 'b' } },
          { waitFor: [onType('c')] },
          { request: { type: 'd' } },
        ],
        once: true,
      }),
    ).toBe(true)
  })

  test('transform mid-sequence', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          { waitFor: [onType('input')] },
          { transform: [{ type: 'input', query: '.value', target: 'output' }] },
          { request: { type: 'output' } },
        ],
        once: true,
      }),
    ).toBe(true)
  })

  // ── listeners with detailSchema ─────────────────────────────────────────

  test('waitFor with detailSchema', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            waitFor: [
              { type: 'a', detailSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  test('block with detailSchema', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            block: [
              { type: 'a', detailSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  test('transform with detailSchema', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            transform: [
              {
                type: 'a',
                query: '.id',
                target: 'b',
                detailSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  // ── detailMatch variants ────────────────────────────────────────────────

  test('detailMatch: true', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            waitFor: [
              {
                type: 'a',
                detailSchema: { type: 'object', properties: { n: { type: 'number' } } },
                detailMatch: true,
              },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  test('detailMatch: false', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            waitFor: [
              {
                type: 'a',
                detailSchema: { type: 'object', properties: { n: { type: 'number' } } },
                detailMatch: false,
              },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  test('detailMatch: null rejected', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', detailMatch: null }] }],
      }),
    ).toBe(false)
  })

  test("detailMatch: 'valid' rejected (closed vocabulary)", () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', detailMatch: 'valid' }] }],
      }),
    ).toBe(false)
  })

  test("detailMatch: 'invalid' rejected (closed vocabulary)", () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', detailMatch: 'invalid' }] }],
      }),
    ).toBe(false)
  })

  // ── ingress channel flag ────────────────────────────────────────────────

  test('waitFor with ingressMatch: true', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', ingressMatch: true }] }],
      }),
    ).toBe(true)
  })

  test('waitFor with ingressMatch: false', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', ingressMatch: false }] }],
      }),
    ).toBe(true)
  })

  test('waitFor without ingress still valid (backward compat)', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ waitFor: [onType('a')] }] })).toBe(true)
  })

  test('block with ingressMatch: true', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ block: [{ type: 'a', ingressMatch: true }] }],
      }),
    ).toBe(true)
  })

  test('transform with ingressMatch: false', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ transform: [{ type: 'a', query: '.', target: 'b', ingressMatch: false }] }],
      }),
    ).toBe(true)
  })

  test('ingressMatch: null rejected', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', ingressMatch: null }] }],
      }),
    ).toBe(false)
  })

  test('non-boolean ingressMatch rejected', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', ingressMatch: 'yes' }] }],
      }),
    ).toBe(false)
  })

  test('listener field ingress rejected (renamed to ingressMatch)', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ waitFor: [{ type: 'a', ingress: true }] }] }),
    ).toBe(false)
  })

  // ── multiple listeners per idiom ────────────────────────────────────────

  test('multiple waitFor listeners', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [onType('a'), onType('b'), onType('c')] }],
      }),
    ).toBe(true)
  })

  test('multiple transform listeners with different targets', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [
          {
            transform: [
              { type: 'a', query: '.x', target: 'b' },
              { type: 'a', query: '.y', target: 'c' },
              { type: 'a', query: '.z', target: 'd' },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  // ── space stamping ──────────────────────────────────────────────────────

  test('threads with space are valid (space stamped at registration)', () => {
    // space is added by generateRulesFunctions, not by the author
    // so the author-facing Thread type doesn't include it
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { type: 'a' } }] })).toBe(true)
  })

  // ── once flag ───────────────────────────────────────────────────────────

  test('once: true completes after one pass', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: true }),
    ).toBe(true)
  })

  test('once omitted loops indefinitely', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { type: 'a' } }] })).toBe(true)
  })

  // ── invalid combinations ────────────────────────────────────────────────

  test('empty rules array', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [] })).toBe(true)
  })

  test('empty name rejected', () => {
    expect(validateThread({ name: '', description: 'Test thread.', rules: [{ request: { type: 'a' } }] })).toBe(false)
  })

  test('missing name rejected', () => {
    expect(validateThread({ description: 'Test thread.', rules: [{ request: { type: 'a' } }] })).toBe(false)
  })

  test('missing rules rejected', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.' })).toBe(false)
  })

  test('empty waitFor array rejected (minItems)', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ waitFor: [] }] })).toBe(false)
  })

  test('empty transform array rejected (minItems)', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ transform: [] }] })).toBe(false)
  })

  test('transform missing query rejected', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ transform: [{ type: 'a', target: 'b' }] }] }),
    ).toBe(false)
  })

  test('transform missing target rejected', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ transform: [{ type: 'a', query: '.' }] }] }),
    ).toBe(false)
  })

  test('request missing type rejected', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { detail: { x: 1 } } }] })).toBe(
      false,
    )
  })

  test('listener missing type rejected', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ detailSchema: { type: 'object' } }] }],
      }),
    ).toBe(false)
  })

  test('additional properties rejected', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { type: 'a' } }], bogus: true }),
    ).toBe(false)
  })

  test('once: false rejected (only true or omitted)', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ request: { type: 'a' } }], once: false }),
    ).toBe(false)
  })

  test('rules not an array rejected', () => {
    expect(validateThread({ name: 'x', description: 'Test thread.', rules: 'not-an-array' })).toBe(false)
  })

  test('listener with unknown properties rejected', () => {
    expect(
      validateThread({ name: 'x', description: 'Test thread.', rules: [{ waitFor: [{ type: 'a', bogus: 'value' }] }] }),
    ).toBe(false)
  })

  test('detailSchema with invalid type keyword rejected', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', detailSchema: { type: 'object', properties: { age: { type: 'text' } } } }] }],
      }),
    ).toBe(false)
  })

  test('detailSchema without keywords rejected', () => {
    expect(
      validateThread({
        name: 'x',
        description: 'Test thread.',
        rules: [{ waitFor: [{ type: 'a', detailSchema: { foo: 'bar' } }] }],
      }),
    ).toBe(false)
  })
})
