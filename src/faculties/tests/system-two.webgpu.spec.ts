import { describe, expect, test } from 'bun:test'
import type { SystemTwoInput, SystemTwoOutput } from '../system-two.types.ts'
import {
  type LocalModelAdapter,
  registerLocalAdapter,
  resolveLocalAdapter,
  runLocalModel,
} from '../system-two.webgpu.ts'

/**
 * The local (WebGPU) model runtime — the faculty-side seam for in-worker
 * inference. The runtime's phases: resolve the adapter (the re-init
 * channel's registry, keyed by model id) → hand the WebGPU entry point +
 * signal to the adapter's execute → the adapter owns the inference (the
 * real model code is the gated model track; this spec runs a CANNED
 * adapter — spec against the adapter before real model code). Abort is
 * honored at the phase boundaries; the signal rides into the adapter for
 * mid-inference aborts.
 */

const input = (overrides: Partial<SystemTwoInput> = {}): SystemTwoInput =>
  ({ provider: 'local', modelId: 'canned-1', input: [], ...overrides }) as SystemTwoInput

const cannedAdapter = (overrides: Partial<LocalModelAdapter> = {}): LocalModelAdapter => ({
  model: 'canned-1',
  execute: async () => ({
    items: [
      {
        id: 'msg_local_001',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'canned completion' }],
      },
    ],
    status: 'completed',
  }),
  ...overrides,
})

describe('the local model runtime — the adapter registry (the re-init channel)', () => {
  test('a registered adapter resolves by model id; re-registering overwrites (re-init semantics)', async () => {
    expect(resolveLocalAdapter('canned-1')).toBeUndefined()
    registerLocalAdapter(cannedAdapter())
    expect(resolveLocalAdapter('canned-1')?.model).toBe('canned-1')
    registerLocalAdapter(cannedAdapter({ model: 'canned-1', execute: async () => ({ isError: true, message: 'v2' }) }))
    const resolved = resolveLocalAdapter('canned-1')!
    expect(await resolved.execute(input(), { gpu: null, signal: new AbortController().signal })).toEqual({
      isError: true,
      message: 'v2',
    })
  })

  test('a registered adapter executes: the input + the gpu handle + the signal ride in, its output rides out', async () => {
    registerLocalAdapter(
      cannedAdapter({
        execute: async (seen, { gpu, signal }) => {
          expect(seen.modelId).toBe('canned-1')
          expect(gpu).toBeNull() // Bun/tests have no navigator.gpu — device-absent is the adapter's call
          expect(signal.aborted).toBe(false)
          return {
            items: [
              {
                id: 'msg_adapter_001',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'adapter ran' }],
              },
            ],
            status: 'completed',
          } as SystemTwoOutput
        },
      }),
    )
    const output = await runLocalModel(input(), { model: 'canned-1', signal: new AbortController().signal })
    const text = (output as { items: Array<{ content: Array<{ text: string }> }> }).items[0]!.content[0]!.text
    expect(text).toBe('adapter ran')
  })

  test('an adapter error is data, never a throw across the lane', async () => {
    registerLocalAdapter(
      cannedAdapter({
        execute: async () => ({ isError: true, message: 'device lost' }),
      }),
    )
    const output = await runLocalModel(input(), { model: 'canned-1', signal: new AbortController().signal })
    expect(output).toEqual({ isError: true, message: 'device lost' })
  })

  test('abort at the phase boundary maps to the stop-reason envelope — the adapter never runs', async () => {
    let ran = false
    registerLocalAdapter(
      cannedAdapter({
        execute: async () => {
          ran = true
          return { isError: true, message: 'should not run' }
        },
      }),
    )
    const controller = new AbortController()
    controller.abort()
    await expect(runLocalModel(input(), { model: 'canned-1', signal: controller.signal })).rejects.toThrow(
      'local inference aborted',
    )
    expect(ran).toBe(false)
  })

  test('no adapter registered → the canned completion fallback (the pre-runtime posture, unchanged)', async () => {
    const output = await runLocalModel(input({ modelId: 'stub-1' }), {
      model: 'stub-1',
      signal: new AbortController().signal,
    })
    const item = (output as { items: Array<{ content: Array<{ text: string }> }> }).items[0]!
    expect(item.content[0]!.text).toContain('stub-1')
  })

  test('no model configured → the typed error (unchanged)', async () => {
    const output = await runLocalModel(input(), { signal: new AbortController().signal })
    expect(output).toEqual({ isError: true, message: 'no local model configured for the webgpu endpoint' })
  })
})
