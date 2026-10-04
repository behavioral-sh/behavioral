/**
 * Composition-worker WebView spec (rewire slice 2).
 *
 * The headline: `bProgram` boots INSIDE a per-tab dedicated worker — the
 * composition is the browser's level-1 worker (the amended topology, pilot
 * ruling 2026-09-28). A real page attaches via the `WorkerTransport` (the
 * injectable Transport seam), the composition's engine identity arrives in
 * the port hello (the page's space minted at attach), the page's provider
 * map rides the attach frame into the faculties' init-frame payloads (a real
 * systemTwo round-trips through its bundled worker + the fixture endpoint),
 * a fixture actuator lane built through the REAL `useWorker` primitive
 * round-trips the real store wire, and two tabs are two WORKERS — distinct
 * instanceIds, no cross-tab trace.
 *
 * Harness: the controller.spec patterns — a Bun.WebView (chrome backend,
 * headless), warm-up in beforeAll, one evaluate in flight, COOP/COEP on the
 * fixture server. Real pages, real workers, no mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startCompositionServer } from './fixtures/composition-serve.ts'

let server: Awaited<ReturnType<typeof startCompositionServer>> | undefined
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
  server = await startCompositionServer(0)
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

describe('composition worker: bProgram boots in a per-tab dedicated worker (the amended ruling)', () => {
  test('a real page attaches over the WorkerTransport — the port hello carries the engine identity + minted space', async () => {
    await using view = await open('/composition.html')
    const hello = await waitFor(async () => {
      const state = await view.evaluate<Record<string, unknown> | undefined>('window.__hello')
      return state !== undefined && state !== null ? state : undefined
    })
    // The composition's REAL engine identity said hello over the port.
    expect(typeof hello.instanceId).toBe('string')
    expect((hello.instanceId as string).startsWith('bp_')).toBe(true)
    expect(typeof hello.sessionId).toBe('string')
    // The space-per-tab mapping: the attach minted this composition's space.
    expect((await view.evaluate<string>('window.__space')).startsWith('tab_')).toBe(true)
    // No worker-level failure surfaced during the boot.
    expect(await view.evaluate<unknown>('window.__workerError')).toBeNull()
  }, 30_000)

  test('a store_request ingresses and the fixture worker-lane actuator round-trips the real store wire', async () => {
    await using view = await open('/composition.html')
    // Wait for attach first (the controller connects during load).
    await waitFor(async () => {
      const hello = await view.evaluate<Record<string, unknown> | undefined>('window.__hello')
      return hello !== undefined && hello !== null ? hello : undefined
    })
    // The extension button triggers a real store_request through the
    // controller's ui_event ingress; the composition routes it to the
    // worker-lane store actuator; the result re-enters and fans out as a
    // redacted selection trace on the port.
    await view.evaluate<void>('document.getElementById("store-btn").click()')
    const result = await waitFor(async () => {
      const selected = (await selections(view)).find(
        (t) => (t.selected as { type?: string } | undefined)?.type === 'store_request_result',
      )
      return selected === undefined ? undefined : selected
    })
    const detail = (result.selected as { detail?: Record<string, unknown> }).detail
    expect(detail?.id).toBe('page_1')
    expect(detail?.ok).toBe(true)
    // The echo worker answered with the request input as the result payload.
    expect(detail?.result).toEqual({ collection: 'docs', key: 'a' })
  }, 30_000)

  test('the attach frame\u2019s models ride the init frame — a real systemTwo worker round-trips the fixture endpoint', async () => {
    await using view = await open('/composition.html')
    await waitFor(async () => {
      const hello = await view.evaluate<Record<string, unknown> | undefined>('window.__hello')
      return hello !== undefined && hello !== null ? hello : undefined
    })
    // The page's provider map became the faculty's init-frame payload at
    // boot; the systemTwo worker spawns on the first send, boots with the
    // endpoints, and fetches the same-origin fixture stub.
    await view.evaluate<void>('document.getElementById("s2-btn").click()')
    const result = await waitFor(async () => {
      const selected = (await selections(view)).find(
        (t) => (t.selected as { type?: string } | undefined)?.type === 'system_two_request_result',
      )
      return selected === undefined ? undefined : selected
    })
    const detail = (result.selected as { detail?: Record<string, unknown> }).detail
    expect(detail?.id).toBe('s2_1')
    // The REAL faculty answered: the Open Responses fixture's completed
    // assistant message arrived as the result items.
    expect(detail?.ok).toBe(true)
    const items = (detail?.result as { items?: Array<{ type?: string }> } | undefined)?.items
    expect(items?.[0]?.type).toBe('message')
  }, 30_000)

  test('the boot reconciliation pack mounts BROWSER-SIDE — the boot completes, not hangs', async () => {
    // THE NAMED-NEED'S RE-EVALUATION (the transform-faculty ruling): the
    // thread-persistence landing held the reconcile pack DAEMON-ONLY because
    // the bundled artifact lacked the nested jq-worker asset (the boot
    // transforms hung ~30s in Atomics.wait). With the transform faculty
    // bundled and self-contained, the pack's joins evaluate through the
    // fixed fourth lane — the registry read resolves and the reconciliation
    // proceeds within seconds, against the echo store (no registry record →
    // no mounts, the boot completes).
    await using view = await open('/composition-reconcile.html')
    // No worker-level error: the composition (with the pack) booted clean.
    await waitFor(async () => await view.evaluate<string | undefined>('window.__space'))
    expect(await view.evaluate<string | undefined>('window.__workerError')).toBeNull()
    // The reconcile's registry read selected — the pack's join transforms
    // ran through the bundled transform faculty (the read resolves, the
    // boot settles; the OLD failure was a ~30s hang before this selection
    // ever appeared).
    const read = await waitFor(async () => {
      const seen = (await selections(view)).find((t) => {
        const selected = t.selected as { type?: string; detail?: { input?: { collection?: string } } }
        return selected?.type === 'store_request' && selected.detail?.input?.collection === 'plugin-threads'
      })
      return seen
    }, 15_000)
    expect(read).toBeDefined()
  })

  test('tab A and tab B are SEPARATE workers (the per-tab ruling): pinned spaces, own traces, no cross-leak', async () => {
    await using viewA = await open('/iso.html?space=tab_a')
    await using viewB = await open('/iso.html?space=tab_b')
    // Each tab's composition pinned its space.
    expect(await waitFor(async () => await viewA.evaluate<string | undefined>('window.__space'))).toBe('tab_a')
    expect(await waitFor(async () => await viewB.evaluate<string | undefined>('window.__space'))).toBe('tab_b')
    // The per-tab ruling, pinned: two tabs = two ENGINES — different instance
    // ids, no shared composition.
    const idA = await waitFor(async () => {
      const hello = await viewA.evaluate<{ instanceId?: string } | undefined>('window.__hello')
      return hello?.instanceId
    })
    const idB = await waitFor(async () => {
      const hello = await viewB.evaluate<{ instanceId?: string } | undefined>('window.__hello')
      return hello?.instanceId
    })
    expect(idA).not.toBe(idB)

    // Tab A triggers; tab A sees its own selection trace, space-stamped...
    await viewA.evaluate<void>('window.__triggerStore("a_req", "a")')
    const aTrace = await waitFor(async () => {
      const seen = (await selections(viewA)).find(
        (t) => (t.selected as { detail?: { id?: string } }).detail?.id === 'a_req',
      )
      return seen
    })
    expect((aTrace.selected as { space?: string }).space).toBe('tab_a')

    // ...tab B (a different worker) never sees it.
    expect(
      (await selections(viewB)).some((t) => (t.selected as { detail?: { id?: string } }).detail?.id === 'a_req'),
    ).toBe(false)

    // Tab B triggers; tab B sees its own (space tab_b), tab A does not.
    await viewB.evaluate<void>('window.__triggerStore("b_req", "b")')
    const bTrace = await waitFor(async () => {
      const seen = (await selections(viewB)).find(
        (t) => (t.selected as { detail?: { id?: string } }).detail?.id === 'b_req',
      )
      return seen
    })
    expect((bTrace.selected as { space?: string }).space).toBe('tab_b')
    expect(
      (await selections(viewA)).some((t) => (t.selected as { detail?: { id?: string } }).detail?.id === 'b_req'),
    ).toBe(false)
  }, 40_000)
})
