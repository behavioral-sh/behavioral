import { join } from 'node:path'
import type { JSONSchemaType } from 'ajv'
import type { ServerWebSocket } from 'bun'
import { behavioralHome } from '../actuators/behavioral-home.ts'
import { BunKeychain, type Keychain } from '../actuators/keychain-oauth-provider.ts'
import { bundleBProgramWorker, connectSrcPolicy } from '../b-program/bundle-worker.ts'
import { traceSpaceOf } from '../b-program/composition-port.ts'
import { createUiCapture, uiCaptureFileSink } from '../b-program/ui-capture.ts'
import type { Trace } from '../behavioral/behavioral.types.ts'
import { ajv } from '../behavioral/behavioral.types.ts'
import { bundleController, CONNECT_BEHAVIORAL_ROUTE } from '../controller/bundle-controller.ts'
import { B_PROGRAM_WORKER_PATH } from '../controller/worker-transport.ts'
import { ROOT_SPACE } from '../faculties/faculties.constants.ts'
import {
  createFacultyBridge,
  DAEMON_BRIDGE_PATH,
  FACULTY_BRIDGE_SOCKET,
  type FacultyBridgeSocketData,
} from './faculty-bridge.ts'
import type { JsonRpcMessage } from './json-rpc.ts'
import {
  createInferenceProxy,
  dispatchToRuntime,
  type HostRuntime,
  INFERENCE_PROXY_PREFIX,
  type RuntimeIdentity,
  wireRuntimeEgress,
} from './serve.ts'
import { ensureSessionToken, sessionCookie, validSession } from './session.ts'
import { traceLogSink } from './trace-consumer.ts'

/**
 * The instance socket — `<home>/instance.sock`, the attach lane.
 *
 * @remarks
 * The host's single listener: a `Bun.serve` bound to this unix path speaks the
 * same line-framed JSON-RPC vocabulary as the stdio lane (one WebSocket text
 * message = one JSON-RPC frame), so an attacher is just another client of the
 * controller contract. The same server later serves the controller GUI over
 * HTTP on the same listener (Carriers/H). Written at start, removed on close —
 * the same lifecycle as the instance pidfile.
 *
 * @public
 */
export const instanceSocketPath = (home: string): string => join(home, 'instance.sock')

/**
 * The running socket host — `close()` stops the server and removes the socket
 * file (the terminate-path cleanup).
 *
 * @public
 */
export type SocketHost = {
  path: string
  close: () => Promise<void>
  /**
   * The trace fold's entry: an (already-redacted) trace enters the daemon's
   * ONE observability stream — the JSONL persistence home + the scoped
   * fan-out. The bridge's push leg wires here; the daemon-pipe consumers
   * (the e2e fixture host) reuse it.
   */
  pushTrace: (trace: Trace) => void
}

/**
 * The hello's wire shape — the engine identity a client receives on connect.
 * The one schema home for the hello boundary: the host validates before it
 * sends (fail closed), and attaching clients validate on receipt.
 *
 * @public
 */
export const HelloDetailSchema: JSONSchemaType<RuntimeIdentity> = {
  type: 'object',
  properties: { instanceId: { type: 'string' }, sessionId: { type: 'string' } },
  required: ['instanceId', 'sessionId'],
  additionalProperties: false,
}

/** Compiled once — the host's egress gate for the hello; attach clients reuse it on receipt. */
export const validateHelloDetail = ajv.compile(HelloDetailSchema) as (value: unknown) => boolean

/**
 * Start the attach lane: a unix-socket `Bun.serve` over the shared host
 * dispatcher, with redacted traces and `ui_*` selections fanning out to every
 * connected client. The same listener serves the bundled controller GUI at
 * {@link CONNECT_BEHAVIORAL_ROUTE} — the browser's carrier and the TUI's
 * carrier are two clients of one host (Carriers/H).
 *
 * @remarks
 * With `dev: true` the controller bundle is rebuilt per request (the Bun
 * fullstack-dev-server surface lands when the GUI entry exists); without it
 * the production bundle is built once and cached. Engine/wire are identical
 * in both modes — `--dev` gates the GUI-serving surface only.
 * Unlike {@link createHost}, this does NOT call `runtime.start()` — the
 * foreground entry composes the runtime, the socket host, and its clients,
 * then starts the composition itself.
 *
 * @public
 */
