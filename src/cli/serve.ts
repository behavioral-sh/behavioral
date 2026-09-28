import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject } from '../behavioral/behavioral.types.ts'
import { behavioralHome } from '../faculties/behavioral-home.ts'
import { bProgram } from './b-program.ts'
import { createJsonRpcServer, type JsonRpcMessage, type JsonRpcServer } from './json-rpc.ts'
import { loadConfig } from './load-config.ts'
import { collectSecretValues, createTraceConsumer, traceLogSink } from './trace-consumer.ts'

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
 * The stdio entry: compose the runtime from the home config and serve IPC until
 * the client closes the input stream.
 *
 * @public
 */
export const serve = async (): Promise<void> => {
  const runtime = bProgram(await loadConfig())
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
