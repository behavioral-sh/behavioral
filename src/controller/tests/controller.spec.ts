/**
 * Controller tests.
 *
 * Single observable interface: the {@link Controller} running on a real web page.
 *
 * A Bun HTTP + WebSocket fixture server (./fixtures/serve.ts) serves SSR'd pages
 * that load the bundled controller and drives them with scripted server messages
 * over a real WebSocket. A real browser (Bun.WebView — Chromium via the chrome
 * backend, headless, spawned in-process) loads the page; assertions read the DOM
 * via `view.evaluate` and the server-captured client messages (ui_event, error,
 * success, snapshot, form posts).
 *
 * No happy-dom, no FakeWebSocket. The controller is tested in the environment
 * it ships in.
 *
 * Harness notes:
 * - The chrome backend is forced (`url: false`: always spawn a fresh headless
 *   Chrome, never attach to a running browser) so the harness is identical on
 *   macOS dev machines and Linux CI (where webkit is unavailable and chrome is
 *   the only backend) — and so close-code/page-event semantics match what CI
 *   observes (the webkit/WKWebView backend maps server close codes 1012/1013
 *   to 1005, which the controller's retry set never sees).
 * - `navigate()` resolves on the main frame's `load` event; a deferred module's
 *   top-level await does NOT block the load event, so post-load page state can
 *   still be settling — the specs poll where that matters.
 * - One evaluate/click in flight at a time per view (Bun.WebView throws
 *   ERR_INVALID_STATE on concurrent same-slot ops); the specs await sequentially.
 * - Ephemeral storage is the default; each test gets a fresh view disposed via
 *   `await using`. Chrome is spawned once per Bun process; each view is a tab.
 * - `beforeAll` warms the backend with one throwaway view (60s hook budget):
 *   the first view in a process pays cold Chrome startup, which can exceed a
 *   test's 20s budget on a cold CI runner — pay it once, outside any test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type FixtureServer, startServer } from './fixtures/serve.ts'

let fixture: FixtureServer | undefined

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Open a fresh WebView on a fixture page; resolves on the page's load event. */
const open = async (path: string): Promise<Bun.WebView> => {
  if (!fixture) throw new Error('Fixture server not started.')
  // Surface page-side console output (errors especially) in the test runner.
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false }, console: globalThis.console })
  await view.navigate(`http://localhost:${fixture.port}${path}`)
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

const getFixture = (): FixtureServer => {
  if (!fixture) throw new Error('Fixture server is not initialized.')
  return fixture
}

beforeAll(async () => {
  fixture = startServer(0)
  // Warm the chrome backend: the first WebView in a process pays cold browser
  // startup, which can exceed a test's 20s budget on a cold CI runner. Pay it
  // here, outside any test budget, so every spec runs against a warm browser.
  const view = new Bun.WebView({ backend: { type: 'chrome', url: false } })
  await view.navigate(`http://localhost:${fixture.port}/health`)
  view.close()
}, 60_000)

afterAll(async () => {
  if (fixture) {
    await fixture.stop()
    fixture = undefined
  }
})

// ─── Connect & render ────────────────────────────────────────────────────────

describe('controller: connect & render', () => {
  test('page loads the bundled controller, connects, and renders a server message', async () => {
    await using view = await open('/control-island.html')
    // The server sends a render on open; the DOM must reflect it.
    const text = await waitFor(async () => {
      const t = await view.evaluate<string | undefined>("document.getElementById('ws-rendered')?.textContent")
      return t && t !== 'undefined' ? t : undefined
    })
    expect(text).toContain('Hello from WebSocket')
  }, 20_000)

  test('does not inject an @view-transition fallback (stylesheet feature removed)', async () => {
    // control-island.html ships no @view-transition rule. The controller no
    // longer injects one (the stylesheet-adoption feature is removed), so no
    // stylesheet — static or adopted — should contain the rule after connect.
    await using view = await open('/control-island.html')
    // Give any would-be injection time to run; the controller's connect path
    // is synchronous after the connect script loads.
    await sleep(500)
    const count = await view.evaluate<number>(
      "Array.from(document.styleSheets).concat(document.adoptedStyleSheets).reduce((n, s) => { try { return n + Array.from(s.cssRules).filter(r => r.cssText.includes('@view-transition')).length } catch { return n } }, 0)",
    )
    expect(Number(count)).toBe(0)
  }, 20_000)
})

