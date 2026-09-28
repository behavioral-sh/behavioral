import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { JsonObject, SelectionTrace, Thread, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { spawnFaculty } from '../../tests/faculty-harness.ts'
import {
  SUPERVISION_DEFAULT_THRESHOLD,
  SUPERVISION_EVENT_TYPES,
  SUPERVISION_MAX_REISSUES,
  supervisionJudgmentThreads,
  supervisionRecoveryThreads,
  supervisionThreads,
  validateSupervisionHalted,
  validateSupervisionInput,
  validateSupervisionTripped,
} from '../threads.ts'
import { SYSTEM_ONE_ENDPOINT_KEY } from '../types.ts'

/**
 * The supervision threads against the real engine — the runtime circuit
 * breaker: a count-bounded supervisor watches an event type, blocks the KIND
 * at the threshold (mid-cascade — the block takes effect at the next
 * super-step, before the recursive cascade overflows the stack), and
 * surfaces the trip as a typed selection.
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** A live program with the selection log; threads mount through the real addThread. */
const liveProgram = () => {
  const program = behavioral()
  const selected: Selected[] = []
  const transformErrors: Trace[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
    if (trace.kind === TRACE_MESSAGE_KINDS.transform_error) transformErrors.push(trace)
  })
  return { program, selected, transformErrors }
}

const mountAll = (program: ReturnType<typeof behavioral>, threads: Thread[]): void => {
  for (const thread of threads) program.addThread(thread)
}

const count = (selected: Selected[], type: string): number => selected.filter((s) => s.type === type).length

/** The self-sustaining loop: one request rule, no `once` — the unguarded cascade shape. */
const loopThread = (type: string): Thread => ({ label: `loop(${type})`, rules: [{ request: { type, detail: {} } }] })

/** Feed one ingress event through a once-producer and pump the cascade. */
const feed = (
  program: ReturnType<typeof behavioral>,
  event: { type: string; detail?: unknown },
  pump: string,
): void => {
  program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event as never }] })
  program.trigger({ type: pump, detail: {} })
}

/** The correlated judge result — a choice answer on the `supervision` question. */
const judgeChoiceResult = (watchedType: string, choice: string): { type: string; detail: unknown } => ({
  type: FACULTY_MESSAGE_KINDS.system_one_request_result,
  detail: {
    id: `${watchedType}-supervision`,
    ok: true,
    result: { model: 'jev-1.13.0', answers: { supervision: { type: 'choice', choice } } },
  },
})

/** The judge-unavailable result — the faculty's error branch, ok false. */
const judgeErrorResult = (watchedType: string, message: string): { type: string; detail: unknown } => ({
  type: FACULTY_MESSAGE_KINDS.system_one_request_result,
  detail: { id: `${watchedType}-supervision`, ok: false, error: { code: 'error', message } },
})

describe('supervision threads — the counting breaker', () => {
  test('a self-sustaining loop trips at the threshold — the type blocks, the cascade stops, the trip surfaces', () => {
    const { program, selected } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    // The self-sustaining loop: one request rule, no `once` — every selection
    // re-requests the same event, the unguarded cascade shape.
    mountAll(program, [{ label: 'loop', rules: [{ request: { type: 'leaky', detail: {} } }] }])
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
    mountAll(program, [{ label: 'after', once: true, rules: [{ request: { type: 'tick', detail: {} } }] }])
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
        label: 'legit',
        once: true,
        rules: Array.from({ length: 20 }, () => ({ request: { type: 'bounded', detail: {} } })),
      },
    ])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'bounded')).toBe(20)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)).toBe(false)

    // The watched type was never blocked — later legitimate work still selects.
    mountAll(program, [{ label: 'more', once: true, rules: [{ request: { type: 'bounded', detail: {} } }] }])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'bounded')).toBe(21)
  })

  test('the default threshold sits under the ~8.6k cascade overflow', () => {
    expect(SUPERVISION_DEFAULT_THRESHOLD).toBe(4096)
  })

  test('a space-stamped loop trips the root breaker and the type blocks globally — accepted v1 bluntness', () => {
    const { program, selected } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky-s1'], threshold: 4 }))
    // The runaway loop lives in s1; the supervisor is root-mounted — its
    // unstamped listeners watch every space (Direction/R).
    mountAll(program, [{ label: 'loop', space: 's1', rules: [{ request: { type: 'leaky-s1', detail: {} } }] }])
    program.trigger({ type: 'pump', detail: {} })

    expect(count(selected, 'leaky-s1')).toBe(4)
    const trip = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)
    expect(trip).toBeDefined()
    expect(trip?.detail).toEqual({ type: 'leaky-s1', count: 4, threshold: 4 })
    expect(validateSupervisionTripped(trip?.detail)).toBe(true)

    // The block is GLOBAL: the same type in ROOT is blocked too — one
    // space's runaway loop halts the kind everywhere (v1 bluntness; a
    // space-stamped supervisor set confines — expressible, not built).
    mountAll(program, [{ label: 'root-loop', once: true, rules: [{ request: { type: 'leaky-s1', detail: {} } }] }])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'leaky-s1')).toBe(4)
    // ...while the REST of the program keeps running.
    mountAll(program, [{ label: 'after', once: true, rules: [{ request: { type: 'tick', detail: {} } }] }])
    program.trigger({ type: 'pump3', detail: {} })
    expect(count(selected, 'tick')).toBe(1)
  })
})

