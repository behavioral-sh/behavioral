/**
 * The ternary packing home — the ONE format module for the kernel track.
 * Two formats live here:
 *
 * 1. PTQ1_0 — the OFF-THE-SHELF artifact's on-disk group format (the verified
 *    27B PTQ1_0 GGUF). Transcribed format-exactly from the engine's baked
 *    transcode WGSL (`prism_ptq1_0_to_lut2` in the extracted engine source):
 *    one 28-byte unit per 128 weights — 26 data bytes + one FP16 group scale.
 *    The element decode reads byte (e%16) at 3-power (e/16) for e<80, byte
 *    16+(e-80)%8 at 3-power floor((e-80)/8) for 80≤e<120, byte 24+(e-120)%2
 *    at 3-power floor((e-120)/2) for e≥120; the trit is
 *    floor(3·((byte·3^p) mod 256)/256)−1 (the mod-256 arc code — verified
 *    surjective onto all 243 trit 5-tuples; 13 byte values double-encode, so
 *    the ENCODER's byte choice is canonical, not unique).
 * 2. LUT2 — the kernel-native in-memory group: 2 bits/weight, 16 weights per
 *    uint32, one f32 group scale — the layout the WGSL dequant-matmul consumes
 *    (value = trit+1, element e in word e>>4 at shift (e%16)·2 — the same
 *    word layout the engine's internal lut2 uses, so the engine's transcode
 *    output and this module's packs agree element-for-element).
 *
 * The conversion prompt's writer side imports THIS module — one format home,
 * both sides agree by construction (its slice-0 gate verifies the on-disk
 * basis against the contract).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// PTQ1_0 — the artifact's on-disk group format
// ---------------------------------------------------------------------------

export const PTQ10_GROUP_WEIGHTS = 128
/** 26 data bytes + 2 FP16 scale bytes per 128-weight group. */
export const PTQ10_GROUP_BYTES = 28
export const PTQ10_DATA_BYTES = 26

const POW3 = [1, 3, 9, 27, 81] as const

/**
 * The element→(byte, 3-power) map for one 128-weight group, straight from the
 * transcode WGSL's srcE branches.
 */
const elementByteAndPower = (element: number): { byte: number; power: number } => {
  if (element >= 120) return { byte: 24 + ((element - 120) % 2), power: Math.floor((element - 120) / 2) }
  if (element >= 80) return { byte: 16 + ((element - 80) % 8), power: Math.floor((element - 80) / 8) }
  return { byte: element % 16, power: Math.floor(element / 16) }
}

/**
 * Decode one PTQ1_0 group's 26 data bytes into 128 ternary weights (the
 * caller applies the FP16 group scale separately).
 */
export const decodePtq10Group = (bytes: Uint8Array, offset = 0): Int8Array => {
  const trits = new Int8Array(PTQ10_GROUP_WEIGHTS)
  for (let element = 0; element < PTQ10_GROUP_WEIGHTS; element++) {
    const { byte, power } = elementByteAndPower(element)
    const q = (bytes[offset + byte]! * POW3[power]!) & 255
    trits[element] = Math.floor((q * 3) / 256) - 1
  }
  return trits
}

// The arc decoder per (byte, power) is surjective onto all 243 trit 5-tuples,
// so the encoder is a lookup: for each byte value, its decoded 5-tuple.
const PTQ10_ARC = (() => {
  const tuples: number[][] = []
  for (let b = 0; b < 256; b++) {
    const t: number[] = []
    for (let p = 0; p < 5; p++) t.push(Math.floor((((b * POW3[p]!) & 255) * 3) / 256) - 1)
    tuples.push(t)
  }
  return tuples
})()

/** Canonical byte for a full 5-tuple ({-1,0,1}) — first (lowest) byte wins. */
const ptq10ByteForTuple = (t: number[]): number => {
  for (let b = 0; b < 256; b++) {
    const cand = PTQ10_ARC[b]!
    let ok = true
    for (let p = 0; p < t.length; p++) {
      if (cand[p] !== t[p]) {
        ok = false
        break
      }
    }
    if (ok) return b
  }
  throw new Error(`no PTQ1_0 byte encodes the trit tuple [${t.join(',')}]`)
}

