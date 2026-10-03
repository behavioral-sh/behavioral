/**
 * Fixture server for the composition-worker WebView spec (rewire slice 2).
 *
 * Serves the composition DEDICATED worker (module script, level 1; the
 * amended topology, pilot ruling 2026-09-28) wired with the fixture actuator
 * lane, plus two pages:
 *   - `/composition.html` — the real CONTROLLER attach: the page boots the
 *     composition worker and constructs the bundled controller with a
 *     `WorkerTransport` over it (the transport-seam pattern), then extension
 *     buttons trigger a real `store_request` / `system_two_request` ingress.
 *   - `/iso.html?space=…` — the space-per-tab pin: a per-tab composition with
 *     an explicit space; the page exposes `__triggerStore` for deterministic
 *     isolation assertions (two tabs = two workers, no shared engine).
 *
 * Every response carries COOP/COEP (`crossOriginIsolated` — the engine's jq
 * bridge needs it). Bundles are built browser-target lazily, after the port
 * is known. The faculty workers the composition spawns resolve to
 * `/faculties/*.faculty.ts` (the composition bundle sits at the root) and are
 * served as bundled CLASSIC-safe artifacts; the jq worker + wasm ride the
 * same rule; the Open Responses stub answers the systemTwo round-trip
 * same-origin (no CORS surface).
 */

const FIXTURES_DIR = import.meta.dir
const SRC_ROOT = `${FIXTURES_DIR}/../../..`
const REPO_ROOT = `${FIXTURES_DIR}/../../../..`

/** COOP/COEP on everything — the SAB + Atomics bridge needs the isolation. */
const withIsolation = (response: Response): Response => {
  response.headers.set('cross-origin-opener-policy', 'same-origin')
  response.headers.set('cross-origin-embedder-policy', 'require-corp')
  return response
}

const bundleBrowser = async (entrySource: string): Promise<string> => {
  const entryPath = '/virtual-entry.ts'
  const { outputs, logs, success } = await Bun.build({
    entrypoints: [entryPath],
    files: { [entryPath]: entrySource },
    minify: false,
    splitting: false,
    target: 'browser',
  })
  if (!success) throw new AggregateError(logs, 'Failed to bundle browser fixture')
  return await outputs[0]!.text()
}

/** The canned Open Responses body — the completed message item + usage subset. */
const openResponsesBody = {
  id: 'resp_fixture_001',
  object: 'response',
  created_at: 1734366691,
  status: 'completed',
  model: 'fixture-model',
  output: [
    {
      id: 'msg_fixture_001',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello from fixture' }],
    },
  ],
  usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  error: null,
}