describe('supervision threads — block-then-judge', () => {
  test('approve: the judge lifts the block — the release fires, the counter resets, the loop resumes', () => {
    const { program, selected, transformErrors } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)
    expect(count(selected, SUPERVISION_EVENT_TYPES.tripped)).toBe(1)

    // The judge approves: the lift maps to a release for the watched type.
    feed(program, judgeChoiceResult('leaky', 'lift'), 'pump2')
    const release = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.release)
    expect(release).toBeDefined()
    expect(release?.detail).toEqual({ type: 'leaky' })
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.halted)).toBe(false)

    // The block lifted and the counter RESET: the loop resumed its cascade,
    // counted a fresh threshold, and tripped again — the second judgment is
    // in flight (unanswered), so the block holds once more.
    expect(count(selected, 'leaky')).toBe(16)
    expect(count(selected, SUPERVISION_EVENT_TYPES.tripped)).toBe(2)
    const judgeRequests = selected.filter(
      (s) => s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string) === 'leaky-supervision',
    )
    expect(judgeRequests.length).toBe(2)
    // The issued Decision input rides the one input home.
    expect(validateSupervisionInput(judgeRequests[0]?.detail?.input)).toBe(true)
    // The verdict division is total — no declining listener on any branch.
    expect(transformErrors).toHaveLength(0)
  })

  test('reject: the halt holds the block — supervision_halted surfaces, the loop stays dead', () => {
    const { program, selected, transformErrors } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)

    // The judge rejects: the halt surfaces (no reason — the choice answer
    // carries no prose), the release never fires.
    feed(program, judgeChoiceResult('leaky', 'halt'), 'pump2')
    const halted = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.halted)
    expect(halted).toBeDefined()
    expect(halted?.detail).toEqual({ type: 'leaky' })
    expect(validateSupervisionHalted(halted?.detail)).toBe(true)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)

    // The block HOLDS: a later request for the watched type stays blocked,
    // while a non-watched event still selects — the halt is surgical.
    mountAll(program, [{ label: 'probe-blocked', once: true, rules: [{ request: { type: 'leaky', detail: {} } }] }])
    program.trigger({ type: 'pump3', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)
    mountAll(program, [{ label: 'probe-free', once: true, rules: [{ request: { type: 'tick', detail: {} } }] }])
    program.trigger({ type: 'pump4', detail: {} })
    expect(count(selected, 'tick')).toBe(1)
    expect(transformErrors).toHaveLength(0)
  })

  test('fail-visible: an unavailable judge holds the block and surfaces the halt with the reason', () => {
    const { program, selected, transformErrors } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)

    // The judge is unavailable (429-exhausted, timeout, crash — the faculty's
    // error branch): the block HOLDS and the halt surfaces WITH the
    // judge-failure reason — never silent continuation, never an invisible halt.
    feed(program, judgeErrorResult('leaky', 'HTTP 429 — rate limited'), 'pump2')
    const halted = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.halted)
    expect(halted).toBeDefined()
    expect(halted?.detail).toEqual({ type: 'leaky', reason: 'HTTP 429 — rate limited' })
    expect(validateSupervisionHalted(halted?.detail)).toBe(true)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)

    // The block holds — the loop stays dead.
    mountAll(program, [{ label: 'probe-blocked', once: true, rules: [{ request: { type: 'leaky', detail: {} } }] }])
    program.trigger({ type: 'pump3', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)
    expect(transformErrors).toHaveLength(0)
  })

  test('a malformed judge answer surfaces the halt — never an invisible hold', () => {
    const { program, selected, transformErrors } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)

    // A hostile/junk answer is not a lift — the halt surfaces (fail-visible)
    // and the block holds; the malformed payload never jq-errors.
    feed(
      program,
      {
        type: FACULTY_MESSAGE_KINDS.system_one_request_result,
        detail: { id: 'leaky-supervision', ok: true, result: { model: 'm', answers: { supervision: 'junk' } } },
      },
      'pump2',
    )
    const halted = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.halted)
    expect(halted).toBeDefined()
    expect(halted?.detail).toEqual({ type: 'leaky' })
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
    mountAll(program, [{ label: 'probe-blocked', once: true, rules: [{ request: { type: 'leaky', detail: {} } }] }])
    program.trigger({ type: 'pump3', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)
    expect(transformErrors).toHaveLength(0)
  })
})

