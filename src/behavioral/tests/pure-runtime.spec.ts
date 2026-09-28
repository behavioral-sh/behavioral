import { describe, expect, test } from 'bun:test'

/**
 * Pure-runtime gate: the engine and the frontier embed must be able to run
 * inside a browser Web Worker, so they carry no Bun imports. The shared
 * runtime-neutral `uuid` (RFC 9562 v7, `crypto.getRandomValues`) replaces the
 * `randomUUIDv7` import from `bun` at every call site in these trees.
 */
const PURE_TREES = ['src/behavioral', 'src/faculties/frontier'] as const

const bunImports = async (dir: string): Promise<string[]> => {
  const proc = Bun.spawn(['grep', '-rln', `from 'bun'`, dir])
  const out = await new Response(proc.stdout).text()
  await proc.exited
  // Spec files are Bun-hosted by design (`bun:test`); the gate covers the
  // shipped runtime trees.
  return out
    .trim()
    .split('\n')
    .filter((f) => f !== '' && !f.endsWith('.spec.ts'))
}

describe('pure runtime', () => {
  for (const tree of PURE_TREES) {
    test(`no 'bun' imports reachable from ${tree}/`, async () => {
      const offenders = await bunImports(tree)
      expect(offenders).toEqual([])
    })
  }
})
