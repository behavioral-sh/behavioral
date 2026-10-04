import type { JqError } from 'jq-wasm/inline'
import type { JsonObject } from '../behavioral/behavioral.types.ts'
import { isTypeOf } from '../utils.ts'
import { isInitFrame, isWorkerScope } from './create-worker.ts'
import { FACULTY_MESSAGE_KINDS, TRANSFORM_EVAL_TIMEOUT_MS } from './faculties.constants.ts'
import type { TransformEvaluation, TransformRequestEvent } from './faculties.types.ts'

/*
 * The transform faculty — the FIXED FOURTH lane: transform evaluation moved
 * out of the engine (the SAB-bridged jq pool) onto the standard worker lane.
 * The idiom is unchanged thread data (query/target/umwelt — every existing
 * thread runs unedited); only evaluation moved. The engine mints a
 * `transform_request` once-thread; the composition routes it here; the
 * faculty evaluates via jq-wasm and answers the flat evaluation result.
 *
 * The SAB protocol does NOT port: it existed only because the engine demanded
 * a synchronous answer, and this wire is async. The jq pool's ONLY remaining
 * primitive — terminate() as the interrupt for a never-terminating query —
 * moves inside the faculty: each request evaluates in a per-request nested
 * worker (the same module re-executed from `selfUrl`), raced against the
 * re-homed 1s budget; a timeout terminates the nested worker and answers
 * `jq_timeout`. The faculty worker itself never wedges — a same-realm sync
 * `jq.first` would hang the lane forever (the create-worker timeout timer
 * cannot fire inside a blocked event loop).
 *
 * The eval worker URL rides the INIT FRAME (`selfUrl`): classic worker
 * bundles cannot touch `import.meta` (a syntax error at parse time), so the
 * faculty's own URL is composition-supplied data — the bundler-visible
 * literal lives at the composition's call site (`new Worker(new URL(...))`
 * in b-program.ts), and the served bundle re-executes itself for the eval.
 *
 * The result envelope is the wire home's pinned flat shape
 * (`{ id, ok, value } | { id, ok, reason, stderr?, exitCode? }` + the ctx
 * echo) — NOT createWorker's uniform WorkerResultDetail: the transform
 * result derives from the moved TransformEvaluation, one home in
 * faculties.types.ts. The message plumbing (init frame, per-request
 * lifecycle, timeout) mirrors the create-worker bootstrap's mechanisms.
 *
 * MINIMAL: wasm compiles per eval (the nested worker's `loadJq` from the
 * base64-inlined `jq-wasm/inline` build — the classic bundle is
 * self-contained, no external asset). Upgrade path if the per-eval compile
 * cost shows: compile once in the outer worker and transfer the
 * WebAssembly.Module (structured-cloneable) through the eval frame.
 */

/** The parent → nested eval frame — faculty-internal, never on the wire home. */
const EVAL_FRAME_KIND = 'transform_eval'

/** The nested → parent eval answer — faculty-internal, never on the wire home. */
const EVAL_RESULT_KIND = 'transform_eval_result'

type EvalFrame = { kind: typeof EVAL_FRAME_KIND; query: string; detail?: JsonObject }
type EvalResultFrame = { kind: typeof EVAL_RESULT_KIND; evaluation: TransformEvaluation }
type InitData = { selfUrl?: string }

/**
 * The four evaluation outcomes, ported verbatim from the engine's jq.worker
 * (the SAB cap's `output_too_large` and the no-SAB `jq_unavailable` retire
 * with the bridge — the wire result's failure enum no longer carries them).
 */
const runEvaluation = async (query: string, detail: JsonObject | undefined): Promise<TransformEvaluation> => {
  if (detail === undefined || detail === null) return { ok: false, reason: 'no_detail' }
  // The base64-inlined build — the classic bundle carries the wasm, no
  // external asset. Lazy per call: the compile happens in the nested eval
  // worker (per request), never wedging the outer faculty worker.
  const { loadJq } = await import('jq-wasm/inline')
  const jq = await loadJq()
  try {
    const value: unknown = jq.first(detail, query)
    if (value === undefined) return { ok: false, reason: 'empty_output' }
    if (isTypeOf<JsonObject>(value, 'object')) return { ok: true, value }
    return { ok: false, reason: 'non_object_output' }
  } catch (err) {
    const { stderr, exitCode } = err as JqError
    return {
      ok: false,
      reason: 'jq_error',
      ...(stderr === undefined ? {} : { stderr }),
      ...(exitCode === undefined ? {} : { exitCode }),
    }
  }
}

