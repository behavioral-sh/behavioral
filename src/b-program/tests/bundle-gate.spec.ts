import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The composition bundle gate — the bundle-clean gate's composition side: the
 * bProgram worker entry BUILDS for the browser target and the artifact BOOTS
 * and speaks the port protocol (attach → hello with the validated engine
 * identity). Same proof shape as the faculties gate: Bun's browser build
 * silently externalizes node builtins to empty shims (the bundle succeeds;
 * the worker dies at eval), so the only honest check is to run the artifact.
 *
 * The entry is a library shape — `runCompositionWorker` is the boot seam the
 * serving contract wraps (the self-booting wrapper is slice 4's deliverable,
 * the shelf's fixture-entry precedent). The gate bundles through the same
 * wrapper shape a serving side will emit.
 */

type HelloFrame = { kind: string; umwelt?: string; identity?: { instanceId?: string; sessionId?: string } }

describe('the composition bundle gate — the worker entry builds and boots for the browser', () => {
  test('b-program.worker: the browser artifact boots and answers attach with a hello', async () => {
    const built = await Bun.build({
      entrypoints: ['/virtual-entry.ts'],
      files: {
        '/virtual-entry.ts': `import { runCompositionWorker } from ${JSON.stringify(
          fileURLToPath(new URL('../b-program.worker.ts', import.meta.url)),
        )}\nrunCompositionWorker()\n`,
      },
      target: 'browser',
      format: 'esm',
    })
    if (!built.success) throw new AggregateError(built.logs, 'browser build failed')
    const artifact = built.outputs[0]!
    const path = join(tmpdir(), `b-program-bundle-${crypto.randomUUID()}.mjs`)
    await Bun.write(path, artifact)
    const worker = new Worker(path)
    const frames: Array<Record<string, unknown>> = []
    worker.addEventListener('message', (event: MessageEvent) => {
      frames.push(event.data as Record<string, unknown>)
    })
    worker.addEventListener('error', (event: ErrorEvent) => {
      frames.push({ kind: '__worker_error', message: event.message })
    })
    try {
      worker.postMessage({ kind: 'attach' })
      const deadline = Date.now() + 20_000
      let hello: HelloFrame | undefined
      while (Date.now() < deadline) {
        hello = frames.find((f) => f.kind === 'hello') as HelloFrame | undefined
        if (hello !== undefined) break
        if (frames.some((f) => f.kind === '__worker_error'))
          throw new Error(`worker died: ${JSON.stringify(frames.find((f) => f.kind === '__worker_error'))}`)
        await Bun.sleep(10)
      }
      expect(hello).toBeDefined()
      const identity = hello?.identity
      expect(typeof identity?.instanceId).toBe('string')
      const instanceId = identity?.instanceId ?? ''
      expect(instanceId.startsWith('bp_')).toBe(true)
      // The minted umwelt: an attach without a umwelt claim mints one.
      const umwelt = hello?.umwelt ?? ''
      expect(umwelt.startsWith('tab_')).toBe(true)
    } finally {
      worker.terminate()
    }
  }, 30_000)
})
