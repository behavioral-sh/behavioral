/**
 * The kernel bench's fixed measurement plan — the comparison anchor for every
 * kernel row: same weights, same inputs, same profile lengths across the stock
 * engine rows and every ternary-kernel variant. Changing any of these is a NEW
 * bench generation, never a silent re-baseline.
 *
 * @packageDocumentation
 */

/** The input-set seed — mulberry32 in bench.ts. */
export const BENCH_SEED = 20261006

/**
 * The token-id ceiling of the fixed input sets — ids land in [1000, vocab) so
 * the Qwen family's decode never trips on special tokens (which sit at the top
 * of the vocab). The probe passes this bound to fixedTokenIds.
 */
export const BENCH_TOKEN_VOCAB = 100_000

/** The batch-matmul profile's fixed prompt lengths (the jev-0 Slice-2 table's prefill rows). */
export const BENCH_PREFILL_LENGTHS = [512, 2048, 8192] as const

/** Repeats per prefill cell (the 8192 cell costs ~2 min each — fewer repeats). */
export const BENCH_PREFILL_REPEATS: Record<number, number> = { 512: 3, 2048: 3, 8192: 2 }

/** The matvec profile's prefilled context length. */
export const BENCH_DECODE_CONTEXT = 512

/** The matvec profile's decode steps per run. */
export const BENCH_DECODE_TOKENS = 128

/** Repeats per matvec cell (repeat 0 may carry pipeline warm-up; the median is the row). */
export const BENCH_DECODE_REPEATS = 2

/** The stock row's kernel label. */
export const STOCK_KERNEL = 'stock-engine'

/**
 * The pinned numerical-agreement tolerance for the kernel rows: max
 * |y_kernel − y_ref| relative to max |y_ref| over the matrix. The bench row
 * FAILS visibly above it (the agreement pin, not a soft metric).
 */
export const BENCH_AGREEMENT_TOLERANCE = 1e-4