/** Post one flat result event to the composition — the correlation id, outcome, and the echo lanes. */
const postResult = (
  id: string,
  evaluation: TransformEvaluation,
  request: { ctx?: JsonObject; umwelt?: string },
): void => {
  postMessage({
    type: FACULTY_MESSAGE_KINDS.transform_request_result,
    detail: {
      id,
      ...evaluation,
      ...(request.ctx === undefined ? {} : { ctx: request.ctx }),
    },
    ...(request.umwelt === undefined ? {} : { umwelt: request.umwelt }),
  })
}

/**
 * One correlated transform request: a per-request nested eval worker (the
 * same module re-executed from `selfUrl`), the evaluation raced against the
 * re-homed 1s budget. The kill switch: on timeout the nested worker is
 * TERMINATED — the runaway dies, the faculty keeps serving, and the answer
 * is the typed `jq_timeout` failure. A nested-worker error (the wasm compile
 * failing, the module not resolving) maps to the typed `jq_error` failure
 * with the message as stderr — fail-visible, never a thrown error.
 */
const handleRequest = (event: TransformRequestEvent, selfUrl: string | undefined): void => {
  const { id, query, detail, ctx } = event.detail
  const request = {
    ...(ctx === undefined ? {} : { ctx }),
    ...(event.umwelt === undefined ? {} : { umwelt: event.umwelt }),
  }
  if (selfUrl === undefined) {
    postResult(
      id,
      { ok: false, reason: 'jq_error', stderr: 'transform faculty: no selfUrl — the eval worker cannot spawn' },
      request,
    )
    return
  }
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const evalWorker = new Worker(selfUrl)
  const settle = (evaluation: TransformEvaluation): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    evalWorker.terminate()
    postResult(id, evaluation, request)
  }
  timer = setTimeout(() => settle({ ok: false, reason: 'jq_timeout' }), TRANSFORM_EVAL_TIMEOUT_MS)
  evalWorker.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as EvalResultFrame | null
    if (message === null || typeof message !== 'object' || message.kind !== EVAL_RESULT_KIND) return
    settle(message.evaluation)
  })
  evalWorker.addEventListener('error', (event: ErrorEvent) => {
    settle({ ok: false, reason: 'jq_error', stderr: `eval worker crashed: ${event.message}` })
  })
  const frame: EvalFrame = { kind: EVAL_FRAME_KIND, query, ...(detail === undefined ? {} : { detail }) }
  evalWorker.postMessage(frame)
}

/** The faculty entry's boot: wire the inbound lane inside a worker scope; inert in a main thread. */
const bootTransformFaculty = (): string | undefined => {
  if (!isWorkerScope()) return undefined
  let selfUrl: string | undefined
  self.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as unknown
    if (isInitFrame(message)) {
      // Re-init overwrites — the forward-compatible config channel.
      selfUrl = (message.data as InitData).selfUrl
      return
    }
    if (typeof message === 'object' && message !== null && (message as EvalFrame).kind === EVAL_FRAME_KIND) {
      // The nested eval instance: evaluate and answer the parent. It never
      // receives requests — only its parent's eval frames.
      const { query, detail } = message as EvalFrame
      void runEvaluation(query, detail).then((evaluation) => {
        const answer: EvalResultFrame = { kind: EVAL_RESULT_KIND, evaluation }
        self.postMessage(answer)
      })
      return
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: string }).type === FACULTY_MESSAGE_KINDS.transform_request
    ) {
      handleRequest(message as TransformRequestEvent, selfUrl)
    }
  })
  return FACULTY_MESSAGE_KINDS.transform_request_result
}

// The top-level boot — the same pattern as the create-worker bootstrap: the
// gate is SCOPE (never import.meta — classic bundles cannot touch it), so
// importing the entry in a main thread wires nothing and the return value
// stays introspectable by specs.
export const transformFacultyResultKind = bootTransformFaculty()
