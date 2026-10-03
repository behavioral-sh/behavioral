import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

/**
 * The deletion gate — the rewire's final boundary proofs (rg-backed, RED
 * first): the pre-rebuild faculties tree is GONE (no imports reachable, no
 * files left), the retired composition seams (`useFaculty`, the
 * `configSystemOne/Two` provider entries, the `useSystemOne/Two` host
 * helpers) have zero live call sites, and the composition's only faculty
 * construction is `useWorker` (the worker lane; the socket lane composes
 * with it through the same LaneBuilder shape).
 */
const SRC_ROOT = new URL('../../', import.meta.url).pathname

const grepFiles = async (pattern: string, dir: string): Promise<string[]> => {
  const proc = Bun.spawn(['grep', '-rln', '--include=*.ts', '-E', pattern, dir])
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
    .trim()
    .split('\n')
    .filter((f) => f !== '' && !f.endsWith('.spec.ts') && !f.includes('/tests/'))
    .map((f) => f.replace(SRC_ROOT, ''))
}

describe('the deletion gate — the pre-rebuild tree is gone', () => {
  test('src/old-faculties/ does not exist', () => {
    expect(existsSync(`${SRC_ROOT}old-faculties`)).toBe(false)
  })

  test('zero imports of the old-faculties tree', async () => {
    const offenders = await grepFiles("from '.*old-faculties", SRC_ROOT)
    expect(offenders).toEqual([])
  })

  test('zero live call sites of the retired composition seams', async () => {
    const offenders = await grepFiles(
      '\\b(useFaculty|configSystemOne|configSystemTwo|useSystemOne|useSystemTwo)\\(',
      SRC_ROOT,
    )
    expect(offenders).toEqual([])
  })

  test('the composition\u2019s only faculty construction is useWorker', async () => {
    // The lane construction seam: useWorker lives in the composition home;
    // the socket lane composes with it through the same LaneBuilder shape.
    // Nothing else in the composition SOURCE constructs faculty lanes (the
    // spec harness builds its own actuator lanes through the host's
    // useActuator — test files are excluded).
    const useWorkerSites = await grepFiles('\\buseWorker\\(', `${SRC_ROOT}b-program`)
    // The composition constructs the fixed three here; use-worker.ts owns
    // the definition (its call sites are the curried builder's internals).
    expect(useWorkerSites).toEqual(['b-program/b-program.ts'])
    const retired = await grepFiles('\\b(useFaculty|useActuator)\\(', `${SRC_ROOT}b-program`)
    expect(retired).toEqual([])
  })
})
