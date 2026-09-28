import { getEnvironmentData } from 'node:worker_threads'
import type { JsonObject } from '../behavioral/behavioral.types.ts'

/**
 * The process emit lane — faculty processes speak the unchanged behavioral
 * wire over stdio: one JSON event per stdout line, one JSON request per
 * stdin line. Workers are retired from the composition (the process-
 * composition ruling); this lane is unconditionally stdio — no mode
 * detection (plain Bun globalThis carries postMessage, so detection lies).
 *
 * `emit` is the only outbound surface faculty code needs; `wireInbound`
 * wires the inbound line loop; `envData` bridges the two env-data worlds —
 * worker-thread environment data (tests may set it) with process env vars
 * (spawns inherit them), so config flows to faculty processes unchanged.
 */
type EmitFn = (event: { type: string; detail: JsonObject; space?: string }) => void

// The in-process embed seam: engine-owned modules imported by the composition
// (frontier today) bind their emit to the composition's reenter — otherwise
// their results would write to the HOST's stdout. Faculty processes never
// rebind; their emit is the stdout line, always.
let emitImpl: EmitFn = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** Bind an in-process emit (the composition's embed seam); null restores stdout. */
export const bindEmit = (fn: EmitFn | null): void => {
  emitImpl = fn ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`))
}

/** Emit one wire event: the bound lane (in-process embed) or a stdout JSON line. */
export const emit = (event: { type: string; detail: JsonObject; space?: string }): void => {
  emitImpl(event)
}

/** Wire the inbound lane: the faculty's handler over stdio lines (standalone only — an in-process import never wires the host's stdin). */
export const wireInbound = (handler: (message: unknown) => void | Promise<void>): void => {
  // The stdio line loop: one JSON request per line; malformed lines discarded
  // (the line protocol's rule); EOF ends the process.
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let carry = ''
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          // Worker semantics: each message handled independently — no await,
          // or a long-running request would head-of-line block its own cancel.
          void handler(JSON.parse(trimmed))
        } catch {
          // Malformed JSON is discarded, not fatal.
        }
      }
    }
  })()
}

/**
 * The env-data bridge: worker-thread environment data first, process env
 * second. Worker-thread data does NOT cross Bun.spawn boundaries — faculty
 * processes read their config as env VARS (the spawn inherits them), while
 * hosts embedding the module in-process may still use setEnvironmentData.
 * Objects stay objects; strings that look like JSON parse (endpoints ride
 * env vars as JSON strings).
 */
export const envData = (key: string): unknown => {
  const fromThread = getEnvironmentData(key)
  if (fromThread !== undefined) return fromThread
  const fromEnv = process.env[key]
  if (fromEnv === undefined) return undefined
  try {
    return JSON.parse(fromEnv)
  } catch {
    return fromEnv
  }
}
