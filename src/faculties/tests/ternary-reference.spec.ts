import { describe, expect, test } from 'bun:test'
import { dequantMatmul, dequantMatvec, type Lut2Weights, packLut2Group } from '../ternary.ts'

describe('dequantMatvec — the CPU reference the GPU kernel agreement pins against', () => {
  const group = (trits: Int8Array, scale: number): { data: Uint32Array; scale: number } => {
    const packed = packLut2Group(trits)
    return { data: packed.data, scale }
  }

  test('one row, one group: y = Σ trit·scale·x — a hand-computed case', () => {
    // 64 trits of −1 then 64 of +1, scale 0.5, x = 2 everywhere → y = 0
    const trits = new Int8Array(128)
    for (let i = 0; i < 64; i++) trits[i] = -1
    for (let i = 64; i < 128; i++) trits[i] = 1
    const g = group(trits, 0.5)
    const w: Lut2Weights = {
      rows: 1,
      cols: 128,
      data: g.data,
      scales: Float32Array.from([g.scale]),
    }
    const x = Float32Array.from({ length: 128 }, () => 2)
    const y = dequantMatvec(w, x)
    expect(y.length).toBe(1)
    expect(y[0]).toBe(0)
  })

  test('two rows with different scales read their own group scale', () => {
    const trits = new Int8Array(128)
    trits[0] = 1 // element 0 → word 0 shift 0 → value 2
    const a = group(trits, 3)
    const b = group(trits, 7)
    const data = new Uint32Array(16)
    data.set(a.data, 0)
    data.set(b.data, 8)
    const w: Lut2Weights = {
      rows: 2,
      cols: 128,
      data,
      scales: Float32Array.from([3, 7]),
    }
    const x = Float32Array.from({ length: 128 }, (_, i) => (i === 0 ? 10 : 0))
    const y = dequantMatvec(w, x)
    expect(y[0]).toBeCloseTo(30, 5) // 1 · 3 · 10
    expect(y[1]).toBeCloseTo(70, 5) // 1 · 7 · 10
  })

  test('a column past the first group reads the second group word', () => {
    const trits = new Int8Array(128).fill(0)
    trits[127] = 1 // last element of group 0 → word 7, shift 30
    const trits2 = new Int8Array(128).fill(0)
    trits2[0] = -1
    const g0 = group(trits, 1)
    const g1 = group(trits2, 2)
    const data = new Uint32Array(16)
    data.set(g0.data, 0)
    data.set(g1.data, 8)
    const w: Lut2Weights = {
      rows: 1,
      cols: 256,
      data,
      scales: Float32Array.from([1, 2]),
    }
    const x = Float32Array.from({ length: 256 }, (_, i) => (i === 127 || i === 128 ? 1 : 0))
    const y = dequantMatvec(w, x)
    expect(y[0]).toBeCloseTo(1 * 1 * 1 + -1 * 2 * 1, 5) // +1·1·x[127] + (−1)·2·x[128]
  })
})

describe('dequantMatmul — the batch (prefill) reference: Y[B,N] = X[B,K]·Wᵀ', () => {
  test('two tokens against a one-row matrix: each token y lands in its slot', () => {
    const trits = new Int8Array(128)
    trits[0] = 1 // word 0, shift 0, value 2
    trits[1] = -1
    const g = packLut2Group(trits)
    const w: Lut2Weights = { rows: 1, cols: 128, data: g.data, scales: Float32Array.from([2]) }
    // x: token 0 puts 10 at col 0; token 1 puts 5 at col 0
    const x = new Float32Array(2 * 128)
    x[0] = 10
    x[128] = 5
    const y = dequantMatmul(w, x, 2)
    expect(y.length).toBe(2) // rows × B
    expect(y[0]).toBeCloseTo(1 * 2 * 10, 5)
    expect(y[1]).toBeCloseTo(1 * 2 * 5, 5)
  })

  test('a matmul with B=1 matches dequantMatvec exactly', () => {
    const trits = new Int8Array(128)
    for (let i = 0; i < 128; i++) trits[i] = ((i * 5) % 3) - 1
    const w: Lut2Weights = { rows: 3, cols: 128, data: new Uint32Array(24), scales: Float32Array.from([1.5, 2.5, 3.5]) }
    for (let r = 0; r < 3; r++) w.data.set(packLut2Group(trits).data, r * 8)
    const rand = (() => {
      let a = 99 >>> 0
      return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    })()
    const x = Float32Array.from({ length: 128 }, () => rand() * 2 - 1)
    const v = dequantMatvec(w, x)
    const m = dequantMatmul(w, x, 1)
    for (let r = 0; r < 3; r++) expect(m[r]).toBe(v[r])
  })
})
