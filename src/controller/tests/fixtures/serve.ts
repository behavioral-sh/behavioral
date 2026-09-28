/**
 * Fixture server for the real-browser controller suite.
 *
 * Serves static HTML pages that load the bundled controller, a WebSocket that
 * drives each test page with scripted server messages, and an HTTP POST
 * endpoint for form submissions. Captures client messages (ui_event, error,
 * success, snapshot) and form POSTs for assertions.
 */
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { B_TRIGGER } from '../../controller.constants.ts'
import { bundleController, CONNECT_BEHAVIORAL_ROUTE } from './bundle-controller.ts'

const FIXTURES_DIR = import.meta.dir
// The WS-carrier coverage: the fixture's pages construct the controller with
// the injected WebSocket carrier (the thin-GUI-client shape — the flipped
// default is the worker carrier, proven by the worker-transport webview probe).
const controllerRoutes = await bundleController({ carrier: 'websocket' })

const connectScript = (modules?: string[]) => {
  const params = new URLSearchParams()
  if (modules?.length) params.set('modules', modules.join(','))
  const qs = params.toString()
  return qs ? `${CONNECT_BEHAVIORAL_ROUTE}?${qs}` : CONNECT_BEHAVIORAL_ROUTE
}

// Build the extension module and serve its bundled output as a Response
// (no disk write — mirrors bundleController's build-to-Response pattern).
const MODULE_ROUTE = '/dist/modules/controller-module.js'
const moduleBuild = await Bun.build({
  entrypoints: [join(FIXTURES_DIR, 'controller-module.ts')],
  target: 'browser',
  minify: false,
})
if (!moduleBuild.success) {
  for (const log of moduleBuild.logs) console.error(log)
  throw new Error('Module build failed')
}
const moduleArtifact = moduleBuild.outputs[0]!
const moduleRoutes: Record<string, Response> = {
  [MODULE_ROUTE]: new Response(moduleArtifact, {
    headers: { 'Content-Type': 'application/javascript' },
  }),
}

// ─── Source identity: page path -> WebSocket source tag ─────────────────────

const PATH_TO_SOURCE: Record<string, string> = {}
const registerSource = (path: string, source: string) => {
  PATH_TO_SOURCE[path] = source
}
const resolveSource = (path: string): string => PATH_TO_SOURCE[path] ?? 'document'

// ─── Server message helpers ──────────────────────────────────────────────────

const renderMsg = (detail: Record<string, unknown>) => ({
  type: 'ui_render',
  detail: { swap: 'innerHTML', ...detail },
})
const attrsMsg = (detail: Record<string, unknown>) => ({ type: 'ui_attrs', detail })

// ─── Static HTML fixtures ────────────────────────────────────────────────────

const HTML_CONTROL_ISLAND = `<!DOCTYPE html><html><body>
  <div b-target="main"><p>initial content</p></div>
  <script type="module" src="${connectScript()}"></script>
</body></html>`

const HTML_SWAP_FIXTURE = `<!DOCTYPE html><html><body>
  <div b-target="main"><p>initial swap content</p></div>
  <script type="module" src="${connectScript()}"></script>
</body></html>`

const HTML_MODULE_FIXTURE = `<!DOCTYPE html><html><body>
  <div b-target="main">
    <button id="module-b-trigger-btn" data-extra="b-trigger-attr" b-trigger="click:test_click">Standard Trigger</button>
    <button id="module-ext-btn" data-extra="extension-listener" b-trigger="click:module_enhanced_action">Extension</button>
  </div>
  <script type="module" src="${connectScript(['/dist/modules/controller-module.js'])}"></script>
</body></html>`

// ─── Dynamic test pages ──────────────────────────────────────────────────────

const TEST_PAGE_CONTENT: Record<string, string> = {
  'swap-test': `<div b-target="main"><p id="original">original</p></div><div b-target="outer-target">outer original</div>`,
  'attrs-test': `<div b-target="main" data-removable="old-value"><p>attrs target</p></div>`,
  'attrs-multi': `<div b-target="card" id="c1">card1</div><div b-target="card" id="c2">card2</div><div b-target="card" id="c3">card3</div>`,
  'render-multi': `<div b-target="slot" id="s1">empty1</div><div b-target="slot" id="s2">empty2</div>`,
  'render-prefix': `<span b-target="user-name">name</span><span b-target="user-email">email</span><span b-target="other">untouched</span>`,
  'dispatch-test': `<div b-target="main"><p>dispatch target</p></div>`,
  'action-test': `<div b-target="main"><p>waiting for action</p></div>`,
  'trigger-pairs': `<div b-target="main"><p>waiting for pairs</p></div>`,
  'floors-test': `<div b-target="main"><p>waiting for floors</p></div>`,
  'form-test': `<div b-target="main"><p>waiting for form</p></div>`,
  'retry-test': `<div b-target="main"><p>connecting</p></div>`,
  'lifecycle-test': `<div b-target="main"><p>lifecycle</p></div>`,
  'navigate-test': `<div b-target="main"><p>navigate target</p></div>`,
  'scale-check-test': `<section b-scale="s5"><article b-scale="s3"><div b-target="slot">content</div></article></section>`,
  'scale-check-parent-test': `<section b-scale="s5"><span b-target="slot" b-scale="s1">content</span></section>`,
  'style-test': `<div b-target="main"><p id="styled">text</p></div>`,
}

