import { describe, expect, test } from 'bun:test'
import type { BPEvent, Thread } from '../../behavioral/behavioral.types.ts'
import {
  fixtureCancelEvent,
  fixtureRequestEvent,
  validateFixtureCancelEvent,
  validateFixtureRequestEvent,
} from '../../faculties/tests/fixtures/create-worker-fixture.worker.ts'
import { useWorker } from '../use-worker.ts'

/**
 * The use-worker specs — the composition-side half of the worker lane, and
 * the lane's ROUND-TRIP PIN: `useWorker` ↔ `createWorker` over a real Bun
 * web Worker running the fixture faculty entry directly — request out,
 * result in as a once-thread, crash → one `faculty_error`, next send
 * respawns through the factory.
 */

/** The spec's addThreads collector — real Thread shapes, as the engine receives them. */
const collector = (): { addThreads: (threads: Thread[]) => void; threads: Thread[] } => {
  const threads: Thread[] = []
  return { addThreads: (added) => threads.push(...added), threads }
}

/** Wait until the collector holds a thread matching `pred` (or throw past the deadline). */
const threadWhere = async (threads: Thread[], pred: (thread: Thread) => boolean, timeoutMs = 5000): Promise<Thread> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = threads.find((thread) => pred(thread))
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`no matching thread; saw: ${JSON.stringify(threads, null, 2)}`)
    await Bun.sleep(10)
  }
}

describe('useWorker — the composition-side worker wiring', () => {
  test('invalidEventGate accepts request/cancel shapes and nothing else, without constructing a worker', () => {
    const factoryCalls: number[] = []
    const wiring = useWorker({
      name: 'fixture',
      worker: () => {
        factoryCalls.push(1)
        throw new Error('the factory must never run for a pure gate check')
      },
      validateRequest: validateFixtureRequestEvent,
      validateCancel: validateFixtureCancelEvent,
      resultKind: 'fixture_request_result',
    })(collector().addThreads)

    expect(wiring.name).toBe('fixture')
    const gate = wiring.invalidEventGate
    expect(gate(fixtureRequestEvent({ id: 'g1', input: { op: 'echo' } }) as BPEvent)).toBe(false)
    expect(gate(fixtureCancelEvent({ id: 'g1' }) as BPEvent)).toBe(false)
    expect(gate({ type: 'wrong_kind', detail: { id: 'g1' } } as BPEvent)).toBe(true)
    expect(gate({ type: 'fixture_request', detail: 'not an object' } as unknown as BPEvent)).toBe(true)
    // The lane is lazy — the factory runs on the first send, not at wiring.
    expect(factoryCalls).toHaveLength(0)
  })
})

/** Boot the fixture worker behind a useWorker wiring, with a counting factory. */
const wiredFixture = (): {
  wiring: ReturnType<ReturnType<typeof useWorker>>
  threads: Thread[]
  factoryCalls: number[]
} => {
  const collectorResult = collector()
  const factoryCalls: number[] = []
  const wiring = useWorker({
    name: 'fixture',
    worker: () => {
      factoryCalls.push(1)
      return new Worker(new URL('../../faculties/tests/fixtures/create-worker-fixture.worker.ts', import.meta.url))
    },
    validateRequest: validateFixtureRequestEvent,
    validateCancel: validateFixtureCancelEvent,
    resultKind: 'fixture_request_result',
  })(collectorResult.addThreads)
  return { wiring, threads: collectorResult.threads, factoryCalls }
}

describe('useWorker ↔ createWorker — the round-trip pin over a real Bun Worker', () => {
  test('request out, result in as a once-thread, space preserved', async () => {
    const { wiring, threads } = wiredFixture()
    wiring.send(fixtureRequestEvent({ id: 'r1', input: { op: 'echo', message: 'hi' }, space: 'space-a' }) as BPEvent)
    const thread = await threadWhere(threads, (t) => t.label === 'on_fixture_request_result_r1')
    expect(thread).toEqual({
      space: 'space-a',
      label: 'on_fixture_request_result_r1',
      once: true,
      rules: [
        {
          request: {
            type: 'fixture_request_result',
            detail: { id: 'r1', ok: true, result: { op: 'echo', message: 'hi', seenData: true } },
          },
        },
      ],
    })
    wiring.terminate()
  })

  test('crash → exactly ONE faculty_error; the in-flight request never answers', async () => {
    const { wiring, threads } = wiredFixture()
    wiring.send(fixtureRequestEvent({ id: 'in-flight', input: { op: 'crash' } }) as BPEvent)
    const error = await threadWhere(threads, (t) => t.label.startsWith('on_faculty_error_crash_'))
    // Exactly one synthesis — and no result thread for the in-flight request.
    const errorThreads = threads.filter((t) => t.label.startsWith('on_faculty_error_crash_'))
    expect(errorThreads).toHaveLength(1)
    // The message text is runtime-specific (Bun embeds the stack dump); the
    // faculty attribution and the crash prefix are the pin's contract.
    const request = error.rules[0]?.request
    expect(request?.type).toBe('faculty_error')
    const detail = request?.detail
    expect(detail?.faculty).toBe('fixture')
    expect(typeof detail?.message).toBe('string')
    expect(String(detail?.message)).toStartWith('worker crashed:')
    expect(detail?.id).toEqual(error.label.replace('on_faculty_error_', ''))
    // The in-flight request's id never re-entered as a result.
    expect(threads.some((t) => t.label.includes('in-flight'))).toBe(false)
    wiring.terminate()
  })

  test('the next send respawns through the factory', async () => {
    const { wiring, threads, factoryCalls } = wiredFixture()
    wiring.send(fixtureRequestEvent({ id: 'crash-1', input: { op: 'crash' } }) as BPEvent)
    await threadWhere(threads, (t) => t.label.startsWith('on_faculty_error_crash_'))
    expect(factoryCalls).toHaveLength(1)
    wiring.send(fixtureRequestEvent({ id: 'after', input: { op: 'echo' } }) as BPEvent)
    await threadWhere(threads, (t) => t.label === 'on_fixture_request_result_after')
    expect(factoryCalls).toHaveLength(2)
    wiring.terminate()
  })

  test('terminate kills the lane — sends after it construct nothing, answer nothing', async () => {
    const { wiring, threads, factoryCalls } = wiredFixture()
    wiring.terminate()
    wiring.send(fixtureRequestEvent({ id: 'dead', input: { op: 'echo' } }) as BPEvent)
    wiring.send(fixtureCancelEvent({ id: 'dead' }))
    await Bun.sleep(100)
    expect(factoryCalls).toHaveLength(0)
    expect(threads).toEqual([])
  })
})
