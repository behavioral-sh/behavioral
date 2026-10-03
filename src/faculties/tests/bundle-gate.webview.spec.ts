/**
 * The bundle gate's level 2 (the WebView probe): every faculty entry's
 * CLASSIC bundle boots in the real WebView and round-trips the init frame +
 * one request. The composition spawns its faculty workers CLASSIC (`new
 * Worker(url)` with no `type: 'module'` — the shelf's nested-module-workers
 * finding lives in exactly this layer), so the served artifact must be a
 * classic-safe single-file script; Bun's browser build silently externalizes
 * node builtins to empty shims (the bundle succeeds, the worker dies at
 * eval), so the only honest check is to run the artifact in the WebView.
 *
 * The requests are the level-1 gate's pins: the typed-error answers prove
 * the FULL path (init frame → validateInput → respond → envelope) without
 * network; the remoteSystemTwo analysis answers ok.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startBundleGateServer } from './fixtures/bundle-gate-serve.ts'

let server: Awaited<ReturnType<typeof startBundleGateServer>> | undefined
let port = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll a browser read until it returns a value (or throws on timeout). */
const waitFor = async <T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (value === undefined && Date.now() < deadline) {
    await sleep(50)
    value = await read()
  }
  if (value === undefined) throw new Error('Timed out waiting for browser state.')
  return value
}

beforeAll(async () => {
  server = await startBundleGateServer(0)
  port = server!.port
  // Warm the chrome backend outside any test budget (the harness's lesson).
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false } })
  await view.navigate(`http://localhost:${port}/health`).catch(() => {})
  view.close()
}, 60_000)

afterAll(() => {
  server?.stop()
  server = undefined
})

describe('the bundle gate level 2 — faculty classic bundles boot in the real WebView', () => {
  const open = async (path: string): Promise<Bun.WebView> => {
    const view = new Bun.WebView({ backend: { type: 'chrome', url: false }, console: globalThis.console })
    await view.navigate(`http://localhost:${port}${path}`)
    return view
  }

  test('every faculty entry\u2019s classic bundle boots and round-trips its request', async () => {
    await using view = await open('/probe.html')
    const results = await waitFor(async () => {
      const state = await view.evaluate<Record<string, unknown> | undefined>(
        'Object.keys(window.__results).length === 3 ? window.__results : undefined',
      )
      return state
    })
    // No worker-level error: every classic artifact booted clean.
    const errors = await view.evaluate<Record<string, string>>('window.__errors')
    expect(errors).toEqual({})
    // systemOne: no endpoint — the typed error proves the full path.
    const systemOne = results['system-one'] as { detail: { ok?: boolean; error?: { message?: string } } }
    expect(systemOne.detail.ok).toBe(false)
    expect(systemOne.detail.error?.message).toBe('no model configured for the system one endpoint')
    // systemTwo: unknown provider — the typed error proves the full path.
    const systemTwo = results['system-two'] as { detail: { ok?: boolean; error?: { message?: string } } }
    expect(systemTwo.detail.ok).toBe(false)
    expect(systemTwo.detail.error?.message).toBe('[Error: unknown provider "missing"]')
    // remoteSystemTwo: the analysis answers ok (the replay ran in the bundle).
    const remote = results['remote-system-two'] as { detail: { ok?: boolean } }
    expect(remote.detail.ok).toBe(true)
  }, 30_000)
})
