/**
 * The faculty-bridge e2e fixture — a TCP daemon stand-in mounting the REAL
 * bridge (src/cli/faculty-bridge.ts) with a REAL spawned store actuator, and
 * serving the REAL bundled composition worker (bundleBProgramWorker — the
 * landed serving contract, whose default actuator leg is the socket-lane
 * trio over this bridge, plus the armed trace pipe).
 *
 * The page (`/bridge.html`) boots the composition worker over the
 * WorkerTransport, attaches (the session cookie rides the page response),
 * and triggers a real `store_request`: page → worker → WS → daemon bridge →
 * real store actuator → back. The fixture records every trace the worker
 * pushes upstream (the trace leg).
 *
 * Faculty workers the composition spawns resolve to
 * `/faculties/*.faculty.ts` (the composition bundle sits at the root) and
 * are served as bundled CLASSIC-safe artifacts; the transform faculty's
 * bundle is self-contained (the wasm rides it base64-inlined)
 * the same rule. COOP/COEP on everything (the SAB + Atomics bridge needs
 * the isolation).
 */

import { ACTUATOR_MESSAGE_KINDS } from '../../../actuators/actuators.constants.ts'
import { useActuator } from '../../../actuators/use-actuator.ts'
import { bundleBProgramWorker, connectSrcPolicy } from '../../../b-program/bundle-worker.ts'
import type { Trace } from '../../../behavioral/behavioral.types.ts'
import type { FacultyBridgeSocketData } from '../../../cli/faculty-bridge.ts'
import { DAEMON_BRIDGE_PATH } from '../../../cli/faculty-bridge.ts'
import { SESSION_COOKIE_NAME, validSession } from '../../../cli/session.ts'
import { B_PROGRAM_WORKER_PATH } from '../../../controller/worker-transport.ts'
import { validateStoreRequestEvent } from '../../../faculties/faculties.types.ts'

const FIXTURES_DIR = import.meta.dir
const SRC_ROOT = `${FIXTURES_DIR}/../../..`

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

export type BridgeFixtureServer = {
  port: number
  /** The traces the worker pushed upstream (the trace leg's arrival record). */
  pushedTraces: Trace[]
  waitForPushedTrace: (pred: (trace: Trace) => boolean) => Promise<Trace>
  stop: () => void
}

