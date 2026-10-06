import { describe, expect, test } from 'bun:test'
import { type BenchRow, fixedTokenIds, summarizeBenchRows, validateBenchRow } from '../ternary.ts'

describe('fixedTokenIds — the bench harness fixed input sets', () => {
  test('same seed, length, vocab produce the identical id sequence', () => {
    const a = fixedTokenIds({ seed: 7, length: 32, vocab: 100_000 })
    const b = fixedTokenIds({ seed: 7, length: 32, vocab: 100_000 })
    expect(a).toEqual(b)
  })

  test('different seeds produce different sequences', () => {
    const a = fixedTokenIds({ seed: 7, length: 32, vocab: 100_000 })
    const b = fixedTokenIds({ seed: 8, length: 32, vocab: 100_000 })
    expect(a).not.toEqual(b)
  })

  test('every id is inside [0, vocab) and the sequence has the requested length', () => {
    const ids = fixedTokenIds({ seed: 3, length: 512, vocab: 100_000 })
    expect(ids.length).toBe(512)
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(100_000)
    }
  })
})

describe('summarizeBenchRows — the capture rows aggregate to the comparison summary', () => {
  const row = (over: Partial<BenchRow>): BenchRow => ({
    kind: 'kernel_bench_row',
    run: 'stock-f16',
    model: 'Ternary-Bonsai-2-27B-PTQ1_0',
    kernel: 'stock-engine',
    profile: 'batch-matmul',
    inputLength: 512,
    outputTokens: 0,
    wallMs: 100,
    tokPerSec: null,
    repeat: 0,
    ...over,
  })

  test('rows group by (kernel, profile, inputLength) with median/mean/p90 wall', () => {
    const summary = summarizeBenchRows({
      generatedAt: '2026-10-06T00:00:00Z',
      model: 'Ternary-Bonsai-2-27B-PTQ1_0',
      device: { vendor: 'apple' },
      rows: [
        row({ inputLength: 512, wallMs: 700, repeat: 0 }),
        row({ inputLength: 512, wallMs: 710, repeat: 1 }),
        row({ inputLength: 512, wallMs: 3000, repeat: 2 }),
        row({ profile: 'matvec', inputLength: 512, outputTokens: 127, wallMs: 7400, tokPerSec: 17.1, repeat: 0 }),
      ],
    })
    expect(summary.rows).toBe(4)
    expect(summary.groups).toHaveLength(2)
    const prefill = summary.groups.find((g) => g.profile === 'batch-matmul')!
    expect(prefill.kernel).toBe('stock-engine')
    expect(prefill.runs).toBe(3)
    expect(prefill.wallMs.median).toBe(710)
    expect(prefill.wallMs.p90).toBe(3000)
    // the derived rate rides the median wall row: 512 tokens / 710 ms
    expect(prefill.tokPerSec).toBeCloseTo(721.13, 1)
    const decode = summary.groups.find((g) => g.profile === 'matvec')!
    expect(decode.tokPerSec).toBe(17.1)
  })

  test('rows carry derived tokPerSec as inputLength/wall when the runner did not supply one', () => {
    const summary = summarizeBenchRows({
      generatedAt: '2026-10-06T00:00:00Z',
      model: 'Ternary-Bonsai-2-27B-PTQ1_0',
      device: {},
      rows: [row({ inputLength: 2048, wallMs: 10240, tokPerSec: null })],
    })
    expect(summary.groups[0]!.tokPerSec).toBeCloseTo(200, 5)
  })
})

describe('validateBenchRow — the capture boundary (CDP + file) contract', () => {
  const row: BenchRow = {
    kind: 'kernel_bench_row',
    run: 'stock-f16',
    model: 'Ternary-Bonsai-2-27B-PTQ1_0',
    kernel: 'stock-engine',
    profile: 'matvec',
    inputLength: 512,
    outputTokens: 127,
    wallMs: 7400,
    tokPerSec: 17.1,
    repeat: 0,
  }

  test('a well-formed row validates', () => {
    expect(validateBenchRow(row)).toBe(true)
  })

  test('a malformed row is rejected — unknown profile and missing wallMs', () => {
    const bad = { ...row, profile: 'decode', wallMs: undefined } as unknown as Record<string, unknown>
    expect(validateBenchRow(bad)).toBe(false)
  })

  test('an extra unlisted field is rejected (additionalProperties false)', () => {
    const bad = { ...row, surprise: 1 } as unknown as Record<string, unknown>
    expect(validateBenchRow(bad)).toBe(false)
  })
})
