/**
 * Fixture server for the bundle gate's level 2 (the WebView probe): every
 * faculty entry's CLASSIC bundle boots in the real WebView and round-trips —
 * the shelf's nested-module-workers finding lives in exactly this layer (the
 * composition spawns its faculty workers CLASSIC: `new Worker(url)` with no
 * `type: 'module'`, so the served artifact must be a classic-safe
 * single-file script; Bun's browser build silently shims node builtins, so
 * the only honest check is to run the artifact in the WebView).
 *
 * Serves each faculty entry bundled browser-target plus one probe page that
 * spawns a CLASSIC worker per entry and round-trips the init frame + one
 * request (the same requests the level-1 gate pins).
 */

const FIXTURES_DIR = import.meta.dir
const SRC_ROOT = `${FIXTURES_DIR}/../../..`

/** COOP/COEP on everything — the engine's SAB bridge needs the isolation. */
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

/** The faculty entries + the one request each answers (the level-1 gate's pins). */
const ENTRIES: Array<{ name: string; request: Record<string, unknown>; resultKind: string }> = [
  {
    name: 'system-one',
    request: {
      type: 'system_one_request',
      detail: { id: 'l2_1', input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } } },
    },
    resultKind: 'system_one_request_result',
  },
  {
    name: 'system-two',
    request: {
      type: 'system_two_request',
      detail: { id: 'l2_2', input: { provider: 'missing', modelId: 'm', input: [] } },
    },
    resultKind: 'system_two_request_result',
  },
  {
    name: 'frontier-analysis',
    request: { type: 'frontier_analysis_request', detail: { id: 'l2_3', op: 'replay', input: { threads: [] } } },
    resultKind: 'frontier_analysis_request_result',
  },
]

export const startBundleGateServer = async (port = 0) => {
  const routes = new Map<string, () => Promise<{ body: BodyInit; contentType: string }>>()
  const built = new Map<string, Promise<{ body: BodyInit; contentType: string }>>()
  const route = (path: string, build: () => Promise<{ body: BodyInit; contentType: string }>): void => {
    routes.set(path, build)
  }

  // The faculty bundles — classic-safe single-file artifacts (no imports, no
  // `import.meta` dependencies at the top level: the composition spawns them
  // CLASSIC).
  for (const entry of ENTRIES) {
    const source = Bun.resolveSync(`./faculties/${entry.name}.faculty.ts`, SRC_ROOT)
    route(`/faculties/${entry.name}.bundle.js`, async () => ({
      body: await bundleBrowser(`import ${JSON.stringify(source)}`),
      contentType: 'text/javascript',
    }))
  }

  // The probe page: one CLASSIC worker per entry; the init frame + the
  // request ride back-to-back (the init frame arrives first — the worker's
  // message queue orders it); results collect into `window.__results`.
  const entriesJson = JSON.stringify(ENTRIES)
  route('/probe.js', async () => ({
    body: await bundleBrowser(`
const entries = ${entriesJson}
window.__results = {}
window.__errors = {}
window.__classic = true
for (const entry of entries) {
  // NO { type: 'module' } — the CLASSIC spawn is the point: this is the
  // worker shape the composition's useWorker literals produce.
  const worker = new Worker('/faculties/' + entry.name + '.bundle.js')
  worker.onerror = (event) => { window.__errors[entry.name] = String(event.message ?? event) }
  worker.onmessage = (event) => {
    if (event.data && event.data.type === entry.resultKind) window.__results[entry.name] = event.data
  }
  worker.postMessage({ kind: 'init', data: {} })
  worker.postMessage(entry.request)
}
`),
    contentType: 'text/javascript',
  }))

  route('/probe.html', async () => ({
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script type="module" src="/probe.js"></script>
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