export const createSocketHost = async ({
  runtime,
  home = behavioralHome(),
  dev = false,
  inferenceProviders = {},
  keychain,
  facultyLanes,
}: {
  runtime: HostRuntime
  home?: string
  /** Rebuild the controller bundle per request instead of caching it. */
  dev?: boolean
  /** The configured proxied providers (R5) — id → allow-listed forward base. */
  inferenceProviders?: Record<string, string>
  /** The custody floor; defaults to the OS keychain. */
  keychain?: Keychain
  /**
   * The actuator lane builders for the faculty bridge — the entries own
   * construction; absent means the bridge route is closed (no faculty-wire
   * traffic, fail-closed).
   */
  facultyLanes?: import('../faculties/faculties.types.ts').LaneBuilder[]
}): Promise<SocketHost> => {
  const path = instanceSocketPath(home)
  // A socket file left by a dead instance cannot be bound again — remove it
  // before the bind (ENOENT means there was nothing to reap).
  await Bun.file(path)
    .delete()
    .catch(() => {})

  /** The attach lane's clients, with their R3 scope (composition vs driver). */
  type ClientScope = { scope: 'composition' | 'driver'; space?: string }
  const clients = new Map<ServerWebSocket<unknown>, ClientScope>()
  const frame = (method: string, params: unknown): string => JSON.stringify({ jsonrpc: '2.0', method, params })

  /**
   * The scoped trace delivery (pin 3): a composition-scoped client receives
   * ONLY its declared space's traces; a driver client receives ONLY the
   * daemon's root-space traffic. The two streams are disjoint — a client's
   * scope never widens what it receives. Default (no declaration): driver.
   */
  const emitTrace = (trace: unknown): void => {
    const space = traceSpaceOf(trace as Trace)
    for (const [ws, client] of clients) {
      const deliver = client.scope === 'composition' ? space === client.space : space === ROOT_SPACE
      if (deliver) ws.send(frame('trace', trace))
    }
  }

  // The session (R3): minted per instance, revocable at `<home>/session.token`.
  // The browser gets the httpOnly cookie (set with the page); CLI attachers
  // present the bearer. The inference proxy is the session's first consumer.
  const sessionToken = await ensureSessionToken(home)
  const inferenceProxy = createInferenceProxy({
    providers: inferenceProviders,
    session: (req) => validSession(req, sessionToken),
    keychain: keychain ?? BunKeychain(),
  })

  // The faculty bridge (the thin faculty host): the composition capability —
  // the actuator trio over the landed socket-lane framing, session-gated.
  // Closed when the host configures no lanes (fail-closed). The trace leg's
  // fold wires here too: the bridge's pushed (already-redacted) stream lands
  // in the daemon's ONE observability stream — the JSONL persistence home +
  // the scoped fan-out. Scoped by construction: only sessioned composition
  // connects reach the bridge's push leg.
  const pushedSink = traceLogSink({ root: join(home, 'traces') })
  const pushTrace = (trace: Trace): void => {
    pushedSink(trace)
    emitTrace(trace)
  }
  const facultyBridge =
    facultyLanes === undefined
      ? undefined
      : createFacultyBridge({
          laneBuilders: facultyLanes,
          session: (req) => validSession(req, sessionToken),
          pushTrace,
        })

  /**
   * R6's header (list-is-config): the emitted `connect-src` carries ONLY
   * 'self' + the daemon origin (the request's own origin — a unix socket
   * has no hostname) + the configured proxied provider origins. Never
   * hardcoded, never a wildcard.
   */
  const cspHeader = (req: Request): string =>
    connectSrcPolicy([new URL(req.url).origin, ...Object.values(inferenceProviders)])

  const server = Bun.serve<FacultyBridgeSocketData | { sessioned: boolean } | undefined>({
    unix: path,
    // MINIMAL: ws idleTimeout max is 255s; long-lived attaches get the ceiling
    // until a heartbeat/reconnect story is needed.
    websocket: {
      idleTimeout: 255,
      open: (ws) => {
        if ((ws.data as { kind?: string } | undefined)?.kind === FACULTY_BRIDGE_SOCKET) {
          facultyBridge?.open(ws as ServerWebSocket<FacultyBridgeSocketData>)
          return
        }
        clients.set(ws, { scope: 'driver' })
        // Hello-with-id: one connection-scoped notification carrying the
        // engine identity, before any trace traffic — an attacher learns the
        // instance id immediately, even on a fresh idle instance. Not an
        // engine event: nothing enters the engine, nothing triggers a
        // super-step. A malformed identity fails closed (stderr + no hello):
        // the host never sends an unvalidated frame at the boundary.
        if (validateHelloDetail(runtime.identity)) {
          ws.send(frame('hello', runtime.identity))
        } else {
          process.stderr.write(`instance socket: runtime identity failed its schema — no hello sent\n`)
        }
      },
      message: (ws, message) => {
        if ((ws.data as { kind?: string } | undefined)?.kind === FACULTY_BRIDGE_SOCKET) {
          facultyBridge?.message(
            ws as ServerWebSocket<FacultyBridgeSocketData>,
            typeof message === 'string' ? message : new TextDecoder().decode(message),
          )
          return
        }
        const line = typeof message === 'string' ? message : new TextDecoder().decode(message)
        let parsed: JsonRpcMessage
        try {
          const value: unknown = JSON.parse(line)
          if (typeof value !== 'object' || value === null || typeof (value as JsonRpcMessage).method !== 'string') {
            throw new Error('not a JSON-RPC message')
          }
          parsed = value as JsonRpcMessage
        } catch {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          return
        }
        if (parsed.id === undefined) {
          // The R3 scope declaration rides the attach lane as its own
          // notification (first frame, transport-level — never dispatched).
          // Fail-closed: the composition capability additionally requires the
          // session (the bearer presentation).
          if (parsed.method === 'attach_scope') {
            // Fail-closed AND fail loud (pilot ruling 2026-09-28): a
            // composition declaration that cannot be granted is an EXPLICIT
            // refusal the client observes — never a silent downgrade. The
            // session verdict was captured at upgrade (the bearer/cookie
            // presentation); driver declarations need no session and stay
            // silent-accepted.
            const params = parsed.params as { scope?: string; space?: string } | undefined
            const client = clients.get(ws)
            const sessioned = (ws.data as { sessioned?: boolean } | undefined)?.sessioned === true
            if (params?.scope === 'composition' && client !== undefined) {
              if (!sessioned) {
                ws.send(frame('attach_scope_rejected', { reason: 'session_required' }))
                return
              }
              if (typeof params.space !== 'string') {
                ws.send(frame('attach_scope_rejected', { reason: 'space_required' }))
                return
              }
              clients.set(ws, { scope: 'composition', space: params.space })
            }
            return
          }
          // A notification has no response channel; a handler failure must not
          // reject the event loop and kill the host.
          try {
            void dispatchToRuntime(runtime, parsed)
          } catch (error) {
            process.stderr.write(
              `instance socket notification '${parsed.method}' failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
          return
        }
        try {
          const result = dispatchToRuntime(runtime, parsed)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
        } catch (error) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            }),
          )
        }
      },
      close: (ws) => {
        if ((ws.data as { kind?: string } | undefined)?.kind === FACULTY_BRIDGE_SOCKET) {
          facultyBridge?.close(ws as ServerWebSocket<FacultyBridgeSocketData>)
          return
        }
        clients.delete(ws)
      },
    },
    fetch: async (req, server) => {
      const url = new URL(req.url)
      if (url.pathname.startsWith(INFERENCE_PROXY_PREFIX)) return inferenceProxy(req)
      if (url.pathname === DAEMON_BRIDGE_PATH) {
        // Fail-closed: a host that configures no lanes serves no bridge at all.
        if (facultyBridge === undefined) return new Response('not found', { status: 404 })
        // The composition capability gate lives in the bridge (fail-closed).
        return facultyBridge.upgrade(req, (r, options) => server.upgrade(r, options as never))
      }
      if (url.pathname === CONNECT_BEHAVIORAL_ROUTE) {
        // Prod: one AOT bundle, cached. Dev: rebundle per request.
        const routes = await bundleController({ dev })
        const response = routes[CONNECT_BEHAVIORAL_ROUTE] ?? new Response(null, { status: 404 })
        // The browser session presentation rides the page (R3 — the cookie is
        // httpOnly and never enters a frame); R6's connect-src rides beside it.
        response.headers.set('set-cookie', sessionCookie(sessionToken))
        response.headers.set('content-security-policy', cspHeader(req))
        return response
      }
      if (url.pathname === B_PROGRAM_WORKER_PATH) {
        // The composition worker at the controller's conventional spawn path —
        // the self-booting wrapper (the socket-lane actuator default).
        const routes = await bundleBProgramWorker({ dev })
        const response = routes[B_PROGRAM_WORKER_PATH] ?? new Response(null, { status: 404 })
        response.headers.set('content-security-policy', cspHeader(req))
        return response
      }
      return server.upgrade(req, { data: { sessioned: validSession(req, sessionToken) } })
        ? undefined
        : new Response('behavioral instance socket — a WebSocket upgrade is required\n', { status: 426 })
    },
  })

  // Egress: one redaction pass, the JSONL log, then fan out — traces scoped
  // per client (pin 3), other emissions (the ui_* selections) unscoped.
  wireRuntimeEgress({
    runtime,
    home,
    emit: (method, params) => {
      if (method === 'trace') return emitTrace(params)
      for (const ws of clients.keys()) ws.send(frame(method, params))
    },
  })

  // The ui autoresearch loop's capture lane: a second useTrace consumer
  // (in-process RAW — the eval ruling's canonical path; per-consumer catch,
  // coexisting with the redacted lane untouched) writing ui-pipeline runs to
  // `<home>/captures/ui-runs.jsonl` for the eval harness. MINIMAL: the socket
  // host (the TUI/start path) is the wired deliverable; the serve host gains
  // it when a named need arrives.
  runtime.useTrace(createUiCapture({ sink: uiCaptureFileSink({ root: join(home, 'captures') }) }))

  return {
    path,
    pushTrace,
    close: async () => {
      await server.stop(true)
      await Bun.file(path)
        .delete()
        .catch(() => {})
    },
  }
}