/**
 * Encode 128 ternary weights into one PTQ1_0 group's 26 data bytes (the scale
 * is the caller's concern — the artifact stores it as the trailing FP16).
 * The last two bytes' fifth trit is unconstrained by the decoder; the
 * canonical encoding pins it to −1. CANONICAL: 13 trit 5-tuples double-encode;
 * byte-exact parity with an external writer's choice is a conversion-gate
 * check, not an invariant of this module (the reader side is exact either way).
 */
export const encodePtq10Group = (trits: Int8Array): Uint8Array => {
  if (trits.length !== PTQ10_GROUP_WEIGHTS) throw new Error(`PTQ1_0 group encodes 128 weights, got ${trits.length}`)
  const bytes = new Uint8Array(PTQ10_DATA_BYTES)
  // each data byte serves a fixed set of elements at fixed 3-powers
  const byteElements: number[][] = Array.from({ length: PTQ10_DATA_BYTES }, () => [])
  for (let element = 0; element < PTQ10_GROUP_WEIGHTS; element++) {
    const { byte, power } = elementByteAndPower(element)
    byteElements[byte]![power] = element
  }
  for (let byte = 0; byte < PTQ10_DATA_BYTES; byte++) {
    const slots = byteElements[byte]!
    const tuple: number[] = []
    for (let power = 0; power < 5; power++) tuple.push(slots[power] === undefined ? -1 : trits[slots[power]!]!)
    bytes[byte] = ptq10ByteForTuple(tuple)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// LUT2 — the kernel-native 2-bit group
// ---------------------------------------------------------------------------

export const LUT2_GROUP_WEIGHTS = 128
/** 16 weights per uint32 → 8 words per 128-weight group. */
export const LUT2_GROUP_U32 = 8

/**
 * Pack 128 ternary weights (+ the group's scale, carried beside the words)
 * into the kernel-native LUT2 words: value = trit+1, element e in word e>>4
 * at shift (e%16)·2.
 */
export const packLut2Group = (trits: Int8Array): { data: Uint32Array; scale: number } => {
  if (trits.length !== LUT2_GROUP_WEIGHTS) throw new Error(`LUT2 group packs 128 weights, got ${trits.length}`)
  const data = new Uint32Array(LUT2_GROUP_U32)
  for (let element = 0; element < LUT2_GROUP_WEIGHTS; element++) {
    const value = trits[element]! + 1
    if (value < 0 || value > 2) throw new Error(`ternary weight out of range at ${element}: ${trits[element]}`)
    data[element >> 4]! |= value << ((element & 15) * 2)
  }
  return { data, scale: 1 }
}

/** Unpack LUT2 words back to ternary weights — the round-trip's other half. */
export const unpackLut2Group = (data: Uint32Array): Int8Array => {
  if (data.length !== LUT2_GROUP_U32) throw new Error(`LUT2 group unpacks 8 words, got ${data.length}`)
  const trits = new Int8Array(LUT2_GROUP_WEIGHTS)
  for (let element = 0; element < LUT2_GROUP_WEIGHTS; element++) {
    trits[element] = ((data[element >> 4]! >>> ((element & 15) * 2)) & 0b11) - 1
  }
  return trits
}

// ---------------------------------------------------------------------------
// FP16 — the on-disk scale carrier
// ---------------------------------------------------------------------------

/**
 * Widen FP16 bits to f32 — the group scale's on-disk form in the artifact.
 * Same arithmetic as the engine's unpack2x16float on the low half.
 */
export const decodeF16Bits = (bits: number): number => {
  const sign = (bits & 0x8000) === 0 ? 1 : -1
  const exponent = (bits & 0x7c00) >> 10
  const fraction = bits & 0x03ff
  if (exponent === 0) {
    if (fraction === 0) return sign * 0
    return sign * fraction * 2 ** -24 // subnormal: 2^-14 * (fraction/1024)
  }
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}
