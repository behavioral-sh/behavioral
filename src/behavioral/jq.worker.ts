import { type JqError, loadJq } from 'jq-wasm'
// TEMPORARY reverse import on dying code (the transform-faculty ruling): the
// evaluation types moved to the wire home; this worker and its import die
// together at the engine switch (slice 2).
import type { TransformEvaluation } from '../faculties/faculties.types.ts'
import { isTypeOf } from '../utils.ts'
import type { JsonObject } from './behavioral.types.ts'

const encoder = new TextEncoder()

type JqPayload = { sab: SharedArrayBuffer; query: string; detail?: JsonObject }

/**
 * The jq eval worker — a persistent pool of one driven by the
 * `evaluateTransform` bridge in `behavioral.utils.ts`.
 *
 * Protocol: the host posts `{ sab, query, detail }` where `sab` is a
 * SharedArrayBuffer laid out as `[status Int32][byteLength Int32][result
 * bytes...]`. The host is blocked in `Atomics.wait` on the status slot when
 * this runs — its event loop is frozen, so a result sent via `postMessage`
 * could never be received. Results travel through shared memory only:
 * the worker writes the JSON-serialized {@link TransformEvaluation} into the
 * buffer, stores the status, notifies, and waits for the next message.
 *
 * Status: `0` idle (the host resets the slot before each post), `1` ready
 * (wasm compiled — the eval budget starts), `2` done. The host waits on `1`
 * with the startup budget, then on `2` with the eval timeout, so a slow wasm
 * compile never reads as a jq timeout. The worker stays alive across
 * evaluations; only a timeout makes the host terminate and respawn it.
 *
 * The message handler is registered synchronously, before the wasm compile:
 * on bun 1.4.x a worker that awaits at the module top level and assigns
 * `self.onmessage` afterwards drops the first message. Messages posted before
 * the compile resolves are queued, then drained once `evaluate` exists.
 */
const pending: JqPayload[] = []
let evaluate: ((payload: JqPayload) => void) | undefined

self.onmessage = ({ origin, data }: MessageEvent<JqPayload>) => {
  // A dedicated worker's only peer is its spawner, and Bun delivers those
  // messages with an empty origin string — a non-empty origin is a sender
  // this worker never expects. (CodeQL js/missing-origin-check.)
  if (origin !== '') return
  if (evaluate) evaluate(data)
  else pending.push(data)
}

const jq = await loadJq() // async init once — all handle methods are synchronous

const runEvaluation = (query: string, detail: JsonObject | undefined): TransformEvaluation => {
  if (detail === undefined || detail === null) {
    return { ok: false, reason: 'no_detail' }
  }
  try {
    const value: unknown = jq.first(detail, query)
    if (value === undefined) {
      return { ok: false, reason: 'empty_output' }
    }
    if (isTypeOf<JsonObject>(value, 'object')) {
      return { ok: true, value }
    }
    return { ok: false, reason: 'non_object_output' }
  } catch (err) {
    const { stderr, exitCode } = err as JqError
    return { ok: false, reason: 'jq_error', stderr, exitCode }
  }
}

evaluate = ({ sab, query, detail }) => {
  const header = new Int32Array(sab, 0, 2)
  const resultBytes = new Uint8Array(sab, 8)

  // Compilation is done — tell the host the startup budget is over and the
  // eval timeout may start. (The host is parked in `Atomics.wait`; shared
  // memory is the only channel that reaches a blocked event loop.)
  Atomics.store(header, 0, 1)
  Atomics.notify(header, 0)

  let evaluation = runEvaluation(query, detail)
  let json = encoder.encode(JSON.stringify(evaluation))
  if (json.byteLength > resultBytes.byteLength) {
    // The evaluated value exceeds the shared-buffer cap — the fallback
    // evaluation is always small.
    evaluation = { ok: false, reason: 'output_too_large' }
    json = encoder.encode(JSON.stringify(evaluation))
  }
  resultBytes.set(json)
  Atomics.store(header, 1, json.byteLength)
  Atomics.store(header, 0, 2) // done — the host may be parked on this slot
  Atomics.notify(header, 0)
}

for (const payload of pending) evaluate(payload)
pending.length = 0
