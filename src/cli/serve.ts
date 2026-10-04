import { join } from 'node:path'
import { ACTUATOR_MESSAGE_KINDS } from '../actuators/actuators.constants.ts'
import {
  validateSecurityCancelEvent,
  validateSecurityRequestEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateStoreRequestEvent,
} from '../actuators/actuators.schemas.ts'
import { behavioralHome } from '../actuators/behavioral-home.ts'
import type { Keychain } from '../actuators/keychain-oauth-provider.ts'
import { vendProviderToken } from '../actuators/provider-keys.ts'
import { useActuator } from '../actuators/use-actuator.ts'
import type { LaneBuilder } from '../b-program/b-program.ts'
import { bProgram } from '../b-program/b-program.ts'
import { INFERENCE_PROXY_PREFIX } from '../b-program/composition-port.ts'
import {
  pluginThreadsReconcileThreads,
  RECONCILE_EVENT_TYPES,
  validatePluginThreadsReload,
} from '../b-program/plugin-threads.reconcile.ts'
import { watchPluginThreadRegistry } from '../b-program/plugin-threads.registry.ts'
import { pluginThreadsThreads } from '../b-program/plugin-threads.threads.ts'
import { remoteMcpThreads } from '../b-program/remote-mcp.threads.ts'
import { rpcAuthThreads } from '../b-program/rpc-auth.threads.ts'
import { shellThreads } from '../b-program/shell.threads.ts'
import { uiThreads } from '../b-program/ui-threads.ts'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, Thread } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import {
  supervisionJudgmentThreads,
  supervisionRecoveryThreads,
  supervisionThreads,
} from '../faculties/system-one.threads.ts'
import { createJsonRpcServer, type JsonRpcMessage, type JsonRpcServer } from './json-rpc.ts'
import { type BehavioralConfig, loadConfig } from './load-config.ts'
import { collectSecretValues, createTraceConsumer, traceLogSink } from './trace-consumer.ts'

/** The engine identity a host hands to its clients — the hello's payload. */
export type RuntimeIdentity = { instanceId: string; sessionId: string }

/**
 * The host's runtime surface — a narrow view of {@link bProgram}'s handle,
 * plus the durable-write exit gate when the store lane is on: `flush` awaits
 * the registry watcher's in-flight puts (the composition must not terminate
 * with puts in flight — the exit-flush rule); absent without a store lane.
 *
 * @public
 */
export type HostRuntime = Pick<
  ReturnType<typeof bProgram>,
  'trigger' | 'useTrace' | 'start' | 'terminate' | 'identity'
> & { flush?: () => Promise<void> }

/**
 * Map one inbound JSON-RPC message onto the engine — the ONE host-side
 * dispatcher. Every carrier (stdio lane, unix socket, later the controller
 * WebSocket) reuses it: one protocol, one dispatcher, multiple carriers.
 *
 * The reload ingress (`plugin_threads_reload` — the reconciliation's
 * mid-run re-run) validates its params against the reload detail schema
 * here (the supervision-override precedent: the schema's description names
 * the code-execution ceiling);
 * the CLIENT-CLASS gate (which clients may ask) lives with the carrier that
 * knows its clients — the socket host taints an unauthenticated composition
 * declarer and refuses it the reload.
 *
 * @public
 */
export const dispatchToRuntime = (runtime: HostRuntime, message: JsonRpcMessage): unknown => {
  const { method, params } = message
  if (method === 'trigger') {
    runtime.trigger((params as { event: BPEvent }).event)
    return { accepted: true }
  }
  if (method === 'ui_event') {
    // The controller's `ui_event` carries a BPEvent; ingress it directly.
    runtime.trigger((params as { event: BPEvent }).event)
    return undefined
  }
  if (method.startsWith('ui_')) {
    runtime.trigger({ type: method, detail: params as JsonObject })
    return undefined
  }
  if (method === RECONCILE_EVENT_TYPES.reload) {
    // The ingress boundary: the host validates before triggering (the
    // supervision-override precedent). The schema's description names the
    // ceiling — a reload is a CODE-EXECUTION trigger. The client-class gate
    // (driver / sessioned composition vs a tainted stranger) lives in the
    // socket host's dispatch, the carrier that knows its clients.
    if (!validatePluginThreadsReload(params)) {
      throw new Error(`invalid ${RECONCILE_EVENT_TYPES.reload} params`)
    }
    runtime.trigger({ type: RECONCILE_EVENT_TYPES.reload, detail: params as JsonObject })
    return { accepted: true }
  }
  throw new Error(`unknown method: ${method}`)
}

