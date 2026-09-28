/**
 * Transport seam spec.
 *
 * Single observable interface: the {@link Controller} running on a real web
 * page with an injected in-memory {@link Transport} carrier (a real second
 * carrier — not a FakeWebSocket, not a WebSocket). Follows the controller.spec
 * harness: an in-process Bun.WebView (Chromium via the chrome backend,
 * headless, spawned fresh) loads a serve fixture page, and the bundled
 * controller is constructed in-page with the injected transport.
 *
 * `navigate()` resolves on the main frame's `load` event, so the in-page
 * transport `<script>` (head, synchronous) and the controller connect module
 * (deferred) have both executed by the time it returns — the old harness's
 * `__transportReady` / `__controller` post-goto polls are covered by load-event
 * semantics. The controller delegates `#send` to `transport.send`, registers
 * `onMessage`/`onStatus`, and the default-WS path is byte-for-byte unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ControllerConstructorArgs, Transport } from '../controller.types.ts'
import { startTransportServer } from './fixtures/transport-serve.ts'

// Type-level assertion: ControllerConstructorArgs accepts an injected
// transport — and the widened carrier contract: a Worker/MessagePort too (the
// wrapped-in-worker-transport shapes). `Transport` is exported; the
// conditional type resolves to `true`. Type-only — erased at runtime.
type _AssertTransportArg = ControllerConstructorArgs extends { transport?: Transport | Worker | MessagePort }
  ? true
  : false
const _assertTransportArg: _AssertTransportArg = true
void _assertTransportArg

let server: Awaited<ReturnType<typeof startTransportServer>> | undefined
let port = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Open a fresh WebView on the transport fixture; resolves on the load event. */
const open = async (): Promise<Bun.WebView> => {
  // Surface page-side console output (errors especially) in the test runner.
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false }, console: globalThis.console })
  await view.navigate(`http://localhost:${port}/transport.html`)
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
  server = await startTransportServer(0)
  port = server.port
  // Warm the chrome backend: the first WebView in a process pays cold browser
  // startup, which can exceed a test's 20s budget on a cold CI runner (the
  // flaky `constructs and accepts` timeout). Pay it here, outside any test
  // budget, so every spec runs against a warm browser.
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false } })
  await view.navigate(`http://localhost:${port}/health`)
  view.close()
}, 60_000)

afterAll(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
})

describe('controller: injectable transport seam', () => {
  test('constructs and accepts the injected transport', async () => {
    await using view = await open()
    const controller = await waitFor(async () => {
      const ok = await view.evaluate<boolean | undefined>('window.__controller instanceof Object ? true : undefined')
      return ok === true ? true : undefined
    })
    expect(controller).toBe(true)
    // The controller must hold the injected transport, not have opened a WebSocket.
    const usesTransport = await view.evaluate<boolean>(
      '(window.__transport && window.__transport.sent !== undefined) ? true : false',
    )
    expect(usesTransport).toBe(true)
  }, 20_000)

  test('outgoing: a b-trigger delivers a ClientMessage to transport.send', async () => {
    await using view = await open()
    // Click the b-trigger button; its handler emits a ui_event via #send,
    // which must delegate to transport.send (not a WebSocket).
    await view.evaluate<void>('document.getElementById("transport-btn").click()')
    const sent = await waitFor(async () => {
      const messages = await view.evaluate<unknown[]>(
        'window.__transport && window.__transport.sent ? window.__transport.sent : []',
      )
      const uiEvents = Array.isArray(messages)
        ? messages.filter((m) => (m as { type?: string })?.type === 'ui_event')
        : []
      return uiEvents.length > 0 ? uiEvents : undefined
    }, 5_000)
    expect(Array.isArray(sent)).toBe(true)
    expect(sent.length).toBeGreaterThan(0)
    const first = sent[0] as { type?: string; detail?: { event?: { type?: string } } }
    expect(first.type).toBe('ui_event')
    expect(first.detail?.event?.type).toBe('do_thing')
  }, 20_000)

  test('incoming: a ServerMessage via transport.__deliver applies to the DOM', async () => {
    await using view = await open()
    // Push a render ServerMessage through the transport's incoming registration.
    await view.evaluate<void>(
      'window.__transport.__deliver({ type: "ui_render", detail: { id: "r1", target: "main", html: "<p id=\\"injected\\">injected via transport</p>", swap: "innerHTML" } })',
    )
    const text = await waitFor(async () => {
      const t = await view.evaluate<string | undefined>('document.getElementById("injected")?.textContent')
      return t && t !== 'undefined' ? t : undefined
    }, 5_000)
    expect(text).toContain('injected via transport')
  }, 20_000)
})
