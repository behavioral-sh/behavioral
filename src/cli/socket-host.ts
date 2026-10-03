import { join } from 'node:path'
import type { JSONSchemaType } from 'ajv'
import type { ServerWebSocket } from 'bun'
import { behavioralHome } from '../actuators/behavioral-home.ts'
import { BunKeychain, type Keychain } from '../actuators/keychain-oauth-provider.ts'
import { bundleBProgramWorker, connectSrcPolicy } from '../b-program/bundle-worker.ts'
import { createUiCapture, uiCaptureFileSink } from '../b-program/ui-capture.ts'
import { ajv } from '../behavioral/behavioral.types.ts'
import { bundleController, CONNECT_BEHAVIORAL_ROUTE } from '../controller/bundle-controller.ts'
import { B_PROGRAM_WORKER_PATH } from '../controller/worker-transport.ts'
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
}: {
  runtime: HostRuntime
  home?: string
  /** Rebuild the controller bundle per request instead of caching it. */
  dev?: boolean
  /** The configured proxied providers (R5) — id → allow-listed forward base. */
  inferenceProviders?: Record<string, string>
  /** The custody floor; defaults to the OS keychain. */
  keychain?: Keychain
}): Promise<SocketHost> => {
  const path = instanceSocketPath(home)
  // A socket file left by a dead instance cannot be bound again — remove it
  // before the bind (ENOENT means there was nothing to reap).
  await Bun.file(path)
    .delete()
    .catch(() => {})

  const clients = new Set<ServerWebSocket<unknown>>()
  const frame = (method: string, params: unknown): string => JSON.stringify({ jsonrpc: '2.0', method, params })

  // The session (R3): minted per instance, revocable at `<home>/session.token`.
  // The browser gets the httpOnly cookie (set with the page); CLI attachers
  // present the bearer. The inference proxy is the session's first consumer.
  const sessionToken = await ensureSessionToken(home)
  const inferenceProxy = createInferenceProxy({
    providers: inferenceProviders,
    session: (req) => validSession(req, sessionToken),
    keychain: keychain ?? BunKeychain(),
  })

  /**
   * R6's header (list-is-config): the emitted `connect-src` carries ONLY
   * 'self' + the daemon origin (the request's own origin — a unix socket
   * has no hostname) + the configured proxied provider origins. Never
   * hardcoded, never a wildcard.
   */
  const cspHeader = (req: Request): string =>
    connectSrcPolicy([new URL(req.url).origin, ...Object.values(inferenceProviders)])

  const server = Bun.serve({
    unix: path,
    // MINIMAL: ws idleTimeout max is 255s; long-lived attaches get the ceiling
    // until a heartbeat/reconnect story is needed.
    websocket: {
      idleTimeout: 255,
      open: (ws) => {
        clients.add(ws)
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
        clients.delete(ws)
      },
    },
    fetch: async (req, server) => {
      const url = new URL(req.url)
      if (url.pathname.startsWith(INFERENCE_PROXY_PREFIX)) return inferenceProxy(req)
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
      return server.upgrade(req)
        ? undefined
        : new Response('behavioral instance socket — a WebSocket upgrade is required\n', { status: 426 })
    },
  })

  // Egress: one redaction pass, the JSONL log, then fan out to every client.
  wireRuntimeEgress({
    runtime,
    home,
    emit: (method, params) => {
      for (const ws of clients) ws.send(frame(method, params))
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
    close: async () => {
      await server.stop(true)
      await Bun.file(path)
        .delete()
        .catch(() => {})
    },
  }
}