/**
 * Wire the engine's egress to the JSONL trace log plus one carrier sink:
 * redacted traces flow as `trace` emissions, `ui_*` selections as their own
 * `<type>` emissions with the selection detail. Shared by every carrier.
 *
 * @public
 */
export const wireRuntimeEgress = ({
  runtime,
  home,
  emit,
}: {
  runtime: HostRuntime
  home: string
  emit: (method: string, params: unknown) => void
}): void => {
  const consumer = createTraceConsumer({
    secrets: collectSecretValues(),
    sinks: [traceLogSink({ root: join(home, 'traces') }), (trace) => emit('trace', trace)],
  })
  runtime.useTrace(consumer)

  // Egress-as-selection: a `ui_*` selection becomes a client notification.
  runtime.useTrace((trace) => {
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = trace.selected
    if (selected.type.startsWith('ui_')) emit(selected.type, selected.detail)
  })
}

/**
 * Wire the JSON-RPC codec to a runtime: ingress messages become triggers, `ui_*`
 * selections become client notifications, and redacted traces fan out to a JSONL
 * log and a `trace` notification. Subscribes, then `start()`s the composition.
 *
 * @public
 */
export const createHost = ({
  runtime,
  input,
  write,
  home = behavioralHome(),
}: {
  runtime: HostRuntime
  input: ReadableStream<Uint8Array>
  write: (line: string) => void
  home?: string
}): { rpc: JsonRpcServer } => {
  const rpc = createJsonRpcServer({ input, write, onMessage: (message) => dispatchToRuntime(runtime, message) })

  // Observability: redacted traces to the JSONL log and the client.
  wireRuntimeEgress({ runtime, home, emit: rpc.notify })

  runtime.start()
  rpc.notify('ready')
  return { rpc }
}

// ---------------------------------------------------------------------------
// The inference proxy — the daemon's provider-shaped routes
// ---------------------------------------------------------------------------

/** The proxy route prefix: `POST /v1/inference/<provider>/<path>` — the serving contract's paths. */
export { INFERENCE_PROXY_PREFIX } from '../b-program/composition-port.ts'

/** A structured JSON error body at the proxy boundary. */
const proxyError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

/** The headers that survive the round-trip — status codes surface verbatim beside these. */
const RESPONSE_PASSTHROUGH_HEADERS = ['content-type', 'retry-after'] as const

/**
 * The daemon's inference proxy (R1): static-key vendors are reached ONLY
 * here — a provider-shaped passthrough, never a generic fetch relay. Per
 * request: session auth (R3) → resolve the provider's keychain credential
 * (R2 — the route name IS the keychain entry) → attach `Authorization` →
 * forward the body UNMODIFIED to the provider's configured origin (R5 — the
 * allow-list, fail-closed) → pipe the response back verbatim: status codes
 * surface un-normalized (a 429's `retry-after` reaches the worker's retry
 * logic) and streaming bodies (`text/event-stream`) flow through untouched.
 *
 * The proxy is mounted by every HTTP carrier (the socket host); the browser
 * worker's system-two/system-one configs point at `${prefix}<provider>` and
 * the credential never crosses into a browser context.
 *
 * @public
 */