describe('supervision threads — recovery', () => {
  /** The full pack — breaker + judgment + recovery — as the composition mounts it. */
  const mountPack = (
    program: ReturnType<typeof behavioral>,
    watch: string[],
    threshold: number,
    maxReissues?: number,
  ): void => {
    mountAll(program, supervisionThreads({ watch, threshold }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(
      program,
      supervisionRecoveryThreads({ watch, threshold, ...(maxReissues === undefined ? {} : { maxReissues }) }),
    )
  }

  const judgeRequestCount = (selected: Selected[], watchedType: string): number =>
    selected.filter(
      (s) =>
        s.type === FACULTY_MESSAGE_KINDS.system_one_request &&
        (s.detail?.id as string) === `${watchedType}-supervision`,
    ).length

  test('judge-retry: an unjudged halt re-issues the Decision — a later lift lifts the block', () => {
    const { program, selected, transformErrors } = liveProgram()
    mountPack(program, ['leaky'], 8)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)
    expect(judgeRequestCount(selected, 'leaky')).toBe(1)

    // The judge is unavailable — the halt surfaces with the reason.
    feed(program, judgeErrorResult('leaky', 'HTTP 429 — rate limited'), 'pump2')
    expect(count(selected, SUPERVISION_EVENT_TYPES.halted)).toBe(1)

    // The retry thread re-issued the SAME Decision (the attempt rode the
    // thread's generator state — bounded, re-armed on release).
    expect(judgeRequestCount(selected, 'leaky')).toBe(2)

    // The re-ask succeeds: the lift releases the block, the loop resumes,
    // and the fresh counter trips again — recovery proven end-to-end.
    feed(program, judgeChoiceResult('leaky', 'lift'), 'pump3')
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(true)
    expect(count(selected, 'leaky')).toBe(16)
    expect(count(selected, SUPERVISION_EVENT_TYPES.tripped)).toBe(2)
    expect(transformErrors).toHaveLength(0)
  })

  test('judge-retry is bounded: repeated judge failures exhaust the re-issues — the halt stands', () => {
    const { program, selected } = liveProgram()
    mountPack(program, ['leaky'], 8, 2)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })

    // Every judgment fails: the initial issue plus exactly MAX_REISSUES
    // re-issues — then the standing halt gets no further re-ask. (Only the
    // results correlated to actually-issued requests are fed; a spurious
    // uncorrelated result could not exist on the wire.)
    for (let i = 0; i < 1 + SUPERVISION_MAX_REISSUES; i++)
      feed(program, judgeErrorResult('leaky', `failure ${i}`), `pump${i + 2}`)
    expect(count(selected, SUPERVISION_EVENT_TYPES.halted)).toBe(1 + SUPERVISION_MAX_REISSUES)
    expect(judgeRequestCount(selected, 'leaky')).toBe(1 + SUPERVISION_MAX_REISSUES)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
    // The block holds — the loop stays dead.
    mountAll(program, [{ label: 'probe-blocked', once: true, rules: [{ request: { type: 'leaky', detail: {} } }] }])
    program.trigger({ type: 'pump-final', detail: {} })
    expect(count(selected, 'leaky')).toBe(8)
  })

  test('a judged halt (no reason) never re-issues — the judge spoke', () => {
    const { program, selected } = liveProgram()
    mountPack(program, ['leaky'], 8)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })

    feed(program, judgeChoiceResult('leaky', 'halt'), 'pump2')
    expect(count(selected, SUPERVISION_EVENT_TYPES.halted)).toBe(1)
    expect(judgeRequestCount(selected, 'leaky')).toBe(1)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
  })

  test('override: the host ingress lifts the block immediately — the human decision path', () => {
    const { program, selected, transformErrors } = liveProgram()
    mountPack(program, ['leaky'], 8)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    feed(program, judgeErrorResult('leaky', 'judge down'), 'pump2')
    expect(count(selected, SUPERVISION_EVENT_TYPES.halted)).toBe(1)

    // The host supplies the override ingress — the block lifts immediately,
    // the program continues (the loop resumes and re-trips on a fresh count).
    feed(program, { type: SUPERVISION_EVENT_TYPES.override, detail: { type: 'leaky' } }, 'pump3')
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(true)
    expect(count(selected, 'leaky')).toBe(16)
    expect(transformErrors).toHaveLength(0)
  })

  test('a malformed override never matches — the boundary is the schema', () => {
    const { program, selected } = liveProgram()
    mountPack(program, ['leaky'], 8)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    feed(program, judgeErrorResult('leaky', 'judge down'), 'pump2')

    // Junk detail: the override listener's gate never matches, no release —
    // the override boundary is the AJV schema at the listener.
    feed(program, { type: SUPERVISION_EVENT_TYPES.override, detail: { type: 42 } }, 'pump3')
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
    expect(count(selected, 'leaky')).toBe(8)
  })
})