// ─── Render swap modes ──────────────────────────────────────────────────────

describe('controller: render swap modes', () => {
  test('all six swap modes produce the correct DOM structure', async () => {
    await using view = await open('/test/swap-test')
    // The swap messages arrive as one burst on WS open; navigate() resolves
    // on load, which can precede the WS connect. Poll for the first applied
    // render before asserting (all six are applied in the same burst).
    await waitFor(
      async () =>
        (await view.evaluate<string | undefined>("document.getElementById('inner-result')?.textContent"))
          ? true
          : undefined,
      8000,
    )
    expect(await view.evaluate<string | undefined>("document.getElementById('inner-result')?.textContent")).toContain(
      'inner replaced',
    )
    expect(
      await view.evaluate<string | undefined>('document.querySelector(\'[b-target="main"]\')?.firstElementChild?.id'),
    ).toContain('afterbegin-result')
    expect(
      await view.evaluate<string | undefined>('document.querySelector(\'[b-target="main"]\')?.lastElementChild?.id'),
    ).toContain('beforeend-result')
    expect(
      await view.evaluate<string | undefined>("document.getElementById('afterend-result')?.textContent"),
    ).toContain('after main')
    expect(
      await view.evaluate<string | undefined>("document.getElementById('beforebegin-result')?.textContent"),
    ).toContain('before main')
    expect(await view.evaluate<string | undefined>("document.getElementById('outer-result')?.textContent")).toContain(
      'outer replaced',
    )
  }, 15000)

  test('binds triggers on swapped-in fragments', async () => {
    // The action-test fixture renders a button with a b-trigger; clicking it
    // must emit a ui_event the server receives and acknowledge with a render.
    await using view = await open('/test/action-test')
    await waitFor(async () => {
      const has = await view.evaluate<boolean>("!!document.getElementById('test-btn')")
      return has ? true : undefined
    }, 5000)
    await view.evaluate<void>("document.getElementById('test-btn').click()")
    await waitFor(() => Promise.resolve(getFixture().uiEvents.find((e) => e.source === 'action-test')), 5000)
    const ev = getFixture().uiEvents.find((e) => e.source === 'action-test')
    expect((ev?.message as { detail?: { event?: { type?: string } } })?.detail?.event?.type).toBe('test_click')
  }, 20000)
})

// ─── Attrs handler ───────────────────────────────────────────────────────────

describe('controller: attrs handler', () => {
  test('sets string, removes null, toggles boolean, coerces number', async () => {
    await using view = await open('/test/attrs-test')
    const sel = "document.querySelector('[b-target=main]')"
    await waitFor(async () => {
      const cls = await view.evaluate<string | undefined>(`${sel}?.getAttribute('class')`)
      return cls?.includes('active') ? true : undefined
    }, 5000)
    expect(await view.evaluate<string | undefined>(`${sel}?.getAttribute('class')`)).toContain('active')
    expect(await view.evaluate<boolean | undefined>(`${sel}?.hasAttribute('data-removable')`)).toBe(false)
    expect(await view.evaluate<boolean | undefined>(`${sel}?.hasAttribute('disabled')`)).toBe(true)
    expect(await view.evaluate<string | undefined>(`${sel}?.getAttribute('data-count')`)).toBe('42')
  }, 15000)
})

// ─── All-matches targeting (querySelectorAll) ──────────────────────────────

