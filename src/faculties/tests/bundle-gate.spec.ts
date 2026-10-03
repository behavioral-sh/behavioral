import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { INIT_FRAME_KIND } from '../create-worker.ts'

/**
 * The bundle-clean gate — the controller pattern's serving-contract probe,
 * level 1: every faculty entry BUILDS for the browser target and the artifact
 * BOOTS and speaks the lane. This is the proof that no `node:` import leaked
 * into browser-bundled code: Bun's browser build silently externalizes node
 * builtins to empty shims (the bundle succeeds; the worker dies at eval), so
 * the only honest check is to run the artifact.
 *
 * Level 2 (the classic-bundle WebView probe — the shelf's nested-module-
 * workers finding) lands with the serving contract at the rewire; this gate
 * proves node-freeness + boot + round-trip on the esm artifact.
 */

type BundledResult = { type: string; detail: Record<string, unknown> }

const bootBundledEntry = async (entryUrl: URL): Promise<{ worker: Worker; results: BundledResult[] }> => {
  const built = await Bun.build({ entrypoints: [fileURLToPath(entryUrl)], target: 'browser', format: 'esm' })
  if (!built.success) throw new AggregateError(built.logs, 'browser build failed')
  const artifact = built.outputs[0]!
  const path = join(tmpdir(), `faculty-bundle-${crypto.randomUUID()}.mjs`)
  await Bun.write(path, artifact)
  const worker = new Worker(path)
  const results: BundledResult[] = []
  worker.addEventListener('message', (event: MessageEvent) => {
    results.push(event.data as BundledResult)
  })
  worker.addEventListener('error', (event: ErrorEvent) => {
    results.push({ type: '__worker_error', detail: { message: event.message } })
  })
  return { worker, results }
}

const resultFor = async (results: BundledResult[], id: string, timeoutMs = 10_000): Promise<BundledResult> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = results.find((r) => r.detail?.id === id || r.type === '__worker_error')
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`no result for ${id}; saw: ${JSON.stringify(results)}`)
    await Bun.sleep(10)
  }
}

describe('the bundle-clean gate — faculty entries build and boot for the browser', () => {
  test('system-one: the browser artifact initializes and answers a request', async () => {
    const { worker, results } = await bootBundledEntry(new URL('../system-one.faculty.ts', import.meta.url))
    try {
      worker.postMessage({ kind: INIT_FRAME_KIND, data: {} })
      worker.postMessage({
        type: 'system_one_request',
        detail: { id: 'b1', input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } } },
      })
      const result = await resultFor(results, 'b1')
      expect(result.type).toBe('system_one_request_result')
      // No endpoint configured — the typed error proves the FULL path
      // (init frame → validateInput → respond → envelope) without network.
      expect(result.detail.ok).toBe(false)
      expect((result.detail.error as { message: string }).message).toBe(
        'no model configured for the system one endpoint',
      )
    } finally {
      worker.terminate()
    }
  })

  test('system-two: the browser artifact initializes and answers a request', async () => {
    const { worker, results } = await bootBundledEntry(new URL('../system-two.faculty.ts', import.meta.url))
    try {
      worker.postMessage({ kind: INIT_FRAME_KIND, data: {} })
      worker.postMessage({
        type: 'system_two_request',
        detail: { id: 'b1', input: { provider: 'missing', modelId: 'm', input: [] } },
      })
      const result = await resultFor(results, 'b1')
      expect(result.type).toBe('system_two_request_result')
      expect(result.detail.ok).toBe(false)
      expect((result.detail.error as { message: string }).message).toBe('[Error: unknown provider "missing"]')
    } finally {
      worker.terminate()
    }
  })

  test('frontier: the browser artifact initializes and answers a request', async () => {
    const { worker, results } = await bootBundledEntry(new URL('../remote-system-two.faculty.ts', import.meta.url))
    try {
      worker.postMessage({ kind: INIT_FRAME_KIND, data: {} as JsonObject })
      worker.postMessage({
        type: 'remote_system_two_request',
        detail: { id: 'b1', op: 'replay', input: { threads: [] } },
      })
      const result = await resultFor(results, 'b1')
      expect(result.type).toBe('remote_system_two_request_result')
      expect(result.detail.ok).toBe(true)
    } finally {
      worker.terminate()
    }
  })
})
