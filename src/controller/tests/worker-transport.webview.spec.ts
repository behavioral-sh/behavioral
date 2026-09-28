/**
 * Worker transport WebView probe — the serving contract's proof.
 *
 * The controller's default carrier spawns a dedicated module Worker from the
 * conventional `B_PROGRAM_WORKER_PATH` serving path (`/b-program.worker.ts`).
 * The worker URL is a serving contract, not a bundler-detected entry — Bun
 * does not detect `new Worker(new URL(...))` for browser targets — so a
 * serving side must emit the bundled worker at exactly that path. These specs
 * pin the contract end-to-end on a real WebView (Chromium, headless):
 *
 * 1. (Bun-only, level 1 of the `.ts`-URL probe) the conventional route serves
 *    200 + a javascript Content-Type + the transpiled worker body —
 *    `new Response(artifact)` sets the type automatically.
 * 2. (level 2 of the `.ts`-URL probe) a REAL page spawns a module Worker at
 *    the `.ts` path and round-trips a pong — the engine-acceptance evidence.
 *    Outcome pinned: if this passes, the conventional path keeps the `.ts`
 *    extension outright; if it fails, the path falls back to `.js` and the
 *    engine's exact constraint is recorded in the findings (do not delete
 *    this spec — pin the outcome).
 * 3. The controller booted with NO injected transport reaches the default
 *    worker (click → ui_event → stub echo marker in the DOM).
 * 4. The no-route leg: with the worker route absent, the failure surfaces as
 *    the transport's status event (fail-visible) and never throws into the
 *    page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { B_PROGRAM_WORKER_PATH } from '../worker-transport.ts'
import { startWorkerProbeServer } from './fixtures/worker-serve.ts'

let server: Awaited<ReturnType<typeof startWorkerProbeServer>> | undefined
let noRouteServer: Awaited<ReturnType<typeof startWorkerProbeServer>> | undefined
let port = 0
let noRoutePort = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const open = async (path: string): Promise<Bun.WebView> => {
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false }, console: globalThis.console })
  await view.navigate(`http://localhost:${port}${path}`)
  return view
}

const openNoRoute = async (path: string): Promise<Bun.WebView> => {
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false }, console: globalThis.console })
  await view.navigate(`http://localhost:${noRoutePort}${path}`)
  return view
}

/** Poll a browser read until it returns a value (or throws on timeout). */
const waitFor = async <T>(read: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> => {
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
  server = await startWorkerProbeServer({ port: 0 })
  noRouteServer = await startWorkerProbeServer({ withWorkerRoute: false })
  port = server.port
  noRoutePort = noRouteServer.port
  // Warm the chrome backend: the first WebView in a process pays cold browser
  // startup, which can exceed a test's 20s budget on a cold CI runner. Pay it
  // here, outside any test budget, so every spec runs against a warm browser.
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false } })
  await view.navigate(`http://localhost:${port}/health`)
  view.close()
}, 60_000)

afterAll(async () => {
  for (const fixture of [server, noRouteServer]) {
    if (fixture) await fixture.stop()
  }
  server = undefined
  noRouteServer = undefined
})

describe('the .ts-URL serving contract', () => {
  test('level 1 (Bun): the conventional route serves javascript content-type + the worker body', async () => {
    const response = await fetch(`http://localhost:${port}${B_PROGRAM_WORKER_PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')?.startsWith('text/javascript')).toBe(true)
    const body = await response.text()
    // The transpiled stub: the hello reply the controller's handshake needs.
    expect(body).toContain('hello')
  })

  test('level 2 (WebView): a real module Worker at the .ts path round-trips a pong', async () => {
    await using view = await open('/worker-probe.html')
    const pong = await waitFor(async () => {
      const state = await view.evaluate<{ pong?: boolean } | undefined>(
        'window.__workerProbe ? window.__workerProbe : undefined',
      )
      return state?.pong ? state : undefined
    })
    expect(pong.pong).toBe(true)
    // The engine accepted the .ts URL — no worker-level error surfaced.
    const errors = await view.evaluate<string[]>('window.__workerProbe.errors')
    expect(errors).toEqual([])
  }, 20_000)
})

describe('the controller default reaches the worker', () => {
  test('no injected transport: the default spawns the worker and the echo path completes', async () => {
    await using view = await open('/controller-default.html')
    // The controller connects; a click rides the default carrier; the stub
    // worker echoes a ui_render marker — the full default path, end to end.
    await view.evaluate<void>('document.getElementById("default-btn").click()')
    // The stub echoes every ClientMessage it receives: the ui_event triggers
    // the first echo, the controller's ui_success ack echoes the last — the
    // final DOM marker proves the ack round-trip through the default carrier.
    const marker = await waitFor(async () => {
      const text = await view.evaluate<string | undefined>('document.getElementById("stub_ui_success")?.textContent')
      return text ? text : undefined
    })
    expect(marker).toBe('ui_success')
    // The boot never threw into the page.
    const errors = await view.evaluate<string[]>('window.__defaultProbe.errors')
    expect(errors).toEqual([])
  }, 20_000)

  test('no worker route: the failure is visible as a status event, never a page throw', async () => {
    await using view = await openNoRoute('/controller-default.html')
    await sleep(1_000) // the failed spawn's status path settles
    // The controller constructed; the page never threw (the worker failure
    // surfaced as the transport's status event, which the controller reports
    // into the dead carrier — fail-visible, not fail-crash).
    const errors = await view.evaluate<string[]>('window.__defaultProbe.errors')
    expect(errors).toEqual([])
    const controllerUp = await view.evaluate<boolean>('window.__controller instanceof Object ? true : false')
    expect(controllerUp).toBe(true)
    // And no echo marker: nothing reached a worker.
    const marker = await view.evaluate<string | undefined>('document.getElementById("stub_ui_success")?.textContent')
    expect(marker).toBeUndefined()
  }, 20_000)

  test('no worker route: the raw worker error surfaces as the transport status event', async () => {
    await using view = await openNoRoute('/worker-probe.html')
    const status = await waitFor(async () => {
      const state = await view.evaluate<{ status?: string[] } | undefined>(
        'window.__workerProbe ? window.__workerProbe : undefined',
      )
      return state?.status?.includes('error') ? state.status : undefined
    })
    expect(status).toContain('error')
    expect(status).not.toContain('open')
  }, 20_000)
})