describe('controller: all-matches targeting', () => {
  test('attrs applies to every element with the matching b-target', async () => {
    // attrs-multi ships three [b-target="card"]; one attrs command must set the
    // class on all of them (querySelectorAll, not querySelector first-match).
    await using view = await open('/test/attrs-multi')
    await waitFor(async () => {
      const n = await view.evaluate<number>(
        "Array.from(document.querySelectorAll('[b-target=card]')).filter(el => el.classList.contains('active')).length",
      )
      return n === 3 ? n : undefined
    }, 10_000)
    const count = await view.evaluate<number>(
      "Array.from(document.querySelectorAll('[b-target=card]')).filter(el => el.classList.contains('active')).length",
    )
    expect(count).toBe(3)
  }, 20_000)

  test('render (innerHTML) applies to every element with the matching b-target', async () => {
    // render-multi ships two [b-target="slot"]; an innerHTML render must
    // replace the inner content of both, not just the first.
    await using view = await open('/test/render-multi')
    await waitFor(async () => {
      const n = await view.evaluate<number>(
        "Array.from(document.querySelectorAll('[b-target=slot]')).filter(el => el.textContent?.includes('filled')).length",
      )
      return n === 2 ? n : undefined
    }, 10_000)
    const count = await view.evaluate<number>(
      "Array.from(document.querySelectorAll('[b-target=slot]')).filter(el => el.textContent?.includes('filled')).length",
    )
    expect(count).toBe(2)
  }, 20_000)

  test('match param (^=) targets every element whose b-target starts with the prefix', async () => {
    // render-prefix ships [b-target="user-name"], [b-target="user-email"],
    // and [b-target="other"]. A render with match='^=' and target='user' must
    // fill the two user-* slots and leave 'other' untouched.
    await using view = await open('/test/render-prefix')
    await waitFor(async () => {
      const n = await view.evaluate<number>(
        "Array.from(document.querySelectorAll('[b-target^=user]')).filter(el => el.textContent?.includes('hi')).length",
      )
      return n === 2 ? n : undefined
    }, 10_000)
    const filled = await view.evaluate<number>(
      "Array.from(document.querySelectorAll('[b-target^=user]')).filter(el => el.textContent?.includes('hi')).length",
    )
    expect(filled).toBe(2)
    const other = await view.evaluate<string | undefined>("document.querySelector('[b-target=other]')?.textContent")
    expect(other).toContain('untouched')
  }, 20_000)
})

// ─── dispatch_custom_event handler ───────────────────────────────────────────

describe('controller: dispatch_custom_event handler', () => {
  test('dispatches a CustomEvent on the target with detail', async () => {
    await using view = await open('/test/dispatch-test')
    const detail = await waitFor(async () => {
      const d = await view.evaluate<string | undefined>('window.__pingDetail')
      return d && d !== 'null' && d !== 'undefined' ? d : undefined
    }, 5000)
    expect(detail).toContain('ok')
    expect(detail).toContain('true')
  }, 15000)
})

// ─── Navigate handler ────────────────────────────────────────────────────────

describe('controller: navigate handler', () => {
  test('navigates the browser to the given url via assign', async () => {
    await using view = await open('/test/navigate-test')
    // The server sends a navigate to /test/swap-test; the browser must follow it.
    const url = await waitFor(async () => {
      const u = await view.evaluate<string>('window.location.pathname')
      return u?.includes('swap-test') ? u : undefined
    }, 5000)
    expect(url).toContain('/test/swap-test')
  }, 15000)
})

// ─── b-trigger routing ──────────────────────────────────────────────────────

describe('controller: b-trigger routing', () => {
  test('click emits a ui_event with the action type and element attributes', async () => {
    await using view = await open('/test/action-test')
    await waitFor(async () => {
      const has = await view.evaluate<boolean>("!!document.getElementById('test-btn')")
      return has ? true : undefined
    }, 5000)
    const before = getFixture().uiEvents.filter((e) => e.source === 'action-test').length
    await view.evaluate<void>("document.getElementById('test-btn').click()")
    const ev = await waitFor(
      () =>
        Promise.resolve(
          getFixture()
            .uiEvents.filter((e) => e.source === 'action-test')
            .slice(before)
            .find((e) => (e.message.detail as { event?: { type?: string } }).event?.type === 'test_click'),
        ),
      5000,
    )
    const detail = ev.message.detail as { event?: { type?: string; detail?: Record<string, unknown> } }
    expect(detail.event?.type).toBe('test_click')
    // The trigger detail carries the element's attributes.
    expect(detail.event?.detail?.['b-trigger']).toBe('click:test_click')
    expect(detail.event?.detail?.id).toBe('test-btn')
  }, 20000)

  test('a semicolon-separated two-pair b-trigger binds each pair to its own DOM event', async () => {
    await using view = await open('/test/trigger-pairs')
    await waitFor(async () => {
      const has = await view.evaluate<boolean>("!!document.getElementById('pair-btn')")
      return has ? true : undefined
    }, 5000)
    await view.evaluate<void>("document.getElementById('pair-btn').click()")
    const click = await waitFor(
      () =>
        Promise.resolve(
          getFixture()
            .uiEvents.filter((e) => e.source === 'trigger-pairs')
            .find((e) => (e.message.detail as { event?: { type?: string } }).event?.type === 'pair_click'),
        ),
      5000,
    )
    void click
    await view.evaluate<void>("document.getElementById('pair-btn').dispatchEvent(new FocusEvent('focus'))")
    const focus = await waitFor(
      () =>
        Promise.resolve(
          getFixture()
            .uiEvents.filter((e) => e.source === 'trigger-pairs')
            .find((e) => (e.message.detail as { event?: { type?: string } }).event?.type === 'pair_focus'),
        ),
      5000,
    )
    void focus
  }, 20000)
})

