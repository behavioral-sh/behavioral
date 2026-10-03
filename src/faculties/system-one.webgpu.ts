import type { SystemOneInput, SystemOneOutput } from './system-one.types.ts'

/**
 * The local (WebGPU) model runtime — the system-one faculty-side seam for
 * in-worker inference. system-one's respond dispatches here (lazy dynamic
 * import — the default bundle never pays for it) when the endpoint config
 * says `transport: 'webgpu'`. The wire contract is unchanged: one Decisions
 * output out, errors as data, never throws across the lane.
 *
 * MINIMAL: the body is a canned completion proving the transport dispatch
 * and the envelope path end-to-end. Commit 2 of the transport prompt is
 * REMOVED (the pilot ruling): no interim kev body — the first local
 * systemOne body is the clef-family WebGPU conversion, homed in the model
 * track (a later prompt: two-graph ONNX export + onnxruntime-web, FP16-
 * first, dense joint head). systemOne rides the remote Decisions endpoint
 * (the ruled dev/eval posture) until then; kev-4b remains a baselines ROW
 * in jev-iteration-0, never the production body. This module's export
 * signature (`runLocalModel(input, { model, signal })` — the SHARED seam
 * shape, no per-system name) is the contract the faculty wires against;
 * the real runtime replaces THIS BODY ONLY.
 */

export type LocalModelConfig = { model?: string; signal: AbortSignal }

/** Errors are data, never throws across the lane — the faculty's error envelope. */
export type LocalModelOutput = SystemOneOutput | { isError: true; message: string }

export const runLocalModel = async (
  input: SystemOneInput,
  { model, signal }: LocalModelConfig,
): Promise<LocalModelOutput> => {
  if (model === undefined) return { isError: true, message: 'no local model configured for the webgpu endpoint' }
  // An abort before inference starts maps to the stop-reason envelope.
  if (signal.aborted) throw new Error('local inference aborted')
  // Canned answers over the question set the request carries — one noul
  // answer per question, deterministic.
  const answers: SystemOneOutput['answers'] = Object.fromEntries(
    Object.keys(input.questions).map((id, index) => [id, { type: 'noul', noul: index % 2 }]),
  )
  return {
    model: input.model ?? model,
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}
