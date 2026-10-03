import { describe, expect, test } from 'bun:test'

/**
 * Pure-runtime gate: the engine and the frontier embed must be able to run
 * inside a browser Web Worker, so they carry no Bun imports. The shared
 * runtime-neutral `uuid` (RFC 9562 v7, `crypto.getRandomValues`) replaces the
 * `randomUUIDv7` import from `bun` at every call site in these trees.
 */
const PURE_TREES = ['src/behavioral', 'src/faculties'] as const

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

/** Direct `Bun.*` global references — the browser bundle has no Bun global.
 *  The guarded form (`globalThis.Bun`) is the engine's one sanctioned probe
 *  (create-worker's scope detection); bare `Bun.` references throw at eval in
 *  the WebView. Spec files are Bun-hosted by design. */
const bunGlobals = async (dir: string): Promise<string[]> => {
  const proc = Bun.spawn(['grep', '-rln', '--include=*.ts', '-E', '[^.]Bun\\.', dir])
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
    .trim()
    .split('\n')
    .filter((f) => f !== '' && !f.endsWith('.spec.ts') && !f.includes('/tests/'))
}

describe('pure runtime', () => {
  for (const tree of PURE_TREES) {
    test(`no 'bun' imports reachable from ${tree}/`, async () => {
      const offenders = await bunImports(tree)
      expect(offenders).toEqual([])
    })

    test(`no direct Bun global references reachable from ${tree}/`, async () => {
      const offenders = await bunGlobals(tree)
      expect(offenders).toEqual([])
    })
  }
})