describe('controller: render floors', () => {
  const errorByName = (name: string) =>
    getFixture()
      .errors.filter((e) => e.source === 'floors-test')
      .find((e) => (e.message.detail as { name?: string }).name === name)

  test('a fragment with a malformed b-trigger is rejected and never swapped in', async () => {
    await using view = await open('/test/floors-test')
    const error = await waitFor(() => Promise.resolve(errorByName('render_invalid_trigger')))
    expect((error.message.detail as { id?: string }).id).toBe('ft1')
    expect(await view.evaluate<boolean>("document.getElementById('bad-trigger-btn') === null")).toBe(true)
  }, 20000)

  test('a fragment carrying an on* attribute is rejected and never swapped in', async () => {
    await using view = await open('/test/floors-test')
    const error = await waitFor(() => Promise.resolve(errorByName('xss_vectors_detected')))
    expect((error.message.detail as { id?: string }).id).toBe('ft2')
    expect(await view.evaluate<boolean>("document.getElementById('on-attr-btn') === null")).toBe(true)
  }, 20000)

  test('an attrs update with a malformed b-trigger value is rejected and leaves the element unchanged', async () => {
    await using view = await open('/test/floors-test')
    const error = await waitFor(() => Promise.resolve(errorByName('update_trigger_attribute')))
    expect((error.message.detail as { id?: string }).id).toBe('ft3')
    expect(
      await view.evaluate<boolean>("document.querySelector('[b-target=main]').getAttribute('b-trigger') === null"),
    ).toBe(true)
  }, 20000)

  test('the attrs lane on* floor: an onclick key is rejected + reported, an innocent key around it applies', async () => {
    await using view = await open('/test/floors-test')
    // Report-and-skip: the on* key's error surfaces (the new error name)…
    const error = await waitFor(() => Promise.resolve(errorByName('on_star_attribute')))
    expect((error.message.detail as { id?: string }).id).toBe('ft4')
    // …no live handler attribute lands…
    expect(
      await view.evaluate<boolean>("document.querySelector('[b-target=main]').getAttribute('onclick') === null"),
    ).toBe(true)
    // …and the innocent key in the SAME message still applied.
    expect(await view.evaluate<string>("document.querySelector('[b-target=main]').getAttribute('style')")).toBe(
      '--design-x: 1;',
    )
  }, 20000)
})

// ─── Extensions ─────────────────────────────────────────────────────────────

describe('controller: the design-lane ownership pins (the #style-deletion ruling)', () => {
  test('an innerHTML swap PRESERVES the target root style attribute — replaceChildren never touches attributes', async () => {
    await using view = await open('/test/swap-preserve-test')
    // The attrs landed, then the fragment swapped in: the root's style
    // attribute survives the swap…
    const preserved = await waitFor(async () => {
      const v = await view.evaluate<string>("document.querySelector('[b-target=main]').getAttribute('style')")
      return v === '--design-keep: 1;' ? v : undefined
    })
    expect(preserved).toBe('--design-keep: 1;')
    // …the swapped content is live…
    expect(await view.evaluate<string>("document.getElementById('swapped-p')?.textContent ?? ''")).toBe('swapped')
    // …and the property still resolves inside the subtree (inherited).
    const color = await view.evaluate<string>(
      "getComputedStyle(document.getElementById('swapped-p')).getPropertyValue('--design-keep')",
    )
    expect(color.trim()).toBe('1')
  }, 20_000)

  test('a fragment scoped style rides the render lane — the prelude-less inline-form @scope applies within the target', async () => {
    await using view = await open('/test/floors-test')
    const scoped = await waitFor(async () => {
      const v = await view.evaluate<string>(
        "getComputedStyle(document.getElementById('scoped-p')).getPropertyValue('--design-scoped')",
      )
      return v && v.trim() !== '' ? v : undefined
    })
    expect(scoped.trim()).toBe('rebeccapurple')
    // Scope confinement: the page root resolves nothing.
    const page = await view.evaluate<string>("getComputedStyle(document.body).getPropertyValue('--design-scoped')")
    expect(page.trim()).toBe('')
  }, 20_000)
})