describe('supervision threads — the Decision shapes', () => {
  test('the issued judgment input validates against the input schema home', () => {
    const { program, selected } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    const request = selected.find(
      (s) => s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string) === 'leaky-supervision',
    )
    expect(request).toBeDefined()
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
  })
})

describe('supervision judgment — the live TypeSafe API (opt-in: TYPESAFE_API_KEY)', () => {
  const key = process.env.TYPESAFE_API_KEY
  const liveTest = key === undefined ? test.skip : test

  liveTest('a real trip judges against the live endpoint — the answer maps through the verdict', async () => {
    // The whole judgment lane against the LIVE endpoint: the trip issues the
    // request (the threads' own output — not a hand-built body), the real
    // faculty process speaks api.typesafe.ai, and the real answer maps back
    // through the verdict. Whichever way the model calls it, exactly one of
    // the two outcomes fires with a conforming shape — the branch is the
    // judge's call, the mapping is the contract under test.
    const { program, selected, transformErrors } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    mountAll(program, supervisionJudgmentThreads)
    mountAll(program, [loopThread('leaky')])
    program.trigger({ type: 'pump', detail: {} })
    const request = selected.find(
      (s) => s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string) === 'leaky-supervision',
    )
    expect(request).toBeDefined()
    expect(validateSupervisionInput(request?.detail?.input)).toBe(true)

    const faculty = spawnFaculty({
      file: 'system-one/faculty.ts',
      requestType: FACULTY_MESSAGE_KINDS.system_one_request,
      resultType: FACULTY_MESSAGE_KINDS.system_one_request_result,
      env: {
        [SYSTEM_ONE_ENDPOINT_KEY]: JSON.stringify({
          url: 'https://api.typesafe.ai/v1/systemone',
          apiKey: key,
          model: 'jev-1.13.0',
        }),
      },
    })
    try {
      // The real faculty speaks the live endpoint with the threads' issued input.
      faculty.call(request?.detail as unknown as JsonObject)
      const { detail: liveResult } = await faculty.resultFor('leaky-supervision')
      expect((liveResult as { ok?: boolean }).ok).toBe(true)

      // The live answer re-enters the engine as the judge result — the
      // verdict maps it to a release or a halt, never both, never neither.
      feed(program, { type: FACULTY_MESSAGE_KINDS.system_one_request_result, detail: liveResult }, 'pump2')
      const outcomes = selected.filter(
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
      expect(transformErrors).toHaveLength(0)
    } finally {
      faculty.terminate()
    }
  })
})
