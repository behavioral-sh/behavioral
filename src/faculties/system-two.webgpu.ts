import type { SystemTwoInput, SystemTwoOutput } from './system-two.types.ts'

/**
 * The local (WebGPU) model runtime — the faculty-side seam for in-worker
 * inference. system-two's respond dispatches here (lazy dynamic import — the
 * default bundle never pays for it) when a provider's endpoint config says
 * `transport: 'webgpu'`. The wire contract is unchanged: one Open
 * Responses-shaped output out, errors as data, never throws across the lane.
 *
 * The runtime's phases (the inference-transport ruling, Slice 5):
 *
 * 1. **Adapter resolution** — the re-init channel (R4): adapters register
 *    into a module-level registry keyed by the endpoint's `model` id;
 *    re-registering overwrites, exactly like the init frame's config
 *    overwrite — the model-pull slice delivers future adapters through the
 *    same channel (no WebGPU model downloads before the runtime slice —
 *    the gated drafts' phase discipline).
 * 2. **Inference** — the adapter owns it: the runtime hands it the input,
 *    the worker's WebGPU entry point (or null when the host has none), and
 *    the request signal. The real model code (the webml-community engine /
 *    WGSL kernels) is the gated model track — this spec pins the contract
 *    with a CANNED adapter first.
 * 3. **Abort** — honored at the phase boundaries (the stop-reason envelope
 *    maps the throw); the signal also rides into the adapter for
 *    mid-inference aborts.
 *
 * MINIMAL: with no adapter registered for the model, a canned completion
 * answers — the pre-runtime posture, unchanged, so the transport dispatch
 * stays provable end-to-end before any model artifact exists. Upgrade path:
 * the adapter download leg of the model-pull slice replaces the fallback.
 *
 * This module's export signature is the contract the faculty wires against;
 * changing it needs a faculty-side slice.
 */

/** The runtime context the adapter executes within. */
export type LocalModelRuntimeContext = {
  /** The WebGPU entry point (`navigator.gpu`) when the worker has one; null otherwise. */
  gpu: unknown
  /** The request's abort signal — mid-inference aborts are the adapter's to honor. */
  signal: AbortSignal
}

/** One local model's adapter — the real inference engine lives behind `execute`. */
export type LocalModelAdapter = {
  /** The model id this adapter serves — the registry (and init-frame `model`) key. */
  model: string
  execute: (input: SystemTwoInput, context: LocalModelRuntimeContext) => Promise<SystemTwoOutput>
}

/** The registry — the re-init channel's adapter home, keyed by model id. */
const adapters = new Map<string, LocalModelAdapter>()

/** Register (or overwrite — re-init semantics) one model's adapter. */
export const registerLocalAdapter = (adapter: LocalModelAdapter): void => {
  adapters.set(adapter.model, adapter)
}

/** Resolve one model's adapter, or undefined when none is registered. */
export const resolveLocalAdapter = (model: string): LocalModelAdapter | undefined => adapters.get(model)

/** The worker's WebGPU entry point, or null when the host has none (Bun, headless tests). */
const gpuOf = (): unknown => {
  if (typeof navigator === 'undefined') return null
  if (!('gpu' in navigator)) return null
  return navigator.gpu
}

export type LocalModelConfig = { model?: string; signal: AbortSignal }

export const runLocalModel = async (
  input: SystemTwoInput,
  { model, signal }: LocalModelConfig,
): Promise<SystemTwoOutput> => {
  if (model === undefined) return { isError: true, message: 'no local model configured for the webgpu endpoint' }
  // An abort before inference starts maps to the stop-reason envelope.
  if (signal.aborted) throw new Error('local inference aborted')

  const adapter = resolveLocalAdapter(model)
  if (adapter !== undefined) {
    // The second boundary check: an abort between resolution and inference
    // still maps to the stop-reason envelope, never into the adapter.
    if (signal.aborted) throw new Error('local inference aborted')
    return adapter.execute(input, { gpu: gpuOf(), signal })
  }

  // MINIMAL: the canned completion fallback — the pre-runtime posture.
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