describe('controller: extensions', () => {
  test('extension module is invoked for its matching b-trigger and triggers a BP event', async () => {
    // module-fixture's buttons are static HTML, so DOM presence does not prove
    // the connect module has bound its delegated listener. The controller's
    // WebSocket connects inside connect() right after #bind, so a fresh
    // module-fixture connection observed by the fixture proves binding is
    // done — otherwise the click can fire before the listener exists and be
    // lost (a race the old harness's CLI round-trip latency masked). The
    // connection count is snapshotted BEFORE the view is created: under the
    // chrome backend the WS handshake can complete before the load event
    // resolves, so a snapshot taken after open() would already include this
    // page's connection and the >-before wait would never fire.
    const beforeConnections = getFixture().connections.filter((c) => c.source === 'module-fixture').length
    await using view = await open('/module-fixture.html')
    await waitFor(
      () =>
        Promise.resolve(
          getFixture().connections.filter((c) => c.source === 'module-fixture').length > beforeConnections
            ? true
            : undefined,
        ),
      5000,
    )
    await view.evaluate<void>("document.getElementById('module-ext-btn').click()")
    const ev = await waitFor(
      () => Promise.resolve(getFixture().uiEvents.find((e) => e.source === 'module-fixture')),
      5000,
    )
    // The extension received the DOM event (a click on module-ext-btn) and the
    // trigger fn — the full { event, trigger } extension contract — and used
    // them to emit a BP event carrying the element's id.
    const detail = ev.message.detail as { event?: { type?: string; detail?: Record<string, unknown> } }
    expect(detail.event?.type).toBe('extension_action')
    expect(detail.event?.detail?.id).toBe('module-ext-btn')
  }, 20000)

  test('standard b-trigger still emits a BP event alongside extensions', async () => {
    // Same readiness wait as above (snapshot before open): the fresh
    // module-fixture connection proves the delegated listener is bound before
    // the click.
    const beforeConnections = getFixture().connections.filter((c) => c.source === 'module-fixture').length
    await using view = await open('/module-fixture.html')
    await waitFor(
      () =>
        Promise.resolve(
          getFixture().connections.filter((c) => c.source === 'module-fixture').length > beforeConnections
            ? true
            : undefined,
        ),
      5000,
    )
    await view.evaluate<void>("document.getElementById('module-b-trigger-btn').click()")
    const ev = await waitFor(
      () =>
        Promise.resolve(
          getFixture().uiEvents.find(
            (e) =>
              e.source === 'module-fixture' &&
              (e.message.detail as { event?: { type?: string } }).event?.type === 'test_click',
          ),
        ),
      5000,
    )
    expect(ev).toBeDefined()
  }, 20000)
})

// ─── Form submit ────────────────────────────────────────────────────────────

describe('controller: form submit', () => {
  test('POSTs the form data to the server with the b-form-trigger header', async () => {
    await using view = await open('/test/form-test')
    await waitFor(async () => {
      const has = await view.evaluate<boolean>("!!document.getElementById('controller-form')")
      return has ? true : undefined
    }, 5000)
    await view.evaluate<void>("document.querySelector('#controller-form button[type=submit]').click()")
    const post = await waitFor(() => Promise.resolve(getFixture().formPosts.at(-1)), 5000)
    expect(post.trigger).toBe('register')
    expect(post.body.name).toBe('Ada')
    expect(post.body.tags).toEqual(['ui', 'controller'])
  }, 20000)
})

// ─── WebSocket retry ────────────────────────────────────────────────────────

describe('controller: WebSocket retry', () => {
  test('reconnects after a retryable close code and renders on the retried connection', async () => {
    // Backend note: the webkit backend would NOT pass this — WKWebView maps a
    // server-initiated close with code 1012 (and 1013) to close code 1005
    // (wasClean: true), which the controller's retry set {1006, 1012, 1013}
    // never observes, so the retried connection would never be established.
    // The chrome backend forwards 1012 verbatim — one reason this harness
    // forces `backend: { type: 'chrome' }` everywhere (matching Linux CI,
    // where webkit is unavailable).
    await using view = await open('/test/retry-test')
    const text = await waitFor(async () => {
      const t = await view.evaluate<string | undefined>("document.getElementById('retry-success')?.textContent")
      return t && t !== 'undefined' ? t : undefined
    }, 10000)
    expect(text).toContain('Reconnected')
  }, 20000)
})