// Inline scripts injected before the connect module, keyed by source tag.
// Used to install observers that must be in place before the WebSocket opens.
const TEST_PAGE_SCRIPT: Record<string, string> = {
  'dispatch-test': `<script>
    window.__pingDetail = null
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelector('[b-target="main"]').addEventListener('app:ping', function (e) {
        window.__pingDetail = JSON.stringify(e.detail)
      })
    })
  </script>`,
}

const generateTestPage = (source: string) => {
  const content = TEST_PAGE_CONTENT[source] ?? '<p>test content</p>'
  const inline = TEST_PAGE_SCRIPT[source] ?? ''
  registerSource(`/test/${source}`, source)
  return `<!DOCTYPE html><html><head><title>${source}</title></head><body>
  ${content}
  ${inline}
  <script type="module" src="${connectScript()}"></script>
</body></html>`
}

// ─── Scripted server message sequences ───────────────────────────────────────

const sendSwapMessages = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(
    JSON.stringify(
      renderMsg({ id: 's1', target: 'main', html: '<p id="inner-result">inner replaced</p>', swap: 'innerHTML' }),
    ),
  )
  ws.send(
    JSON.stringify(
      renderMsg({ id: 's2', target: 'main', html: '<span id="afterbegin-result">first</span>', swap: 'afterbegin' }),
    ),
  )
  ws.send(
    JSON.stringify(
      renderMsg({ id: 's3', target: 'main', html: '<span id="beforeend-result">last</span>', swap: 'beforeend' }),
    ),
  )
  ws.send(
    JSON.stringify(
      renderMsg({ id: 's4', target: 'main', html: '<span id="afterend-result">after main</span>', swap: 'afterend' }),
    ),
  )
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 's5',
        target: 'main',
        html: '<span id="beforebegin-result">before main</span>',
        swap: 'beforebegin',
      }),
    ),
  )
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 's6',
        target: 'outer-target',
        html: '<div id="outer-result" b-target="outer-target">outer replaced</div>',
        swap: 'outerHTML',
      }),
    ),
  )
}

const sendAttrsMessages = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(JSON.stringify(attrsMsg({ id: 'a1', target: 'main', attr: { class: 'active' } })))
  ws.send(JSON.stringify(attrsMsg({ id: 'a2', target: 'main', attr: { 'data-removable': null } })))
  ws.send(JSON.stringify(attrsMsg({ id: 'a3', target: 'main', attr: { disabled: true } })))
  ws.send(JSON.stringify(attrsMsg({ id: 'a4', target: 'main', attr: { 'data-count': 42 } })))
}

const sendAttrsMultiMessages = (ws: ServerWebSocket<{ source: string }>) => {
  // One attrs command against b-target="card" must apply to all three cards.
  ws.send(JSON.stringify(attrsMsg({ id: 'am1', target: 'card', attr: { class: 'active' } })))
}

const sendRenderMultiMessages = (ws: ServerWebSocket<{ source: string }>) => {
  // One innerHTML render against b-target="slot" must fill both slots.
  ws.send(JSON.stringify(renderMsg({ id: 'rm1', target: 'slot', html: 'filled', swap: 'innerHTML' })))
}

const sendRenderPrefixMessages = (ws: ServerWebSocket<{ source: string }>) => {
  // match='^=' targets every b-target starting with "user".
  ws.send(JSON.stringify(renderMsg({ id: 'rp1', target: 'user', html: 'hi', match: '^=', swap: 'innerHTML' })))
}

const sendDispatchMessages = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(
    JSON.stringify({
      type: 'ui_dispatch_custom_event',
      detail: { id: 'd1', target: 'main', event: { type: 'app:ping', detail: { ok: true } } },
    }),
  )
}

const sendTriggerPairsRender = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 'tp',
        target: 'main',
        html: '<button id="pair-btn" b-trigger="click:pair_click;focus:pair_focus">Two pairs</button>',
      }),
    ),
  )
}

