import { join } from 'node:path'
import { ACTUATOR_MESSAGE_KINDS } from '../actuators/actuators.constants.ts'
import {
  validateSecurityCancelEvent,
  validateSecurityRequestEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateStoreRequestEvent,
} from '../actuators/actuators.schemas.ts'
import { useActuator } from '../actuators/use-actuator.ts'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, Thread } from '../behavioral/behavioral.types.ts'
import {
  supervisionJudgmentThreads,
  supervisionRecoveryThreads,
  supervisionThreads,
} from '../faculties/system-one.threads.ts'
import { behavioralHome } from '../old-faculties/behavioral-home.ts'
import { pluginThreadsThreads } from '../old-faculties/shell/plugin-threads.threads.ts'
import { remoteMcpThreads } from '../old-faculties/shell/remote-mcp.threads.ts'
import { rpcAuthThreads } from '../old-faculties/shell/rpc-auth.threads.ts'
import { shellThreads } from '../old-faculties/shell/threads.ts'
import { bProgram, type LaneBuilder } from './b-program.ts'
import { createJsonRpcServer, type JsonRpcMessage, type JsonRpcServer } from './json-rpc.ts'
import { loadConfig } from './load-config.ts'
import {
  foldPluginThreadSnapshots,
  readPluginThreadRegistry,
  watchPluginThreadRegistry,
} from './plugin-thread-registry.ts'
import { collectSecretValues, createTraceConsumer, traceLogSink } from './trace-consumer.ts'
import { uiThreads } from './ui-threads.ts'

/** The engine identity a host hands to its clients — the hello's payload. */
export type RuntimeIdentity = { instanceId: string; sessionId: string }

/**
 * The host's runtime surface — a narrow view of {@link bProgram}'s handle.
 *
 * @public
 */
export type HostRuntime = Pick<ReturnType<typeof bProgram>, 'trigger' | 'useTrace' | 'start' | 'terminate' | 'identity'>

/**
 * Map one inbound JSON-RPC message onto the engine — the ONE host-side
 * dispatcher. Every carrier (stdio lane, unix socket, later the controller
 * WebSocket) reuses it: one protocol, one dispatcher, multiple carriers.
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

/**
 * The entry-side runtime constructor — the ruled reachability-is-construction
 * seam: THIS owns actuator spawning (the trio via `useActuator`, per the
 * config's allow-list), the thread-pack minting (the packs' reachability
 * conditions are the entry's — it built the lanes), the plugin-thread
 * registry fold + durable-write watcher (Registry/E — never a bProgram
 * concern), and the `models` assembly. `bProgram` takes the assembled
 * `threads` + `models` + the pre-built lane builders and nothing else.
 *
 * TRANSITIONAL (the config reshape is the next slice): the legacy config
 * shape carries `useFaculty` factory overrides — the rewired composition has
 * no override legs, so the factories are acknowledged and IGNORED (a stderr
 * note names each); their endpoint data re-lands as `models` data when the
 * templates regenerate.
 */
export const createRuntime = (config: Parameters<typeof bProgram>[0] = {}): HostRuntime => {
  const home = behavioralHome()
  const legacy = config as unknown as {
    actuators?: string[]
    supervision?: { watch: string[]; threshold?: number }
    ui?: { provider?: string; modelId?: string }
    models?: { systemOne?: JsonObject; systemTwo?: JsonObject }
    shell?: unknown
    store?: unknown
    security?: unknown
    systemOne?: unknown
    systemTwo?: unknown
  }
  const enabled = new Set<string>(legacy.actuators ?? ['shell', 'store', 'security'])

  for (const key of ['shell', 'store', 'security', 'systemOne', 'systemTwo'] as const) {
    if (typeof legacy[key] === 'function')
      console.error(
        `[behavioral] config.${key} is a legacy useFaculty override — ignored by the rewired composition; regenerate via behavioral init (the endpoints re-land as models data)`,
      )
  }

  // ── The actuator lanes: the trio per the allow-list (pre-built builders). ──
  const laneBuilders: LaneBuilder[] = []
  if (enabled.has('shell'))
    laneBuilders.push(
      useActuator({
        command: ['bun', 'run', 'shell.actuator.ts'],
        name: 'shell',
        validateRequest: validateShellRequestEvent,
        validateCancel: validateShellCancelEvent,
        resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
      }),
    )
  if (enabled.has('store'))
    laneBuilders.push(
      useActuator({
        command: ['bun', 'run', 'store.actuator.ts'],
        name: 'store',
        // No cancel contract — the request schema is the gate.
        validateRequest: validateStoreRequestEvent,
        resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
      }),
    )
  if (enabled.has('security'))
    laneBuilders.push(
      useActuator({
        command: ['bun', 'run', 'security.actuator.ts'],
        name: 'security',
        validateRequest: validateSecurityRequestEvent,
        validateCancel: validateSecurityCancelEvent,
        resultKind: ACTUATOR_MESSAGE_KINDS.credential_result,
      }),
    )

  // ── The thread packs: minted here, where the reachability is known. ────────
  const threads: Thread[] = []
  if (enabled.has('shell') && enabled.has('store')) threads.push(...shellThreads)
  if (enabled.has('shell')) threads.push(...pluginThreadsThreads)
  if (enabled.has('shell') && enabled.has('security')) threads.push(...rpcAuthThreads)
  if (enabled.has('shell') && enabled.has('security') && enabled.has('store')) threads.push(...remoteMcpThreads)
  const supervision = legacy.supervision
  if (supervision !== undefined) {
    threads.push(
      ...supervisionThreads(supervision),
      ...supervisionJudgmentThreads,
      ...supervisionRecoveryThreads(supervision),
    )
  }
  const systemTwoConfigured = legacy.models?.systemTwo !== undefined || typeof legacy.systemTwo === 'function'
  if (enabled.has('shell') && enabled.has('store') && systemTwoConfigured) threads.push(...uiThreads)
  // The registry's boot fold: admitted snapshots mount as threads.
  threads.push(...foldPluginThreadSnapshots(readPluginThreadRegistry(home)))

  // ── The models: init-frame payloads + the ui generation target. ────────────
  const models: Parameters<typeof bProgram>[0]['models'] = {}
  if (legacy.models?.systemOne !== undefined) models.systemOne = legacy.models.systemOne
  if (legacy.models?.systemTwo !== undefined) models.systemTwo = legacy.models.systemTwo
  if (legacy.ui !== undefined) models.ui = legacy.ui

  const runtime = bProgram({ threads, models, actuators: laneBuilders })
  // The registry's durable-write legs: the entry's own trace subscription.
  watchPluginThreadRegistry({ runtime, home })
  return runtime
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
  runtime.terminate()
}
