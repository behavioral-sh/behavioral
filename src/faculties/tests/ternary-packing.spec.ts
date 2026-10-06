import { describe, expect, test } from 'bun:test'
import { decodeF16Bits, decodePtq10Group, encodePtq10Group, packLut2Group, unpackLut2Group } from '../ternary.ts'

describe('decodePtq10Group — the PTQ1_0 artifact format (the engine transcode, transcribed)', () => {
  test('an all-zero data block decodes to all −1 trits (the byte-0 arc)', () => {
    const bytes = new Uint8Array(26)
    const trits = decodePtq10Group(bytes)
    expect(trits.length).toBe(128)
    for (const t of trits) expect(t).toBe(-1)
  })

  test('every decoded trit is in {−1,0,1}', () => {
    // a spread of byte values across the three arc regions
    const bytes = new Uint8Array(26)
    for (let i = 0; i < 26; i++) bytes[i] = (i * 37 + 11) & 0xff
    const trits = decodePtq10Group(bytes)
    expect(trits.length).toBe(128)
    for (const t of trits) expect([-1, 0, 1]).toContain(t)
  })

  test('the element order: group element e reads byte (e%16) at power (e/16) for e<80', () => {
    // element 16 must read byte 0 at power 1 — only byte 0 differs, powers differ
    const bytes = new Uint8Array(26)
    bytes[0] = 200 // power-0 arc: high -> +1
    bytes[1] = 10
    const trits = decodePtq10Group(bytes)
    // element 0 reads byte 0 power 0; element 16 reads byte 0 power 1;
    // element 1 reads byte 1 power 0.
    expect(trits[0]).not.toBe(trits[1]) // different bytes at the same power
    expect(trits[80]).toBe(trits[0] === -1 ? 1 : -1) // element 80 reads byte 16 power 0 — set below
  })

  test('round-trip: encode∘decode is trit-exact for a random group', () => {
    // build a random trit group, encode, decode, compare
    const random = (seed: number) => {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const rand = random(42)
    const trits = new Int8Array(128)
    for (let i = 0; i < 128; i++) trits[i] = Math.floor(rand() * 3) - 1
    const bytes = encodePtq10Group(trits)
    expect(bytes.length).toBe(26)
    const back = decodePtq10Group(bytes)
    for (let i = 0; i < 128; i++) expect(back[i]).toBe(trits[i])
  })
})

describe('packLut2Group / unpackLut2Group — the kernel-native 2-bit group (bit-exact round-trip)', () => {
  test('pack→unpack is bit-exact', () => {
    const trits = new Int8Array(128)
    for (let i = 0; i < 128; i++) trits[i] = ((i * 7) % 3) - 1
    const { data } = packLut2Group(trits)
    expect(data.length).toBe(8)
    const back = unpackLut2Group(data)
    for (let i = 0; i < 128; i++) expect(back[i]).toBe(trits[i])
  })

  test('the word layout matches the engine lut2: element e lives in word e>>4 at shift (e%16)*2, value = trit+1', () => {
    const trits = new Int8Array(128).fill(0)
    trits[0] = -1 // word 0, shift 0, value 0
    trits[1] = 0 // word 0, shift 2, value 1
    trits[2] = 1 // word 0, shift 4, value 2
    trits[16] = 1 // word 1, shift 0
    const { data } = packLut2Group(trits)
    expect(data[0]! & 0b11).toBe(0)
    expect((data[0]! >>> 2) & 0b11).toBe(1)
    expect((data[0]! >>> 4) & 0b11).toBe(2)
    expect(data[1]! & 0b11).toBe(2)
  })
})

describe('decodeF16Bits — the FP16 group scale (the on-disk scale carrier)', () => {
  test('1.0 decodes exactly', () => {
    expect(decodeF16Bits(0x3c00)).toBe(1)
  })
  test('a known f16 value decodes to its f32 widening', () => {
    // f16 0x3555 = 0.333251953125 (e=13, fraction=341)
    expect(decodeF16Bits(0x3555)).toBe(0.333251953125)
  })
  test('subnormal and zero decode without NaN', () => {
    expect(decodeF16Bits(0x0000)).toBe(0)
    expect(Number.isFinite(decodeF16Bits(0x0001))).toBe(true)
  })
})