const sendFloorsMessages = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 'ft1',
        target: 'main',
        html: '<button id="bad-trigger-btn" b-trigger="click">no colon pair</button>',
      }),
    ),
  )
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 'ft2',
        target: 'main',
        html: '<button id="on-attr-btn" onclick="alert(1)">bad</button>',
      }),
    ),
  )
  ws.send(JSON.stringify(attrsMsg({ id: 'ft3', target: 'main', attr: { 'b-trigger': 'focus' } })))
}

const sendActionInitialRender = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 'ar',
        target: 'main',
        html: '<button id="test-btn" b-trigger="click:test_click">Click me</button>',
      }),
    ),
  )
}

const sendFormInitialRender = (ws: ServerWebSocket<{ source: string }>) => {
  ws.send(
    JSON.stringify(
      renderMsg({
        id: 'fr',
        target: 'main',
        html: '<form id="controller-form" b-form="register" method="post"><input name="name" value="Ada"><input name="tags" value="ui"><input name="tags" value="controller"><button type="submit">Submit</button></form>',
      }),
    ),
  )
}

// ─── Server ──────────────────────────────────────────────────────────────────

/**
 * Handle to a running fixture server, exposing the underlying Bun server, the
 * bound port, a stop function, and captured client traffic arrays
 * (`uiEvents`, `errors`, `successes`, `snapshots`, `formPosts`) for assertions.
 */
export type FixtureServer = {
  server: ReturnType<typeof Bun.serve>
  port: number
  stop: () => Promise<void>
  /** One entry per accepted WebSocket connection, in arrival order. */
  connections: { source: string }[]
  uiEvents: { source: string; message: Record<string, unknown> }[]
  errors: { source: string; message: Record<string, unknown> }[]
  successes: { source: string; message: Record<string, unknown> }[]
  scaleCheckResults: { source: string; message: Record<string, unknown> }[]
  snapshots: { source: string; message: Record<string, unknown> }[]
  formPosts: { source: string; trigger: string; body: Record<string, unknown> }[]
}

/**
 * Starts the fixture HTTP + WebSocket server on the given port (0 picks a free
 * port) and returns a {@link FixtureServer} handle for driving tests and
 * asserting on captured client messages.
 */
