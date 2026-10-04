import { describe, expect, test } from 'bun:test'
import { type CompositionDrive, driveComposition } from '../../b-program/tests/composition-drive.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { JsonObject, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import {
  SUPERVISION_DEFAULT_THRESHOLD,
  SUPERVISION_EVENT_TYPES,
  supervisionJudgmentThreads,
  supervisionRecoveryThreads,
  supervisionThreads,
  validateSupervisionHalted,
  validateSupervisionInput,
  validateSupervisionTripped,
} from '../system-one.threads.ts'
import { DECISIONS_MODEL, startDecisionsServer } from './fixtures/decisions-server.ts'

/**
 * The supervision threads against the real engine — the runtime circuit
 * breaker: a count-bounded supervisor watches an event type, blocks the KIND
 * at the threshold (mid-cascade — the block takes effect at the next
 * super-step, before the recursive cascade overflows the stack), and
 * surfaces the trip as a typed selection.
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** A live program with the selection log; threads mount through the real addThread.
 *
 * The bare-engine program serves the NO-judge pins (the counting breaker — the
 * trip is synchronous, no transform in the loop). The judge-interaction pins
 * drive through the REAL composition (judgeDrive below): the supervision
 * pack's transform listeners complete only through the fixed fourth faculty.
 */
const liveProgram = () => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  return { program, selected }
}

const mountAll = (program: ReturnType<typeof behavioral>, threads: Thread[]): void => {
  for (const thread of threads) program.addThread(thread)
}

const count = (selected: Selected[], type: string): number => selected.filter((s) => s.type === type).length

/** The self-sustaining loop: one request rule, no `once` — the unguarded cascade shape. */
const loopThread = (type: string): Thread => ({
  name: `loop(${type})`,
  description: 'The self-sustaining loop cascade under test.',
  rules: [{ request: { type, detail: {} } }],
})

describe('supervision threads — the counting breaker', () => {
  test('a self-sustaining loop trips at the threshold — the type blocks, the cascade stops, the trip surfaces', () => {
    const { program, selected } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    // The self-sustaining loop: one request rule, no `once` — every selection
    // re-requests the same event, the unguarded cascade shape.
    mountAll(program, [
      { name: 'loop', description: 'Test thread.', rules: [{ request: { type: 'leaky', detail: {} } }] },
    ])
    program.trigger({ type: 'pump', detail: {} })

    // The breaker fired mid-cascade: exactly the threshold selections ran,
    // then the block killed the loop (no overflow, no unbounded run).
    expect(count(selected, 'leaky')).toBe(8)
    const trip = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)
    expect(trip).toBeDefined()
    expect(trip?.detail).toEqual({ type: 'leaky', count: 8, threshold: 8 })
    expect(validateSupervisionTripped(trip?.detail)).toBe(true)

    // Surgical halt: the REST of the program keeps running — a fresh
    // non-watched event selects while the watched type stays blocked.
    mountAll(program, [
      { name: 'after', description: 'Test thread.', once: true, rules: [{ request: { type: 'tick', detail: {} } }] },
    ])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'tick')).toBe(1)
    expect(count(selected, 'leaky')).toBe(8)
  })

  test('a long-but-legitimate loop under the threshold runs clean — the breaker is count-bounded, not loop-hostile', () => {
    const { program, selected } = liveProgram()
    // The default threshold (4096, under the ~8.6k cascade overflow) — the
    // supervisor is mounted but never trips on a bounded 20-iteration loop.
    mountAll(program, supervisionThreads({ watch: ['bounded'] }))
    mountAll(program, [
      {
        name: 'legit',
        description: 'Test thread.',
        once: true,
        rules: Array.from({ length: 20 }, () => ({ request: { type: 'bounded', detail: {} } })),
      },
    ])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'bounded')).toBe(20)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)).toBe(false)

    // The watched type was never blocked — later legitimate work still selects.
    mountAll(program, [
      { name: 'more', description: 'Test thread.', once: true, rules: [{ request: { type: 'bounded', detail: {} } }] },
    ])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'bounded')).toBe(21)
  })

  test('the default threshold sits under the ~8.6k cascade overflow', () => {
    expect(SUPERVISION_DEFAULT_THRESHOLD).toBe(4096)
  })

  test('a umwelt-stamped loop trips the root breaker and the type blocks globally — accepted v1 bluntness', () => {
    const { program, selected } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky-s1'], threshold: 4 }))
    // The runaway loop lives in s1; the supervisor is root-mounted — its
    // unstamped listeners watch every umwelt (Direction/R).
    mountAll(program, [
      {
        name: 'loop',
        description: 'Test thread.',
        umwelt: 's1',
        rules: [{ request: { type: 'leaky-s1', detail: {} } }],
      },
    ])
    program.trigger({ type: 'pump', detail: {} })

    expect(count(selected, 'leaky-s1')).toBe(4)
    const trip = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)
    expect(trip).toBeDefined()
    expect(trip?.detail).toEqual({ type: 'leaky-s1', count: 4, threshold: 4 })
    expect(validateSupervisionTripped(trip?.detail)).toBe(true)

    // The block is GLOBAL: the same type in ROOT is blocked too — one
    // umwelt's runaway loop halts the kind everywhere (v1 bluntness; a
    // umwelt-stamped supervisor set confines — expressible, not built).
    mountAll(program, [
      {
        name: 'root-loop',
        description: 'Test thread.',
        once: true,
        rules: [{ request: { type: 'leaky-s1', detail: {} } }],
      },
    ])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'leaky-s1')).toBe(4)
    // ...while the REST of the program keeps running.
    mountAll(program, [
      { name: 'after', description: 'Test thread.', once: true, rules: [{ request: { type: 'tick', detail: {} } }] },
    ])
    program.trigger({ type: 'pump3', detail: {} })
    expect(count(selected, 'tick')).toBe(1)
  })
})