// ─── Error reporting & success acks ─────────────────────────────────────────

describe('controller: error reporting & success acks', () => {
  test('acks a successful server message with a success envelope', async () => {
    // attrs-test sends 4 attrs messages, each acked. The view is held open
    // (WS + page events alive) until the server-side waits below settle.
    await using view = await open('/test/attrs-test')
    void view
    await waitFor(() => Promise.resolve(getFixture().successes.find((s) => s.source === 'attrs-test')), 8000)
    const acks = getFixture().successes.filter((s) => s.source === 'attrs-test')
    expect(acks.length).toBeGreaterThanOrEqual(1)
  }, 15000)

  test('server receives a snapshot on pageshow', async () => {
    // View is held open (WS + page events alive) for the server-side waits
    // below.
    await using view = await open('/test/lifecycle-test')
    void view
    // Backend note: the webkit backend would NOT pass this — WKWebView fires
    // pageshow during a deferred module's top-level await (it does not wait for
    // module TLA completion the way Chromium does), so the controller's page
    // listeners (registered after the connect module's TLA) miss the first
    // document's pageshow. Chromium fires pageshow after deferred module
    // evaluation completes, which is where this harness runs.
    const snap = await waitFor(
      () => Promise.resolve(getFixture().snapshots.find((s) => s.source === 'lifecycle-test')),
      5000,
    )
    expect((snap.message.detail as { type?: string }).type).toBe('pageshow')
    // The stylesheet-adoption feature is removed; snapshots no longer carry
    // adoptedStyleSheets (only serializedHTML). Guard the schema contract.
    expect((snap.message.detail as { adoptedStyleSheets?: unknown }).adoptedStyleSheets).toBeUndefined()
  }, 15000)
})

describe('controller: the attrs style lane (the #style-deletion ruling)', () => {
  test('ui_attrs style applies inline on the target — the subtree inherits the custom property, idempotently', async () => {
    await using view = await open('/test/attrs-style-test')
    // The style attribute applied INLINE on the target root; the descendant
    // inherits the custom property through CSS custom properties.
    const color = await waitFor(async () => {
      const c = await view.evaluate<string | undefined>(
        "getComputedStyle(document.getElementById('styled')).getPropertyValue('--design-colors-primary')",
      )
      return c && c.trim() !== '' ? c : undefined
    })
    expect(color.trim()).toBe('rebeccapurple')
    // The OWNERSHIP CONVENTION: setAttribute('style', …) replaced the WHOLE
    // attribute (updateAttributes) — the target root's style attribute is
    // the design lane's, exactly the tenant declarations, no stack.
    const inline = await view.evaluate<string>("document.querySelector('[b-target=main]').getAttribute('style')")
    expect(inline.trim()).toBe('--design-colors-primary: rebeccapurple;')
    // Idempotent: two identical ui_attrs messages replaced, never stacked.
    expect(inline.split('--design-colors-primary')).toHaveLength(2)
    // Scope isolation by ownership: the style lives ON the target root — a
    // sibling target resolves nothing.
    const sibling = await view.evaluate<string>(
      "getComputedStyle(document.body).getPropertyValue('--design-colors-primary')",
    )
    expect(sibling.trim()).toBe('')
  }, 20_000)
})

describe('controller: scaleCheck handler', () => {
  test('into target without own b-scale inherits nearest ancestor scale', async () => {
    await using view = await open('/test/scale-check-test')
    void view
    const result = await waitFor(
      () => Promise.resolve(getFixture().scaleCheckResults.find((s) => s.source === 'scale-check-test')),
      8000,
    )
    expect((result.message.detail as { effectiveScale: string }).effectiveScale).toBe('s3')
  }, 15000)

  test('outerHTML uses parent scale, ignores target own b-scale', async () => {
    await using view = await open('/test/scale-check-parent-test')
    void view
    const result = await waitFor(
      () => Promise.resolve(getFixture().scaleCheckResults.find((s) => s.source === 'scale-check-parent-test')),
      8000,
    )
    expect((result.message.detail as { effectiveScale: string }).effectiveScale).toBe('s5')
  }, 15000)
})
