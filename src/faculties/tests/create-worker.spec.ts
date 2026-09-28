import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { INIT_FRAME_KIND, type InitFrame } from '../create-worker.ts'

/**
 * The create-worker specs — the faculty-side half of the worker lane,
 * proven against REAL Bun web Workers running the fixture entry directly
 * (Bun's Worker needs no bundling). Every case boots its own worker, posts
 * the init frame (the construction message — the config's only channel),
 * and drives the unchanged wire: request in, `fixture_request_result` out.
 */

const initFrame = (data: JsonObject): InitFrame => ({ kind: INIT_FRAME_KIND, data })

type FixtureResult = {
  type: string
  detail: Record<string, unknown>
  space?: string
}

type FixtureErrors = string[]

/** Boot a fixture worker, post its init frame, expose a correlated wait. */
const spawnFixture = (initData: JsonObject = { fixture: true }) => {
  const worker = new Worker(new URL('./fixtures/create-worker-fixture.worker.ts', import.meta.url))
  worker.postMessage(initFrame(initData))
  const results: FixtureResult[] = []
  const errors: FixtureErrors = []
  worker.addEventListener('message', (event: MessageEvent) => {
    results.push(event.data as FixtureResult)
  })
  worker.addEventListener('error', (event: ErrorEvent) => {
    errors.push(event.message)
  })
  const resultFor = async (id: string, timeoutMs = 5000): Promise<FixtureResult> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = results.find((result) => result.type === 'fixture_request_result' && result.detail.id === id)
      if (found !== undefined) return found
      if (Date.now() > deadline)
        throw new Error(
          `no result for ${id}; saw: ${JSON.stringify(results)}; worker errors: ${JSON.stringify(errors)}`,
        )
      await Bun.sleep(10)
    }
  }
  return { worker, results, errors, resultFor }
}

describe('createWorker — the in-worker bootstrap over a real Bun Worker', () => {
  test('a valid request round-trips to an ok result', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 'r1', input: { op: 'echo', message: 'hi' } } })
    const result = await resultFor('r1')
    expect(result.type).toBe('fixture_request_result')
    expect(result.detail).toEqual({
      id: 'r1',
      ok: true,
      result: { op: 'echo', message: 'hi', seenData: true },
    })
    worker.terminate()
  })

  test('an isError respond result maps to the error envelope', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 'e1', input: { op: 'fail', message: 'nope' } } })
    const result = await resultFor('e1')
    expect(result.detail).toEqual({ id: 'e1', ok: false, error: { code: 'error', message: 'nope' } })
    worker.terminate()
  })

  test('input failing the boundary is error data, not a dead lane', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 'i1', input: { nope: true } } })
    const result = await resultFor('i1')
    expect(result.detail.ok).toBe(false)
    expect((result.detail.error as { message: string }).message).toContain('invalid input')
    // The lane stays alive — a valid request after the rejection still answers.
    worker.postMessage({ type: 'fixture_request', detail: { id: 'i2', input: { op: 'echo' } } })
    const follow = await resultFor('i2')
    expect(follow.detail.ok).toBe(true)
    worker.terminate()
  })

  test('the request space echoes on the result', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 's1', input: { op: 'echo' } }, space: 'space-a' })
    const result = await resultFor('s1')
    expect(result.space).toBe('space-a')
    worker.terminate()
  })

  test('the request ctx echoes on the result detail (the out-of-band join lane)', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 'c1', input: { op: 'echo' }, ctx: { join: 'lane' } } })
    const result = await resultFor('c1')
    expect(result.detail.ctx).toEqual({ join: 'lane' })
    // No ctx in — no ctx out.
    worker.postMessage({ type: 'fixture_request', detail: { id: 'c2', input: { op: 'echo' } } })
    const bare = await resultFor('c2')
    expect('ctx' in bare.detail).toBe(false)
    worker.terminate()
  })

  test('a cancel mid-flight aborts the pending call to the canceled result', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 'x1', input: { op: 'hang' } } })
    worker.postMessage({ type: 'fixture_cancel', detail: { id: 'x1' } })
    const result = await resultFor('x1')
    expect(result.detail).toEqual({ id: 'x1', ok: false, error: { code: 'error', message: 'request canceled' } })
    worker.terminate()
  })

  test('an in-flight call past the timeout aborts to the timeout result', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 't1', input: { op: 'hang' } } })
    const result = await resultFor('t1')
    expect(result.detail).toEqual({
      id: 't1',
      ok: false,
      error: { code: 'error', message: 'request timed out after 200ms' },
    })
    worker.terminate()
  })

  test('timeoutMs 0 means no timer — the call stays in flight past the default window', async () => {
    const worker = new Worker(new URL('./fixtures/create-worker-no-timeout-fixture.worker.ts', import.meta.url))
    worker.postMessage(initFrame({}))
    const results: FixtureResult[] = []
    worker.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data as FixtureResult)
    })
    try {
      worker.postMessage({ type: 'fixture_request', detail: { id: 'nt1', input: { op: 'hang' } } })
      // The default window (200ms in the main fixture) would have fired; the
      // no-timer faculty's hang call must still be in flight well past it.
      await Bun.sleep(450)
      expect(results).toEqual([])
    } finally {
      worker.terminate()
    }
  })

  test('a throwing respond becomes error data, never a dead worker', async () => {
    const { worker, resultFor } = spawnFixture()
    worker.postMessage({ type: 'fixture_request', detail: { id: 'p1', input: { op: 'throw' } } })
    const result = await resultFor('p1')
    expect(result.detail).toEqual({ id: 'p1', ok: false, error: { code: 'error', message: 'fixture respond threw' } })
    // And the worker still answers the next request.
    worker.postMessage({ type: 'fixture_request', detail: { id: 'p2', input: { op: 'echo' } } })
    const follow = await resultFor('p2')
    expect(follow.detail.ok).toBe(true)
    worker.terminate()
  })

  test('malformed inbound is ignored, fail-closed', async () => {
    const { worker, results, resultFor } = spawnFixture()
    worker.postMessage('not an object')
    worker.postMessage({ type: 'fixture_request' }) // no detail
    worker.postMessage({ type: 'wrong_kind', detail: { id: 'm1', input: { op: 'echo' } } })
    worker.postMessage({ type: 'fixture_request', detail: { id: 'm2', input: { op: 'echo' } } })
    const result = await resultFor('m2')
    expect(result.detail.ok).toBe(true)
    // Nothing from the malformed batch leaked into the lane.
    expect(results.filter((r) => r.type === 'fixture_request_result')).toHaveLength(1)
    worker.terminate()
  })
})