export const startCompositionServer = async (port = 0) => {
  const routes = new Map<string, () => Promise<{ body: BodyInit; contentType: string }>>()
  const built = new Map<string, Promise<{ body: BodyInit; contentType: string }>>()
  const route = (path: string, build: () => Promise<{ body: BodyInit; contentType: string }>): void => {
    routes.set(path, build)
  }

  // 1. The composition worker — a module script (level 1 may be a module;
  //    every worker IT spawns is classic, served below).
  const compositionWorkerEntry = Bun.resolveSync('./composition.worker.ts', FIXTURES_DIR)
  route('/composition.worker.js', async () => ({
    body: await bundleBrowser(`import ${JSON.stringify(compositionWorkerEntry)}`),
    contentType: 'text/javascript',
  }))

  // 2. The fixture actuator worker — classic-safe (no imports).
  const echoWorkerEntry = Bun.resolveSync('./store-echo.worker.ts', FIXTURES_DIR)
  route('/store-echo.worker.js', async () => ({
    body: await bundleBrowser(`import ${JSON.stringify(echoWorkerEntry)}`),
    contentType: 'text/javascript',
  }))

  // 3. The fixed three faculty workers — the composition bundle's literals
  //    resolve to `/faculties/<entry>.faculty.ts` (the bundle sits at the
  //    root). Each served as a bundled single-file (classic-safe) artifact.
  for (const faculty of ['system-one', 'system-two', 'frontier-analysis']) {
    const entry = Bun.resolveSync(`./faculties/${faculty}.faculty.ts`, SRC_ROOT)
    route(`/faculties/${faculty}.faculty.ts`, async () => ({
      body: await bundleBrowser(`import ${JSON.stringify(entry)}`),
      contentType: 'text/javascript',
    }))
  }

  // 4. The jq worker at the literal URL the engine bundle references —
  //    `/jq.worker.ts`. Classic-safe: the jq-wasm browser build's
  //    `new URL('./build/jq.wasm', import.meta.url)` is rewritten to the
  //    absolute origin-relative path.
  const jqWorkerEntry = Bun.resolveSync('./behavioral/jq.worker.ts', SRC_ROOT)
  route('/jq.worker.ts', async () => {
    let body = await bundleBrowser(`import ${JSON.stringify(jqWorkerEntry)}`)
    body = body.replaceAll(
      'new URL("./build/jq.wasm", import.meta.url)',
      `new URL("/build/jq.wasm", "http://localhost/")`,
    )
    return { body, contentType: 'text/javascript' }
  })
  const wasmPath = Bun.resolveSync('./node_modules/jq-wasm/dist/build/jq.wasm', REPO_ROOT)
  route('/build/jq.wasm', async () => ({
    body: await Bun.file(wasmPath).bytes(),
    contentType: 'application/wasm',
  }))

  // 5. The Open Responses stub — the systemTwo round-trip's endpoint,
  //    same-origin (the faculty fetches it through the init-frame config).
  route('/responses', async () => ({ body: JSON.stringify(openResponsesBody), contentType: 'application/json' }))

  // 6. The controller page: WorkerTransport over a dedicated module Worker +
  //    the bundled controller constructed with it (the transport-seam
  //    pattern), extension buttons for deterministic ingress.
  const workerTransportEntry = Bun.resolveSync('./controller/worker-transport.ts', SRC_ROOT)
  const controllerEntry = Bun.resolveSync('./controller/controller.ts', SRC_ROOT)
  route('/composition-page.js', async () => ({
    body: await bundleBrowser(`
import { WorkerTransport } from ${JSON.stringify(workerTransportEntry)}
import { Controller } from ${JSON.stringify(controllerEntry)}

window.__traces = []
window.__workerError = null
const worker = new Worker('/composition.worker.js', { type: 'module' })
window.__raw = []
worker.addEventListener('message', (e) => { window.__raw.push(e.data) })
worker.onerror = (event) => {
  window.__workerError = String(event.message ?? event)
}
const transport = new WorkerTransport({
  worker,
  // The page's provider map: the attach frame carries it, the composition
  // boots with it, the faculties receive it as their init-frame payloads.
  models: { systemTwo: { openai: { url: location.origin } } },
  onHello: (frame) => {
    window.__hello = frame.identity
    window.__space = frame.space
  },
  onTrace: (trace) => { window.__traces.push(trace) },
})
window.__transport = transport

const extensions = new Map([
  ['click:store_request', (params) => {
    params.trigger({
      type: 'store_request',
      detail: { id: 'page_1', op: 'get', input: { collection: 'docs', key: 'a' } },
    })
  }],
  ['click:system_two_request', (params) => {
    params.trigger({
      type: 'system_two_request',
      detail: { id: 's2_1', input: { provider: 'openai', modelId: 'fixture-model', input: [] } },
    })
  }],
])
const controller = new Controller({ transport, extensions })
window.__controller = controller
controller.connect()
`),
    contentType: 'text/javascript',
  }))

  route('/composition.html', async () => ({
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script>window.__traces = []; window.__hello = null;</script>
    <script type="module" src="/composition-page.js"></script>
  </head>
  <body>
    <button id="store-btn" b-trigger="click:store_request">store</button>
    <button id="s2-btn" b-trigger="click:system_two_request">system two</button>
  </body>
</html>`,
    contentType: 'text/html',
  }))

  // 7. The isolation page: a per-tab composition (explicit space), the real
  //    WorkerTransport, and a deterministic store trigger the spec fires via
  //    evaluate. Two tabs = two workers — the isolation is structural.
  route('/iso.js', async () => ({
    body: await bundleBrowser(`
import { WorkerTransport } from ${JSON.stringify(workerTransportEntry)}

window.__traces = []
const worker = new Worker('/composition.worker.js', { type: 'module' })
const transport = new WorkerTransport({
  worker,
  space: new URLSearchParams(location.search).get('space'),
  onHello: (frame) => {
    window.__space = frame.space
    window.__hello = frame.identity
  },
  onTrace: (trace) => { window.__traces.push(trace) },
})
window.__transport = transport
window.__triggerStore = (id, key) => {
  transport.send({
    type: 'ui_event',
    detail: {
      event: { type: 'store_request', detail: { id, op: 'get', input: { collection: 'docs', key } } },
      timeStamp: 0,
    },
  })
}
`),
    contentType: 'text/javascript',
  }))

  route('/iso.html', async () => ({
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script type="module" src="/iso.js"></script>
  </head>
  <body></body>
</html>`,
    contentType: 'text/html',
  }))

  route('/health', async () => ({ body: 'ok', contentType: 'text/plain' }))

  const server = Bun.serve({
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/responses') {
        return withIsolation(
          new Response(JSON.stringify(openResponsesBody), { headers: { 'content-type': 'application/json' } }),
        )
      }
      const build = routes.get(path)
      if (build) {
        let cached = built.get(path)
        if (!cached) {
          cached = build()
          built.set(path, cached)
        }
        const artifact = await cached
        return withIsolation(new Response(artifact.body, { headers: { 'content-type': artifact.contentType } }))
      }
      return withIsolation(new Response('not found', { status: 404 }))
    },
  })

  return { server, port: server.port!, stop: () => server.stop(true) }
}
