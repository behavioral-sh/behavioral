/**
 * The kernel bench row contract — the vocabulary the autoresearch loop's
 * captures and frontier replay read (wgsl-kernel-iteration-0). One row per
 * measured (kernel, profile, inputLength) run; the profiles carry the ruled
 * kernel vocabulary: `matvec` is the decode-bound systemTwo chat profile,
 * `batch-matmul` is the prefill-bound systemOne logits-readback profile.
 *
 * @packageDocumentation
 */
import type { JsonObject } from '../../behavioral/behavioral.types.ts'

export type BenchProfile = 'matvec' | 'batch-matmul'

export type BenchRow = {
  kind: 'kernel_bench_row'
  /** The capture run tag — rows of one rig run share it. */
  run: string
  /** The artifact label (e.g. `Ternary-Bonsai-2-27B-PTQ1_0`). */
  model: string
  /** The kernel under test: `stock-engine` today, the ternary kernel variants later. */
  kernel: string
  profile: BenchProfile
  /** Fixed input tokens (matvec: the prefilled context length; batch-matmul: prompt tokens). */
  inputLength: number
  /** Steps measured past the input (matvec); 0 for batch-matmul. */
  outputTokens: number
  wallMs: number
  /** The profile's token rate; null when the runner leaves it to the derived inputLength/wall. */
  tokPerSec: number | null
  /** 0-indexed repeat of the same (kernel, profile, inputLength) cell. */
  repeat: number
  /** Engine-reported extras (ttft, decode depth, agreement…). */
  detail?: JsonObject
}

export type BenchGroup = {
  kernel: string
  profile: BenchProfile
  inputLength: number
  runs: number
  wallMs: { median: number; mean: number; p90: number }
  tokPerSec: number | null
}

export type BenchSummary = {
  generatedAt: string
  model: string
  device: JsonObject
  rows: number
  groups: BenchGroup[]
}