/**
 * The judge-interaction drives — through the REAL composition (the
 * transform-faculty ruling): the supervision pack's transform listeners (the
 * judge-request mapping, the verdict division, the recovery re-issues)
 * complete only through the fixed fourth faculty, and the judge itself is a
 * REAL systemOne faculty over a fixture endpoint — the choreography is async
 * and every hop polls. The probes ride as ingress triggers (the blocked kind
 * stays unselected; a free type selects) — the composition has no mid-run
 * addThread.
 */
const judgeDrive = async ({
  watch,
  threshold,
  maxReissues,
  recovery = false,
  fixture,
}: {
  watch: string[]
  threshold: number
  maxReissues?: number
  recovery?: boolean
  fixture?: Parameters<typeof startDecisionsServer>[0]
}): Promise<{ drive: CompositionDrive; server: Awaited<ReturnType<typeof startDecisionsServer>> }> => {
  const server = await startDecisionsServer(fixture)
  const drive = driveComposition({
    threads: [
      ...supervisionThreads({ watch, threshold }),
      ...supervisionJudgmentThreads,
      ...(recovery
        ? supervisionRecoveryThreads({ watch, threshold, ...(maxReissues === undefined ? {} : { maxReissues }) })
        : []),
      loopThread('leaky'),
    ],
    models: { systemOne: { url: server.url, model: DECISIONS_MODEL } as unknown as JsonObject },
  })
  return { drive, server }
}

const judgeRequestCount = (selected: Selected[], watchedType: string): number =>
  selected.filter(
    (s) =>
      s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string) === `${watchedType}-supervision`,
  ).length

const judgeRequestDetail = (selected: Selected[], watchedType: string): Selected | undefined =>
  selected.find(
    (s) =>
      s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string) === `${watchedType}-supervision`,
  )

/** The declined transform results — the post-switch noise class (the retired transform_error kind). */
const declined = (selected: Selected[]): Selected[] =>
  selected.filter(
    (s) => s.type === FACULTY_MESSAGE_KINDS.transform_request_result && (s.detail as { ok?: boolean })?.ok === false,
  )