export const startServer = (port = 0): FixtureServer => {
  const state = {
    connections: [] as { source: string }[],
    uiEvents: [] as { source: string; message: Record<string, unknown> }[],
    errors: [] as { source: string; message: Record<string, unknown> }[],
    successes: [] as { source: string; message: Record<string, unknown> }[],
    scaleCheckResults: [] as { source: string; message: Record<string, unknown> }[],
    snapshots: [] as { source: string; message: Record<string, unknown> }[],
    formPosts: [] as { source: string; trigger: string; body: Record<string, unknown> }[],
    retryConnections: 0,
  }

  registerSource('/control-island.html', 'test-island')
  registerSource('/swap-fixture.html', 'swap-fixture')
  registerSource('/module-fixture.html', 'module-fixture')

  const server = Bun.serve({
    port,
    routes: {
      '/health': new Response('OK'),
      '/control-island.html': new Response(HTML_CONTROL_ISLAND, { headers: { 'Content-Type': 'text/html' } }),
      '/swap-fixture.html': new Response(HTML_SWAP_FIXTURE, { headers: { 'Content-Type': 'text/html' } }),
      '/module-fixture.html': new Response(HTML_MODULE_FIXTURE, { headers: { 'Content-Type': 'text/html' } }),
      [CONNECT_BEHAVIORAL_ROUTE]: () => controllerRoutes[CONNECT_BEHAVIORAL_ROUTE]!.clone(),
      '/dist/*': (req) => {
        const route = moduleRoutes[new URL(req.url).pathname]
        return route ? route.clone() : new Response('Not Found', { status: 404 })
      },
    },
    websocket: {
      data: {} as { source: string },
      open(ws) {
        state.connections.push({ source: ws.data.source })
        switch (ws.data.source) {
          case 'swap-fixture':
            ws.send(
              JSON.stringify(
                renderMsg({
                  id: 'dsd',
                  target: 'main',
                  html: '<div id="dsd-host"><template shadowrootmode="open"><p>shadow content</p></template></div>',
                }),
              ),
            )
            break
          case 'module-fixture':
            break // buttons are in initial HTML; no render needed
          case 'swap-test':
            sendSwapMessages(ws)
            break
          case 'attrs-test':
            sendAttrsMessages(ws)
            break
          case 'attrs-multi':
            sendAttrsMultiMessages(ws)
            break
          case 'render-multi':
            sendRenderMultiMessages(ws)
            break
          case 'render-prefix':
            sendRenderPrefixMessages(ws)
            break
          case 'dispatch-test':
            sendDispatchMessages(ws)
            break
          case 'action-test':
            sendActionInitialRender(ws)
            break
          case 'trigger-pairs':
            sendTriggerPairsRender(ws)
            break
          case 'floors-test':
            sendFloorsMessages(ws)
            break
          case 'form-test':
            sendFormInitialRender(ws)
            break
          case 'navigate-test':
            ws.send(JSON.stringify({ type: 'ui_navigate', detail: { id: 'n1', url: '/test/swap-test' } }))
            break
          case 'scale-check-test':
            ws.send(
              JSON.stringify({
                type: 'ui_scale_check',
                detail: { id: 'sc1', target: 'slot', swap: 'innerHTML' },
              }),
            )
            break
          case 'scale-check-parent-test':
            ws.send(
              JSON.stringify({
                type: 'ui_scale_check',
                detail: { id: 'sc2', target: 'slot', swap: 'outerHTML' },
              }),
            )
            break
          case 'style-test':
            // The scoped style egress: the css arrives @scope-wrapped with
            // the target's b-target selector as the scope root; the
            // controller applies it verbatim. A SECOND message proves
            // idempotency (replace, not stack).
            ws.send(
              JSON.stringify({
                type: 'ui_style',
                detail: {
                  id: 'st1',
                  target: 'main',
                  css: '@scope ([b-target="main"]) {\n  :scope {\n    --design-colors-primary: rebeccapurple;\n  }\n}',
                },
              }),
            )
            ws.send(
              JSON.stringify({
                type: 'ui_style',
                detail: {
                  id: 'st2',
                  target: 'main',
                  css: '@scope ([b-target="main"]) {\n  :scope {\n    --design-colors-primary: rebeccapurple;\n  }\n}',
                },
              }),
            )
            break
          case 'retry-test': {
            state.retryConnections++
            if (state.retryConnections === 1) setTimeout(() => ws.close(1012, 'test retry'), 100)
            else
              ws.send(
                JSON.stringify(
                  renderMsg({ id: 'retry-ok', target: 'main', html: '<div id="retry-success">Reconnected!</div>' }),
                ),
              )
            break
          }
          case 'lifecycle-test':
            // No initial render; the test inspects snapshot/ui_event behavior.
            break
          default:
            ws.send(
              JSON.stringify(
                renderMsg({ id: 'r1', target: 'main', html: '<div id="ws-rendered">Hello from WebSocket</div>' }),
              ),
            )
        }
      },
      message(ws, message) {
        const data = JSON.parse(String(message))
        const entry = { source: ws.data.source, message: data }
        if (data.type === 'ui_error') state.errors.push(entry)
        else if (data.type === 'ui_event') {
          state.uiEvents.push(entry)
          if (data.detail?.event?.type === 'test_click') {
            ws.send(
              JSON.stringify(
                renderMsg({
                  id: 'action-confirmed',
                  target: 'main',
                  html: '<div id="action-confirmed">Action received</div>',
                }),
              ),
            )
          }
        } else if (data.type === 'ui_success') state.successes.push(entry)
        else if (data.type === 'ui_scale_check_result') state.scaleCheckResults.push(entry)
        else if (data.type === 'ui_snapshot') state.snapshots.push(entry)
      },
      close() {},
    },
    async fetch(req, server) {
      // Form POST — the controller POSTs to window.location.href with a
      // b-form-trigger header carrying the form's b-form value.
      if (req.method === 'POST') {
        const trigger = req.headers.get(B_TRIGGER)
        if (trigger) {
          const form = await req.formData()
          const body: Record<string, unknown> = {}
          for (const [key, value] of form.entries()) {
            if (key in body) {
              const existing = body[key]
              body[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
            } else body[key] = value
          }
          state.formPosts.push({ source: 'form-test', trigger, body })
          return new Response('OK', { status: 200 })
        }
      }

      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const requestUrl = new URL(req.url)
        const source = requestUrl.searchParams.get('source') || resolveSource(requestUrl.pathname) || 'document'
        if (server.upgrade(req, { data: { source } })) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      const pathname = new URL(req.url).pathname
      if (pathname.startsWith('/test/')) {
        const tag = pathname.replace('/test/', '')
        return new Response(generateTestPage(tag), { headers: { 'Content-Type': 'text/html' } })
      }
      if (pathname === '/') return new Response('OK')
      return new Response('Not Found', { status: 404 })
    },
  })

  return {
    server,
    port: server.port!,
    get connections() {
      return state.connections
    },
    get uiEvents() {
      return state.uiEvents
    },
    get errors() {
      return state.errors
    },
    get successes() {
      return state.successes
    },
    get scaleCheckResults() {
      return state.scaleCheckResults
    },
    get snapshots() {
      return state.snapshots
    },
    get formPosts() {
      return state.formPosts
    },
    stop: async () => {
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  const fixture = startServer(3457)
  console.log(`Fixture server listening on http://localhost:${fixture.port}`)
}
