/**
 * The ternary kernel home's boundary — the WGSL fused dequant-matmul track
 * (wgsl-kernel-iteration-0): the bench harness, the packing format, and the
 * kernel. Consumers import from here.
 *
 * @packageDocumentation
 */

export {
  BENCH_DECODE_CONTEXT,
  BENCH_DECODE_REPEATS,
  BENCH_DECODE_TOKENS,
  BENCH_PREFILL_LENGTHS,
  BENCH_PREFILL_REPEATS,
  BENCH_SEED,
  BENCH_TOKEN_VOCAB,
  STOCK_KERNEL,
} from './ternary/bench.constants.ts'
export { BenchRowSchema, validateBenchRow } from './ternary/bench.schemas.ts'
export { fixedTokenIds, mulberry32, summarizeBenchRows } from './ternary/bench.ts'
export type { BenchGroup, BenchProfile, BenchRow, BenchSummary } from './ternary/bench.types.ts'
export {
  decodeF16Bits,
  decodePtq10Group,
  encodePtq10Group,
  LUT2_GROUP_U32,
  LUT2_GROUP_WEIGHTS,
  PTQ10_DATA_BYTES,
  PTQ10_GROUP_BYTES,
  PTQ10_GROUP_WEIGHTS,
  packLut2Group,
  unpackLut2Group,
} from './ternary/packing.ts'