export const startBridgeFixtureServer = async (port = 0): Promise<BridgeFixtureServer> => {
  const routes = new Map<string, () => Promise<{ body: BodyInit; contentType: string; headers?: HeadersInit }>>()
  const built = new Map<string, Promise<{ body: BodyInit; contentType: string; headers?: HeadersInit }>>()
  const route = (
    path: string,
    build: () => Promise<{ body: BodyInit; contentType: string; headers?: HeadersInit }>,
  ): void => {
    routes.set(path, build)
  }

  // The session — minted by the fixture, presented as the httpOnly cookie
  // (the page response sets it; the worker's WS handshake carries it).
  const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const sessionHeaders = (): HeadersInit => ({
    'set-cookie': `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
  })

  // The REAL bridge: the composition capability over the landed framing,
  // session-gated, with a REAL spawned store actuator and the trace fold.
  const pushedTraces: Trace[] = []
  const bridge = await (async () => {
    const { createFacultyBridge } = await import('../../../cli/faculty-bridge.ts')
    return createFacultyBridge({
      laneBuilders: [
        useActuator({
          command: ['bun', 'run', 'store.actuator.ts'],
          name: 'store',
          validateRequest: validateStoreRequestEvent,
          resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
        }),
      ],
      session: (req) => validSession(req, sessionToken),
      pushTrace: (trace) => {
        pushedTraces.push(trace)
      },
    })
  })()

  // 1. The REAL composition worker — the landed serving contract's artifact
  //    (the self-booting wrapper; the default actuator leg = the socket-lane
  //    trio over this bridge + the armed trace pipe).
  route(B_PROGRAM_WORKER_PATH, async () => {
    const bundle = await bundleBProgramWorker()
    const response = bundle[B_PROGRAM_WORKER_PATH]!
    return {
      body: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? 'text/javascript',
      headers: { 'content-encoding': response.headers.get('content-encoding') ?? '' },
    }
  })

  // 2. The fixed three faculty workers — the composition bundle's literals
  //    resolve to `/faculties/<entry>.faculty.ts`. Bundled single-file
  //    (classic-safe) artifacts.
  for (const faculty of ['system-one', 'system-two', 'frontier-analysis', 'transform']) {
    const entry = Bun.resolveSync(`./faculties/${faculty}.faculty.ts`, SRC_ROOT)
    route(`/faculties/${faculty}.faculty.ts`, async () => ({
      body: await bundleBrowser(`import ${JSON.stringify(entry)}`),
      contentType: 'text/javascript',
    }))
  }

  // 4. The page: the real composition worker over the WorkerTransport (the
  //    landed serving contract), a store trigger, and the taps.
  const workerTransportEntry = Bun.resolveSync('./controller/worker-transport.ts', SRC_ROOT)
  const controllerEntry = Bun.resolveSync('./controller/controller.ts', SRC_ROOT)
  route('/bridge-page.js', async () => ({
    body: await bundleBrowser(`
import { WorkerTransport } from ${JSON.stringify(workerTransportEntry)}
import { Controller } from ${JSON.stringify(controllerEntry)}

window.__traces = []
window.__workerError = null
const worker = new Worker(${JSON.stringify(B_PROGRAM_WORKER_PATH)}, { type: 'module' })
worker.onerror = (event) => {
  window.__workerError = String(event.message ?? event)
}
const transport = new WorkerTransport({
  worker,
  onHello: (frame) => {
    window.__hello = frame.identity
    window.__umwelt = frame.umwelt
  },
  onTrace: (trace) => { window.__traces.push(trace) },
})
window.__transport = transport

const extensions = new Map([
  ['click:store_request', (params) => {
    params.trigger({
      type: 'store_request',
      detail: { id: 'e2e_1', op: 'put', input: { collection: 'bridge-docs', key: 'k', value: { v: 1 } } },
    })
  }],
])
const controller = new Controller({ transport, extensions })
window.__controller = controller
controller.connect()
`),
    contentType: 'text/javascript',
  }))
  route('/bridge.html', async () => ({
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script type="module" src="/bridge-page.js"></script>
  </head>
  <body>
    <button id="s-btn" b-trigger="click:store_request">store put</button>
  </body>
</html>`,
    contentType: 'text/html',
    headers: sessionHeaders(),
  }))

  route('/health', async () => ({ body: 'ok', contentType: 'text/plain' }))

  const server = Bun.serve<FacultyBridgeSocketData>({
    port,
    async fetch(request, srv) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === DAEMON_BRIDGE_PATH) {
        // The REAL bridge — upgrade gated by the session (cookie presentation).
        const response = bridge.upgrade(request, (r, options) => srv.upgrade(r, options as never))
        return response ?? undefined
      }
      const build = routes.get(path)
      if (build) {
        let cached = built.get(path)
        if (!cached) {
          cached = build()
          built.set(path, cached)
        }
        const artifact = await cached
        const response = new Response(artifact.body, {
          headers: { 'content-type': artifact.contentType, ...(artifact.headers ?? {}) },
        })
        // The CSP connect-src: the serving contract's R6 leg (the provider
        // list is empty here — 'self' + the origin only).
        response.headers.set('content-security-policy', connectSrcPolicy([url.origin]))
        return withIsolation(response)
      }
      return withIsolation(new Response('not found', { status: 404 }))
    },
    websocket: {
      open: (ws) => bridge.open(ws),
      message: (ws, m) => bridge.message(ws, typeof m === 'string' ? m : new TextDecoder().decode(m)),
      close: (ws) => bridge.close(ws),
    },
  })

  return {
    port: server.port!,
    pushedTraces,
    waitForPushedTrace: (pred) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20_000
        const timer = setInterval(() => {
          const hit = pushedTraces.find(pred)
          if (hit !== undefined) {
            clearInterval(timer)
            resolve(hit)
          } else if (Date.now() > deadline) {
            clearInterval(timer)
            reject(new Error(`timed out waiting for pushed trace; saw ${pushedTraces.length} pushed`))
          }
        }, 20)
      }),
    stop: () => server.stop(true),
  }
}
