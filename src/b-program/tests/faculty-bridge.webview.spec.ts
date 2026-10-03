/**
 * The faculty-bridge WebView e2e (socket slice 1) — a real page boots the
 * REAL bundled composition worker over the landed serving contract, attaches
 * (the session cookie rides the page), and a store_request round-trips
 * page → worker → WS → daemon bridge → REAL store actuator → back. The
 * trace leg: the worker's redacted stream pushes upstream — the fixture
 * daemon records the arrivals.
 *
 * Harness: the composition-worker webview spec's patterns — a Bun.WebView
 * (chrome backend, headless), warm-up in beforeAll, COOP/COEP on the fixture
 * server. Real pages, real workers, real processes — no mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { Trace } from '../../behavioral/behavioral.types.ts'
import { type BridgeFixtureServer, startBridgeFixtureServer } from './fixtures/bridge-serve.ts'

let server: BridgeFixtureServer | undefined
let port = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Open a fresh WebView on a fixture page; resolves on the load event. */
const open = async (path: string): Promise<Bun.WebView> => {
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false }, console: globalThis.console })
  await view.navigate(`http://localhost:${port}${path}`)
  return view
}

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

/** The selection traces a page has observed (from its redacted trace tap). */
const selections = async (view: Bun.WebView): Promise<Array<Record<string, unknown>>> =>
  (await view.evaluate<unknown[]>('window.__traces'))
    .filter(
      (t): t is Record<string, unknown> =>
        typeof t === 'object' && t !== null && (t as { kind?: string }).kind === 'selection',
    )
    .map((t) => t as Record<string, unknown>)

beforeAll(async () => {
  server = await startBridgeFixtureServer(0)
  port = server!.port
  // Warm the chrome browser outside any test budget (the harness's lesson).
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false } })
  await view.navigate(`http://localhost:${port}/health`).catch(() => {})
  view.close()
}, 60_000)

afterAll(() => {
  server?.stop()
  server = undefined
})

describe('faculty bridge — the WebView e2e', () => {
  test('a store_request round-trips page → worker → WS → daemon → the real store actuator → back', async () => {
    await using view = await open('/bridge.html')
    await waitFor(async () => {
      const hello = await view.evaluate<Record<string, unknown> | undefined>('window.__hello')
      return hello !== undefined && hello !== null ? hello : undefined
    })
    await view.evaluate<void>('document.getElementById("s-btn").click()')
    const result = await waitFor(async () => {
      const selected = (await selections(view)).find(
        (t) => (t.selected as { type?: string } | undefined)?.type === 'store_request_result',
      )
      return selected === undefined ? undefined : selected
    })
    const detail = (result.selected as { detail?: Record<string, unknown> }).detail
    expect(detail?.id).toBe('e2e_1')
    // The REAL actuator answered through the bridge.
    expect(detail?.ok).toBe(true)
    expect(await view.evaluate<unknown>('window.__workerError')).toBeNull()
  }, 45_000)

  test('the trace leg flows worker → daemon: the pushed stream carries the composition redacted traces', async () => {
    await using view = await open('/bridge.html')
    await waitFor(async () => {
      const hello = await view.evaluate<Record<string, unknown> | undefined>('window.__hello')
      return hello !== undefined && hello !== null ? hello : undefined
    })
    await view.evaluate<void>('document.getElementById("s-btn").click()')
    // The round-trip's result selection pushes upstream through the pipe.
    const pushed = (await server!.waitForPushedTrace(
      (trace: Trace) =>
        trace.kind === TRACE_MESSAGE_KINDS.selection &&
        (trace as unknown as { selected?: { type?: string } }).selected?.type === 'store_request_result',
    )) as unknown as { selected?: { detail?: { id?: string; ok?: boolean } } }
    expect(pushed.selected?.detail?.id).toBe('e2e_1')
    expect(pushed.selected?.detail?.ok).toBe(true)
    // The stream is FULL fidelity: boot traces preceded the round-trip.
    expect(server!.pushedTraces.length).toBeGreaterThan(1)
  }, 45_000)
})
