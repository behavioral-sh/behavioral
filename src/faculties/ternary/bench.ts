/**
 * The ternary kernel bench core — the ONE home for the bench row contract,
 * the fixed input sets, and the summary aggregation. The GPU bench rig
 * (host-side, beside the corpus) and the kernel bench rows (slices 2–3 of
 * wgsl-kernel-iteration-0) both import this module; no parallel shape is
 * maintained anywhere else.
 *
 * Bundle-clean: browser-targeted (the rig serves this module bundled), so no
 * `node:` imports and no Bun globals — same rule as the faculties worker tree.
 *
 * @packageDocumentation
 */
import type { BenchGroup, BenchRow, BenchSummary } from './bench.types.ts'

/**
 * mulberry32 — a small seeded PRNG (public domain, Tommy Ettinger) chosen so
 * the fixed input sets are deterministic across every machine the bench runs
 * on (the comparison anchor: same weights, same inputs, same device class).
 */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The deterministic fixed token-id sequence for one bench input set. Token
 * ids land in the lower vocab range (below the special-token band of the
 * Qwen family) so the stock engine's decode never trips on them.
 */
export const fixedTokenIds = ({ seed, length, vocab }: { seed: number; length: number; vocab: number }): number[] => {
  const random = mulberry32(seed)
  const ids: number[] = []
  for (let i = 0; i < length; i++) ids.push(Math.floor(random() * vocab))
  return ids
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!

const round = (n: number): number => Number(n.toFixed(2))

/**
 * The capture rows aggregate to the comparison summary — the frontier replay's
 * input. Rows group by (kernel, profile, inputLength); a row without an
 * explicit tokPerSec carries the derived inputLength/wall (the prefill rows'
 * honest rate — the runner measures wall, the rate follows).
 */
export const summarizeBenchRows = ({
  generatedAt,
  model,
  device,
  rows,
}: {
  generatedAt: string
  model: string
  device: BenchSummary['device']
  rows: BenchRow[]
}): BenchSummary => {
  const keyed = new Map<string, BenchRow[]>()
  for (const row of rows) {
    const key = `${row.kernel}/${row.profile}/${row.inputLength}`
    const bucket = keyed.get(key)
    if (bucket) bucket.push(row)
    else keyed.set(key, [row])
  }
  const groups: BenchGroup[] = [...keyed.values()].map((cell) => {
    const { kernel, profile, inputLength } = cell[0]!
    const withRate = cell.map((row) => ({
      row,
      tokPerSec: row.tokPerSec ?? (row.inputLength / row.wallMs) * 1000,
    }))
    const walls = cell.map((row) => row.wallMs).sort((a, b) => a - b)
    const mean = walls.reduce((a, b) => a + b, 0) / walls.length
    const rates = withRate.map((entry) => entry.tokPerSec)
    const medianRate = rates.length > 0 ? [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)]! : null
    return {
      kernel,
      profile,
      inputLength,
      runs: cell.length,
      wallMs: { median: round(percentile(walls, 0.5)), mean: round(mean), p90: round(percentile(walls, 0.9)) },
      tokPerSec: medianRate === null ? null : round(medianRate),
    }
  })
  return { generatedAt, model, device, rows: rows.length, groups }
}