describe('createWorker — the init frame (the construction message)', () => {
  test('a request before init answers the typed error — fail-closed, no silent empty-config run', async () => {
    const worker = new Worker(new URL('./fixtures/create-worker-fixture.worker.ts', import.meta.url))
    const results: FixtureResult[] = []
    worker.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data as FixtureResult)
    })
    try {
      // No init frame — the request arrives with no config at all.
      worker.postMessage({ type: 'fixture_request', detail: { id: 'pre1', input: { op: 'echo' } } })
      const deadline = Date.now() + 5000
      let result: FixtureResult | undefined
      for (;;) {
        result = results.find((r) => r.detail.id === 'pre1')
        if (result !== undefined || Date.now() > deadline) break
        await Bun.sleep(10)
      }
      expect(result?.detail).toEqual({
        id: 'pre1',
        ok: false,
        error: { code: 'error', message: 'faculty not initialized: no init frame received' },
      })
    } finally {
      worker.terminate()
    }
  })

  test('an invalid init frame is ignored; a valid one initializes and re-init overwrites', async () => {
    const { worker, resultFor } = spawnFixture()
    try {
      // Garbage frames — non-object data, arrays, wrong kind — change nothing.
      worker.postMessage({ kind: INIT_FRAME_KIND, data: 'not an object' })
      worker.postMessage({ kind: INIT_FRAME_KIND, data: [1, 2] })
      worker.postMessage({ kind: 'other', data: { fixture: false } })
      worker.postMessage({ type: 'fixture_request', detail: { id: 'iv1', input: { op: 'echo' } } })
      const untouched = await resultFor('iv1')
      expect((untouched.detail.result as { seenData: boolean }).seenData).toBe(true)

      // Re-init overwrites — the forward-compatible config-update channel.
      worker.postMessage(initFrame({ fixture: false }))
      worker.postMessage({ type: 'fixture_request', detail: { id: 'iv2', input: { op: 'echo' } } })
      const overwritten = await resultFor('iv2')
      expect((overwritten.detail.result as { seenData: boolean }).seenData).toBe(false)
    } finally {
      worker.terminate()
    }
  })
})

describe('createWorker — the scope gate', () => {
  test('importing a faculty entry in the main thread wires nothing', async () => {
    // Assert the branch first: outside a worker global, createWorker no-ops.
    const mod = (await import('./fixtures/create-worker-fixture.worker.ts')) as {
      wiring: string | undefined
    }
    expect(mod.wiring).toBeUndefined()
  })
})
