/**
 * The CPU reference for the ternary fused dequant kernels — the numerical
 * contract the WGSL kernel's agreement is pinned against (and the host-side
 * checker the bench rig runs beside the capture). Same math, same LUT2 group
 * layout, same f32 accumulation the kernel does — the tolerance is the pin,
 * not bit-identity (accumulation order differs).
 *
 * @packageDocumentation
 */
import { LUT2_GROUP_U32, LUT2_GROUP_WEIGHTS } from './packing.ts'

/** A ternary weight matrix in the kernel-native LUT2 layout, row-major. */
export type Lut2Weights = {
  rows: number
  cols: number
  /** rows·(cols/128)·8 uint32 words — row r's group g at (r·groupsPerRow + g)·8. */
  data: Uint32Array
  /** One f32 scale per 128-weight group. */
  scales: Float32Array
}

/** The groups per row (cols must be a multiple of 128). */
export const groupsPerRow = (cols: number): number => {
  if (cols % LUT2_GROUP_WEIGHTS !== 0) throw new Error(`cols ${cols} is not a multiple of the 128-weight group`)
  return cols / LUT2_GROUP_WEIGHTS
}

/** f32 dequant-matvec: y[r] = Σ_c trit(W[r,c])·scale(group(r,c))·x[c]. */
export const dequantMatvec = (w: Lut2Weights, x: Float32Array): Float32Array => {
  const gpr = groupsPerRow(w.cols)
  if (x.length !== w.cols) throw new Error(`matvec input length ${x.length} ≠ cols ${w.cols}`)
  const y = new Float32Array(w.rows)
  for (let r = 0; r < w.rows; r++) {
    let acc = 0
    const rowBase = r * gpr * LUT2_GROUP_U32
    for (let g = 0; g < gpr; g++) {
      const scale = w.scales[r * gpr + g]!
      const base = rowBase + g * LUT2_GROUP_U32
      const colBase = g * LUT2_GROUP_WEIGHTS
      for (let wordIndex = 0; wordIndex < LUT2_GROUP_U32; wordIndex++) {
        const word = w.data[base + wordIndex]!
        const col = colBase + wordIndex * 16
        for (let k = 0; k < 16; k++) {
          const v = (word >>> (k * 2)) & 0b11
          acc += (v - 1) * scale * x[col + k]!
        }
      }
    }
    y[r] = acc
  }
  return y
}