export const createInferenceProxy = ({
  providers,
  session,
  keychain,
}: {
  /** Provider id → allow-listed forward base (R5 — the egress allow-list). */
  providers: Record<string, string>
  /** The session gate (R3) — an unauthenticated request never reaches custody. */
  session: (req: Request) => boolean
  /** The custody floor — the keychain the provider credentials resolve from. */
  keychain: Keychain
}): ((req: Request) => Promise<Response>) => {
  return async (req) => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith(INFERENCE_PROXY_PREFIX)) return proxyError(404, 'not_found', 'not found')
    if (req.method !== 'POST') return proxyError(405, 'method_not_allowed', 'POST only')
    // R3 first: the session gates everything — on the failure path the
    // credential is never resolved and the provider is never reached.
    if (!session(req)) return proxyError(401, 'invalid_session', 'session authentication required')

    const rest = url.pathname.slice(INFERENCE_PROXY_PREFIX.length)
    const slash = rest.indexOf('/')
    const provider = slash === -1 ? rest : rest.slice(0, slash)
    const path = slash === -1 ? '' : rest.slice(slash + 1)
    const base = providers[provider]
    if (base === undefined) return proxyError(404, 'unknown_provider', `no provider route "${provider}"`)

    // R5: the configured value is the allow-list entry — fail closed on a
    // malformed or non-http(s) base so a misconfiguration can never become an
    // SSRF surface.
    let originUrl: URL
    try {
      originUrl = new URL(base)
    } catch {
      return proxyError(403, 'origin_not_allowed', `provider "${provider}" has no allow-listed origin`)
    }
    if (originUrl.protocol !== 'https:' && originUrl.protocol !== 'http:') {
      return proxyError(403, 'origin_not_allowed', `provider "${provider}" has no allow-listed origin`)
    }

    // R2 custody: resolve by the provider id — the same identifier the route
    // is named with, issuer-bound to the allow-listed origin. Absent custody
    // fails closed (the body is never sent).
    let credential: string | undefined
    try {
      credential = await vendProviderToken({ provider, origin: originUrl.origin, keychain })
    } catch {
      credential = undefined
    }
    if (credential === undefined) {
      return proxyError(502, 'no_credential', `no credential available for provider "${provider}"`)
    }

    // Path-preserving join against the configured base (a base may carry a
    // path prefix, e.g. a self-hosted server under /v1) — URL resolution
    // would strip it.
    const forwardUrl = `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
    const contentType = req.headers.get('content-type')
    // Only the proxy's credential rides upstream — client-supplied headers
    // (including any leaked key) never forward.
    const upstream = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        ...(contentType === null ? {} : { 'content-type': contentType }),
      },
      body: await req.arrayBuffer(),
    })
    const headers = new Headers()
    for (const name of RESPONSE_PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    // The body pipes through untouched — `text/event-stream` streams
    // chunk-by-chunk, never buffered.
    return new Response(upstream.body, { status: upstream.status, headers })
  }
}

/**
 * The actuator lane builders for an allow-list — the entry's construction,
 * shared by the engine composition (createRuntime) and the faculty bridge
 * (the socket host mounts it at /faculty-wire; per-connection lanes).
 *
 * @public
 */
export const actuatorLaneBuilders = (enabled: Iterable<string>): LaneBuilder[] => {
  const on = new Set<string>(enabled)
  const builders: LaneBuilder[] = []
  if (on.has('shell'))
    builders.push(
      useActuator({
        command: ['bun', 'run', 'shell.actuator.ts'],
        name: 'shell',
        validateRequest: validateShellRequestEvent,
        validateCancel: validateShellCancelEvent,
        resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
      }),
    )
  if (on.has('store'))
    builders.push(
      useActuator({
        command: ['bun', 'run', 'store.actuator.ts'],
        name: 'store',
        // No cancel contract — the request schema is the gate.
        validateRequest: validateStoreRequestEvent,
        resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
      }),
    )
  if (on.has('security'))
    builders.push(
      useActuator({
        command: ['bun', 'run', 'security.actuator.ts'],
        name: 'security',
        validateRequest: validateSecurityRequestEvent,
        validateCancel: validateSecurityCancelEvent,
        resultKind: ACTUATOR_MESSAGE_KINDS.credential_result,
      }),
    )
  return builders
}

/**
 * The entry-side runtime constructor — the ruled reachability-is-construction
 * seam: THIS owns actuator spawning (the trio via `useActuator`, per the
 * config's allow-list), the thread-pack minting (the packs' reachability
 * conditions are the entry's — it built the lanes), the plugin-thread
 * registry fold + durable-write watcher (Registry/E — never a bProgram
 * concern), and the `models` assembly. `bProgram` takes the assembled
 * `threads` + `models` + the pre-built lane builders and nothing else.
 *
 * Policy defaults the entry mints: the supervision breaker stands whenever
 * systemOne is configured (the generative lane is what the counting breaker
 * guards; the factory threshold default applies), and the ui_* pack mounts
 * when shell + store + systemTwo are on.
 */
export const createRuntime = (config: BehavioralConfig = {}): HostRuntime => {
  const enabled = new Set<string>(config.actuators ?? ['shell', 'store', 'security'])
  const systemOneConfigured = config.systemOne !== undefined && config.systemOne !== null
  const systemTwoConfigured = config.systemTwo !== undefined && config.systemTwo !== null

  // ── The actuator lanes: the trio per the allow-list (pre-built builders). ──
  const laneBuilders = actuatorLaneBuilders(enabled)

  // ── The thread packs: minted here, where the reachability is known. ────────
  const threads: Thread[] = []
  if (enabled.has('shell') && enabled.has('store')) threads.push(...shellThreads)
  if (enabled.has('shell')) threads.push(...pluginThreadsThreads)
  // The boot reconciliation: shell (stat + the one-moment import) + store
  // (the record) — the cross-run skip's other half; the reload ingress
  // re-runs it mid-run.
  if (enabled.has('shell') && enabled.has('store')) threads.push(...pluginThreadsReconcileThreads)
  if (enabled.has('shell') && enabled.has('security')) threads.push(...rpcAuthThreads)
  if (enabled.has('shell') && enabled.has('security') && enabled.has('store')) threads.push(...remoteMcpThreads)
  // The supervision breaker: a standing floor whenever systemOne can judge —
  // the watch is the generative lane (the runaway generator loop is the
  // scenario the counting breaker exists for); the factory threshold (4096)
  // applies.
  if (systemOneConfigured) {
    threads.push(
      ...supervisionThreads({ watch: [FACULTY_MESSAGE_KINDS.system_two_request] }),
      ...supervisionJudgmentThreads,
      ...supervisionRecoveryThreads({ watch: [FACULTY_MESSAGE_KINDS.system_two_request] }),
    )
  }
  if (enabled.has('shell') && enabled.has('store') && systemTwoConfigured) threads.push(...uiThreads)
  // (The file registry's boot fold is GONE: admitted snapshots mount through
  // the store-resident record's boot reconciliation — a later slice. The
  // pre-boot synchronous fold died with the file.)

  // ── The models: init-frame payloads + the ui generation target. ────────────
  const models: Parameters<typeof bProgram>[0]['models'] = {}
  if (systemOneConfigured) models.systemOne = config.systemOne as JsonObject
  if (systemTwoConfigured) models.systemTwo = config.systemTwo as JsonObject
  if (config.ui !== undefined) models.ui = config.ui

  const runtime = bProgram({ threads, models, actuators: laneBuilders })
  // The registry's durable-write legs: the entry's own trace subscription,
  // writing store puts through the composition's routing. The flush handle
  // rides the runtime surface — the exit-flush rule's gate.
  const registry = enabled.has('store') ? watchPluginThreadRegistry({ runtime }) : undefined
  return { ...runtime, ...(registry === undefined ? {} : { flush: registry.flush }) }
}

/**
 * The stdio entry: compose the runtime from the home config and serve IPC until
 * the client closes the input stream.
 *
 * @public
 */
export const serve = async (): Promise<void> => {
  const runtime = createRuntime(await loadConfig())
  const { rpc } = createHost({
    runtime,
    input: Bun.stdin.stream(),
    write: (line) => {
      process.stdout.write(line)
    },
  })
  await rpc.done
  // The exit-flush rule: no terminate with registry puts in flight.
  await runtime.flush?.()
  runtime.terminate()
}
