import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { behavioralHome } from '../actuators/behavioral-home.ts'
import { specHome } from './spec-home.ts'

/** Assert the launch layer is active, then hand the narrowed launch home back. */
const requireLaunchHome = (): string => {
  const launchHome = process.env.BEHAVIORAL_HOME
  expect(launchHome).toBeDefined()
  return launchHome as string
}

/**
 * The spec-home standard's WORKER-layer pins (the ruling of 2026-10-03):
 * specHome() keys a per-worker subdir off BUN_TEST_WORKER_ID (1-based, the
 * documented per-worker resource key) under the launch-set behavioralHome(),
 * mkdir-on-first-use — the --parallel-ready shape that degenerates to
 * worker-1 in single-process runs.
 */
describe('specHome — the worker-layer spec home', () => {
  test('keys a per-worker subdir under behavioralHome() and creates it on first use', () => {
    const home = specHome()
    expect(home).toBe(join(behavioralHome(), 'worker-1'))
    expect(existsSync(home)).toBe(true)
  })

  test('keys on BUN_TEST_WORKER_ID when set, defaulting to worker-1', () => {
    const previous = process.env.BUN_TEST_WORKER_ID
    process.env.BUN_TEST_WORKER_ID = '3'
    try {
      const home = specHome()
      expect(home).toBe(join(behavioralHome(), 'worker-3'))
      expect(existsSync(home)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.BUN_TEST_WORKER_ID
      else process.env.BUN_TEST_WORKER_ID = previous
    }
  })
})

/** One parsed probe line from a spawned `bun -e` child. */
type ProbeLine = { home: string | null }

/** Spawn a child that reports its BEHAVIORAL_HOME with NO explicit env (default inheritance). */
const probeChildDefaultEnv = async (): Promise<ProbeLine> => {
  const proc = Bun.spawn(['bun', '-e', 'console.log(JSON.stringify({ home: process.env.BEHAVIORAL_HOME ?? null }))'])
  return JSON.parse((await new Response(proc.stdout).text()).trim()) as ProbeLine
}

/** Spawn a child that reports its BEHAVIORAL_HOME through the explicit env-override merge. */
const probeChildExplicitEnv = async (home: string): Promise<ProbeLine> => {
  const proc = Bun.spawn(['bun', '-e', 'console.log(JSON.stringify({ home: process.env.BEHAVIORAL_HOME ?? null }))'], {
    env: { ...process.env, BEHAVIORAL_HOME: home },
  })
  return JSON.parse((await new Response(proc.stdout).text()).trim()) as ProbeLine
}

/**
 * The spec-home standard's LAUNCH-layer pins (the ruling of 2026-10-03): the
 * `test` script sets BEHAVIORAL_HOME to a fresh per-run temp dir at launch —
 * the only layer that covers in-process reads, every spawned child, and every
 * future --parallel worker for free. These pins demand the launch layer: run
 * the suite through `bun run test`, never bare `bun test`.
 */
describe('the launch layer — the per-run temp home', () => {
  test('behavioralHome() resolves under the launch-set dir', () => {
    const launchHome = requireLaunchHome()
    expect(behavioralHome()).toBe(launchHome)
  })

  test('a spawned child inherits the launch-set home with NO explicit env', async () => {
    const launchHome = requireLaunchHome()
    const probe = await probeChildDefaultEnv()
    expect(probe.home).toBe(launchHome)
  })

  test('a runtime-mutated BEHAVIORAL_HOME does not reach a spawned child; the explicit override does', async () => {
    const launchHome = requireLaunchHome()
    process.env.BEHAVIORAL_HOME = '/behavioral-spec-mutation-sentinel'
    try {
      // The constraint pinned as behavior: default inheritance is the parent's
      // STARTUP environment — the runtime mutation never rides to the child,
      // so a future fixer cannot regress into relying on it.
      const inherited = await probeChildDefaultEnv()
      expect(inherited.home).toBe(launchHome)
      expect(inherited.home).not.toBe('/behavioral-spec-mutation-sentinel')
      // The merge pattern evaluates at the spawn call and arrives correctly.
      const overridden = await probeChildExplicitEnv('/behavioral-spec-explicit-home')
      expect(overridden.home).toBe('/behavioral-spec-explicit-home')
    } finally {
      process.env.BEHAVIORAL_HOME = launchHome
    }
  })
})