describe('supervision threads — block-then-judge', () => {
  test('approve: the judge lifts the block — the release fires, the counter resets, the loop resumes', async () => {
    // The fixture answers the FIRST decision (lift) and hangs the rest — the
    // second trip's judgment stays in flight, so the block holds at the end
    // state (the old harness held it with an unanswered manual feed).
    const { drive, server } = await judgeDrive({ watch: ['leaky'], threshold: 8, fixture: { hangAfter: 1 } })
    try {
      // The first trip: the block kills the loop at the threshold; the judge
      // lifts; the loop resumes with a FRESH count and trips again at 16.
      await drive.waitUntil((sel) => count(sel, 'leaky') >= 16)
      expect(count(drive.selected, 'leaky')).toBe(16)
      expect(count(drive.selected, SUPERVISION_EVENT_TYPES.tripped)).toBe(2)
      const release = drive.selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.release)
      expect(release?.detail).toEqual({ type: 'leaky' })
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.halted)).toBe(false)
      // The second judgment in flight (the fixture hangs) — the block holds.
      await drive.waitUntil((sel) => judgeRequestCount(sel, 'leaky') >= 2)
      // The issued Decision input rides the one input home.
      expect(validateSupervisionInput(judgeRequestDetail(drive.selected, 'leaky')?.detail?.input)).toBe(true)
      // The verdict division is total — no declining listener on any branch.
      expect(declined(drive.selected)).toHaveLength(0)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('reject: the halt holds the block — supervision_halted surfaces, the loop stays dead', async () => {
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      fixture: { pickChoice: 'halt', hangAfter: 1 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)
      const halted = drive.selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.halted)
      expect(halted?.detail).toEqual({ type: 'leaky' })
      expect(validateSupervisionHalted(halted?.detail)).toBe(true)
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
      expect(count(drive.selected, 'leaky')).toBe(8)

      // The block HOLDS: a later request for the watched type stays blocked
      // (the ingress trigger stays unselected), while a non-watched event
      // still selects — the halt is surgical.
      drive.trigger({ type: 'leaky', detail: {} } as never)
      await drive.settle()
      expect(count(drive.selected, 'leaky')).toBe(8)
      drive.trigger({ type: 'tick', detail: {} } as never)
      await drive.waitUntil((sel) => count(sel, 'tick') >= 1)
      expect(count(drive.selected, 'leaky')).toBe(8)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('fail-visible: an unavailable judge holds the block and surfaces the halt with the reason', async () => {
    // The first decision rate-limits (429 — the faculty's error branch): the
    // block HOLDS and the halt surfaces WITH the judge-failure reason.
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      // The faculty RETRIES 429s (4 attempts) — every request must rate-limit
      // for the judgment to fail through to the halt.
      fixture: { rateLimitFirst: 99 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)
      const halted = drive.selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.halted)
      expect((halted?.detail as { reason?: string })?.reason).toContain('HTTP 429')
      expect(validateSupervisionHalted(halted?.detail)).toBe(true)
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)

      // The block holds — the loop stays dead.
      drive.trigger({ type: 'leaky', detail: {} } as never)
      await drive.settle()
      expect(count(drive.selected, 'leaky')).toBe(8)
      expect(declined(drive.selected)).toHaveLength(0)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('a malformed judge answer surfaces the halt — never an invisible hold', async () => {
    // The fixture answers junk: the systemOne faculty's OUTPUT SCHEMA rejects
    // it (the answers envelope is strict) — the judge result comes back the
    // typed error and the halt surfaces WITH the reason. The old harness fed
    // the junk past the faculty (a bare-engine manual feed); through the
    // composition the schema gate is the first line — the pin's intent (a
    // malformed answer never passes silently) holds at the faculty boundary.
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      fixture: { junkAnswer: true, hangAfter: 1 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)
      const halted = drive.selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.halted)
      expect((halted?.detail as { type?: string })?.type).toBe('leaky')
      expect(typeof (halted?.detail as { reason?: string })?.reason).toBe('string')
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
      drive.trigger({ type: 'leaky', detail: {} } as never)
      await drive.settle()
      expect(count(drive.selected, 'leaky')).toBe(8)
      expect(declined(drive.selected)).toHaveLength(0)
    } finally {
      drive.terminate()
      await server.close()
    }
  })
})

