import { expect, test } from 'bun:test'
import { hashString } from '../../utils.ts'

test('hashString(): canonical masked djb2 — the known short vector', () => {
  expect(hashString('test')).toBe(2090756197)
})

test('hashString(): masked 32-bit accumulator — long inputs match textbook djb2 (cross-language reproducibility)', () => {
  // f64 arithmetic would drop low bits past ~50 chars; the mask per step is
  // what keeps the vector reproducible by the Blackwell-side Python tooling.
  expect(hashString('/var/folders/wj/jbsdm_gd3199wvstlz40z9gc0000gn/T/bprogram-plugin-sIXqHx/t.ts')).toBe(3328524204)
  expect(hashString('a'.repeat(100))).toBe(4215223337)
})

test('hashString(): stable and injective enough for provenance joins', () => {
  expect(hashString('/plugins/a')).toBe(hashString('/plugins/a'))
  expect(hashString('/plugins/a')).not.toBe(hashString('/plugins/b'))
})

test('hashString(): returns a number for every string — the caller owns non-empty validation', () => {
  expect(typeof hashString('')).toBe('number')
  expect(hashString('')).toBe(5381)
})
