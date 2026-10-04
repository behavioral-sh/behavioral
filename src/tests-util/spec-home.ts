import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { behavioralHome } from '../actuators/behavioral-home.ts'

/**
 * The worker-layer spec home — the per-worker home every spec boot that wants
 * a worker-scoped home takes from here: `join(behavioralHome(), 'worker-' +
 * (BUN_TEST_WORKER_ID ?? '1'))`, mkdir-on-first-use.
 *
 * Per-worker subdirs make a future `bun test --parallel` migration
 * collision-free by construction (the documented per-worker resource key);
 * single-process today it degenerates to `worker-1`.
 *
 * THE STARTUP-SNAPSHOT CONSTRAINT (re-verified 2026-10-03, Bun 1.4.x): a
 * runtime `process.env.X = …` mutation arrives UNSET in a `Bun.spawn` child —
 * the default inheritance is a snapshot of the parent's STARTUP environment.
 * Explicit threading (`env: { ...process.env, KEY: value }`) evaluates at the
 * spawn call and works. Consequence: per-spec/per-worker homes reach spawned
 * actuators and CLI children through explicit `env` overrides, never runtime
 * mutation; the launch-time env (`bun run test`'s `BEHAVIORAL_HOME=$(mktemp
 * -d)`) is the only layer that covers every spawn for free.
 *
 * MINIMAL: cleanup rides the OS tmp cleaner (`behavioralHome()` under
 * `bun run test` is a fresh per-run `mktemp -d`). Upgrade path: an afterAll
 * wipe if tmp pressure is ever measured.
 *
 * @public (spec-harness surface — test infrastructure, never production code)
 */
export const specHome = (): string => {
  const workerId = process.env.BUN_TEST_WORKER_ID ?? '1'
  const home = join(behavioralHome(), `worker-${workerId}`)
  mkdirSync(home, { recursive: true })
  return home
}
