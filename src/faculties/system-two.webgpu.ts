import type { SystemTwoInput, SystemTwoOutput } from './system-two.types.ts'

/**
 * The local (WebGPU) model runtime — the faculty-side seam for in-worker
 * inference. system-two's respond dispatches here (lazy dynamic import — the
 * default bundle never pays for it) when a provider's endpoint config says
 * `transport: 'webgpu'`. The wire contract is unchanged: one Open
 * Responses-shaped output out, errors as data, never throws across the lane.
 *
 * MINIMAL: the body is a canned completion proving the transport dispatch and
 * the envelope path end-to-end. The real runtime (adapter download via the
 * re-init channel, in-worker WebGPU inference) replaces THIS BODY ONLY — the
 * module's export signature is the contract the faculty wires against.
 */

export type LocalModelConfig = { model?: string; signal: AbortSignal }

export const runLocalModel = async (
  input: SystemTwoInput,
  { model, signal }: LocalModelConfig,
): Promise<SystemTwoOutput> => {
  if (model === undefined) return { isError: true, message: 'no local model configured for the webgpu endpoint' }
  // An abort before inference starts maps to the stop-reason envelope.
  if (signal.aborted) throw new Error('local inference aborted')
  return {
    items: [
      {
        id: 'msg_local_001',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: `local model ${model}: stub completion for ${input.modelId}` }],
      },
    ],
    status: 'completed',
  }
}