describe('supervision threads — recovery', () => {
  test('judge-retry: an unjudged halt re-issues the Decision — a later lift lifts the block', async () => {
    // The first decision 429s (the halt + the re-issue); the RE-ISSUE is the
    // second ANSWERED decision (lift); the second trip's judgment hangs.
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      recovery: true,
      // The faculty RETRIES 429s (4 attempts): rate-limit the first FOUR
      // requests so the FIRST decision fails through to the halt; the
      // RE-ISSUE then answers (lift); the second trip's judgment hangs.
      fixture: { rateLimitFirst: 4, hangAfter: 1 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, 'leaky') >= 8)
      await drive.waitUntil((sel) => judgeRequestCount(sel, 'leaky') >= 1)

      // The judge was unavailable — the halt surfaced with the reason, and the
      // retry thread re-issued the SAME Decision (bounded, re-armed on release).
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)
      await drive.waitUntil((sel) => judgeRequestCount(sel, 'leaky') >= 2)

      // The re-ask succeeds: the lift releases the block, the loop resumes,
      // and the fresh counter trips again — recovery proven end-to-end.
      await drive.waitUntil((sel) => sel.some((s) => s.type === SUPERVISION_EVENT_TYPES.release))
      await drive.waitUntil((sel) => count(sel, 'leaky') >= 16)
      expect(count(drive.selected, 'leaky')).toBe(16)
      expect(count(drive.selected, SUPERVISION_EVENT_TYPES.tripped)).toBe(2)
      expect(declined(drive.selected)).toHaveLength(0)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('judge-retry is bounded: repeated judge failures exhaust the re-issues — the halt stands', async () => {
    // Every decision rate-limits: the initial issue plus exactly MAX_REISSUES
    // re-issues — then the standing halt gets no further re-ask.
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      maxReissues: 2,
      recovery: true,
      fixture: { rateLimitFirst: 99 },
    })
    try {
      await drive.waitUntil((sel) => judgeRequestCount(sel, 'leaky') >= 1 + 2)
      await drive.settle()
      expect(count(drive.selected, SUPERVISION_EVENT_TYPES.halted)).toBe(1 + 2)
      expect(judgeRequestCount(drive.selected, 'leaky')).toBe(1 + 2)
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
      // The block holds — the loop stays dead.
      drive.trigger({ type: 'leaky', detail: {} } as never)
      await drive.settle()
      expect(count(drive.selected, 'leaky')).toBe(8)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('a judged halt (no reason) never re-issues — the judge spoke', async () => {
    // The halt CHOICE carries no reason — the judged halt is the judge's
    // answer; the retry listener's gate (reason required) never matches.
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      recovery: true,
      fixture: { pickChoice: 'halt', hangAfter: 1 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)
      await drive.settle()
      expect(judgeRequestCount(drive.selected, 'leaky')).toBe(1)
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('override: the host ingress lifts the block immediately — the human decision path', async () => {
    // The judge is down and the budget is zero (no re-issues): the standing
    // halt waits for the host's override ingress — the block lifts, the loop
    // resumes, and the fresh count trips again.
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      maxReissues: 0,
      recovery: true,
      fixture: { rateLimitFirst: 99 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)
      drive.trigger({ type: SUPERVISION_EVENT_TYPES.override, detail: { type: 'leaky' } } as never)
      await drive.waitUntil((sel) => sel.some((s) => s.type === SUPERVISION_EVENT_TYPES.release))
      await drive.waitUntil((sel) => count(sel, 'leaky') >= 16)
      expect(count(drive.selected, 'leaky')).toBe(16)
      expect(declined(drive.selected)).toHaveLength(0)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('a malformed override never matches — the boundary is the schema', async () => {
    const { drive, server } = await judgeDrive({
      watch: ['leaky'],
      threshold: 8,
      maxReissues: 0,
      recovery: true,
      fixture: { rateLimitFirst: 99 },
    })
    try {
      await drive.waitUntil((sel) => count(sel, SUPERVISION_EVENT_TYPES.halted) >= 1)

      // Junk detail: the override listener's gate never matches, no release —
      // the override boundary is the AJV schema at the listener.
      drive.trigger({ type: SUPERVISION_EVENT_TYPES.override, detail: { type: 42 } } as never)
      await drive.settle()
      expect(drive.selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
      expect(count(drive.selected, 'leaky')).toBe(8)
    } finally {
      drive.terminate()
      await server.close()
    }
  })
})

describe('supervision threads — the Decision shapes', () => {
  test('the issued judgment input validates against the input schema home', async () => {
    const { drive, server } = await judgeDrive({ watch: ['leaky'], threshold: 8, fixture: { hangAfter: 1 } })
    try {
      await drive.waitUntil((sel) => judgeRequestCount(sel, 'leaky') >= 1)
      const request = judgeRequestDetail(drive.selected, 'leaky')
      const input = request?.detail?.input as
        | {
            state?: { lane?: string; type?: string; count?: number; threshold?: number }
            questions?: Record<string, { type?: string }>
          }
        | undefined
      expect(input?.state?.lane).toBe('supervision')
      expect(input?.state?.type).toBe('leaky')
      expect(input?.state?.count).toBe(8)
      expect(input?.state?.threshold).toBe(8)
      expect(input?.questions?.supervision?.type).toBe('choice')
      expect(validateSupervisionInput(request?.detail?.input)).toBe(true)
    } finally {
      drive.terminate()
      await server.close()
    }
  })
})

describe('supervision judgment — the live Jev API via OpenRouter (opt-in: OPENROUTER_API_KEY)', () => {
  const key = process.env.OPENROUTER_API_KEY
  const liveTest = key === undefined ? test.skip : test

  liveTest('a real trip judges against the live endpoint — the answer maps through the verdict', async () => {
    // The whole judgment lane against the LIVE endpoint through the REAL
    // composition: the trip issues the request (the threads' own output), the
    // composition's systemOne faculty speaks OpenRouter's Decisions API, and the real
    // answer maps back through the verdict. Whichever way the model calls it,
    // exactly one of the two outcomes fires with a conforming shape.
    const drive = driveComposition({
      threads: [
        ...supervisionThreads({ watch: ['leaky'], threshold: 8 }),
        ...supervisionJudgmentThreads,
        loopThread('leaky'),
      ],
      models: {
        systemOne: {
          url: 'https://openrouter.ai/api/alpha/decisions',
          apiKey: key as string,
          model: 'typesafe/jev-1.13',
        } as unknown as JsonObject,
      },
    })
    try {
      await drive.waitUntil(
        (sel) =>
          sel.some((s) => s.type === SUPERVISION_EVENT_TYPES.release || s.type === SUPERVISION_EVENT_TYPES.halted),
        60_000,
      )
      const judgeRequest = judgeRequestDetail(drive.selected, 'leaky')
      expect(judgeRequest).toBeDefined()
      expect(validateSupervisionInput(judgeRequest?.detail?.input)).toBe(true)
      const outcomes = drive.selected.filter(
        (s) => s.type === SUPERVISION_EVENT_TYPES.release || s.type === SUPERVISION_EVENT_TYPES.halted,
      )
      expect(outcomes).toHaveLength(1)
      const [outcome] = outcomes
      const lifted = outcome?.type === SUPERVISION_EVENT_TYPES.release
      if (lifted) {
        expect(outcome?.detail).toEqual({ type: 'leaky' })
      } else {
        expect(validateSupervisionHalted(outcome?.detail)).toBe(true)
      }
      expect(declined(drive.selected)).toHaveLength(0)
    } finally {
      drive.terminate()
    }
  })
})
