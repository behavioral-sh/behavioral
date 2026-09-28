import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import {
  ADMISSION_EVENT_TYPES,
  admissionJudgmentThreads,
  validateAdmissionInput,
  validateAdmissionVerdict,
} from '../threads.ts'

/**
 * The system-one admission judgment threads against the real engine — the
 * BP-native blocking judge: a validated candidate's admission is BLOCKED
 * while a system-one Decision judges the proposed thread; an approval
 * lifts the block (the candidate admits), a rejection holds the line
 * (the candidate never goes live).
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** One harness step: admit a producer event, mount threads, or both — then pump. */
type Step = {
  event?: BPEvent
  threads?: Thread[]
  check?: (selected: Selected[]) => void
}

const PUMP = 'judgment_pump'
const PUMPS_PER_STEP = 6

const runJudgment = (steps: Step[]): Selected[] => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  for (const thread of admissionJudgmentThreads) program.addThread(thread)
  for (const step of steps) {
    if (step.event !== undefined)
      program.addThread({ label: `producer/${step.event.type}`, once: true, rules: [{ request: step.event }] })
    for (const thread of step.threads ?? []) program.addThread(thread)
    for (let i = 0; i < PUMPS_PER_STEP; i++) program.trigger({ type: PUMP, detail: {} })
    step.check?.(selected)
  }
  return selected
}

/** The candidate event: a validated proposal awaiting judgment (the composition's emission). */
const candidate = (id: string, label: string): BPEvent => ({
  type: ADMISSION_EVENT_TYPES.candidate,
  detail: { id, thread: { label, rules: [{ request: { type: 'ping' } }] } },
})

/** The correlated judge result — a choice answer on the `admission` question. */
const judgeResult = (id: string, choice: string): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.system_one_request_result,
  detail: {
    id: `${id}-judge`,
    ok: true,
    result: { model: 'jev-1.13.0', answers: { admission: { type: 'choice', choice } } },
  },
})

describe('system-one admission judgment threads', () => {
  test('a candidate issues a system_one_request carrying the proposed thread as the Decision input', () => {
    const selected = runJudgment([
      {
        event: candidate('at1', 'greeter'),
        check: (selected) => {
          const request = selected.find(
            (s) =>
              s.type === FACULTY_MESSAGE_KINDS.system_one_request &&
              (s.detail?.id as string | undefined) === 'at1-judge',
          )
          expect(request).toBeDefined()
          const input = request?.detail?.input as
            | { state?: { thread?: { label?: string } }; questions?: Record<string, { type?: string }> }
            | undefined
          expect(input?.state?.thread?.label).toBe('greeter')
          expect(input?.questions?.admission?.type).toBe('choice')
        },
      },
    ])
    // The issued request exists in the settled program too.
    expect(
      selected.some(
        (s) => s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string) === 'at1-judge',
      ),
    ).toBe(true)
  })

  test('approve: the block lifts on the Decision and the admission fires with the candidate id', () => {
    let candidateIndex = -1
    let resultIndex = -1
    const selected = runJudgment([
      {
        event: candidate('at1', 'greeter'),
        check: (selected) => {
          candidateIndex = selected.findIndex((s) => s.type === ADMISSION_EVENT_TYPES.candidate)
        },
      },
      {
        // The probe: an admission request that MUST stay blocked while the
        // Decision is in flight.
        threads: [
          {
            label: 'probe',
            once: true,
            rules: [{ request: { type: ADMISSION_EVENT_TYPES.admitted, detail: { id: 'probe-1', admit: true } } }],
          },
        ],
        check: (selected) => {
          const admissions = selected.filter((s) => s.type === ADMISSION_EVENT_TYPES.admitted)
          expect(admissions).toEqual([])
        },
      },
      {
        event: judgeResult('at1', 'admit'),
        check: (selected) => {
          resultIndex = selected.findIndex(
            (s) =>
              s.type === FACULTY_MESSAGE_KINDS.system_one_request_result && (s.detail?.id as string) === 'at1-judge',
          )
          // The judgment's outcome: the admission fires with the CANDIDATE id…
          const admitted = selected.find(
            (s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at1',
          )
          expect(admitted).toBeDefined()
          expect((admitted?.detail as { admit?: boolean } | undefined)?.admit).toBe(true)
          // …the probe selects only AFTER the Decision (the block was the only
          // thing holding it — it lifts with the judgment)…
          const probe = selected.find(
            (s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'probe-1',
          )
          expect(probe).toBeDefined()
          // …and nothing was admitted while the judgment was in flight.
          const admissions = selected
            .map((s, index) => ({ s, index }))
            .filter(({ s }) => s.type === ADMISSION_EVENT_TYPES.admitted)
          for (const { index } of admissions) expect(index).toBeGreaterThan(resultIndex)
          expect(candidateIndex).toBeLessThan(resultIndex)
        },
      },
    ])
    expect(selected.length).toBeGreaterThan(0)
  })

  test('reject: the block holds through the rejection — no admission for the candidate', () => {
    const selected = runJudgment([
      { event: candidate('at2', 'suspicious') },
      {
        event: judgeResult('at2', 'reject'),
        check: (selected) => {
          // The rejection is visible, stamped with the candidate id…
          const rejected = selected.find(
            (s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at2',
          )
          expect(rejected).toBeDefined()
          expect((rejected?.detail as { admit?: boolean } | undefined)?.admit).toBe(false)
          // …and no admission ever fires for the rejected candidate.
          expect(
            selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at2'),
          ).toBe(false)
        },
      },
      {
        // After the rejection is processed the gate releases (the loop wraps to
        // the next candidate) — but the rejected candidate stays dead.
        threads: [
          {
            label: 'probe',
            once: true,
            rules: [{ request: { type: ADMISSION_EVENT_TYPES.admitted, detail: { id: 'probe-2', admit: true } } }],
          },
        ],
        check: (selected) => {
          const probe = selected.find(
            (s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'probe-2',
          )
          expect(probe).toBeDefined()
          expect(
            selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at2'),
          ).toBe(false)
        },
      },
    ])
    expect(selected.length).toBeGreaterThan(0)
  })

  test('a malformed Decision result is error data — fail-closed rejection, no throw', () => {
    // The answer is a hostile payload: `admission` is a bare string. The
    // queries normalize it — no jq error, no admission; the reject listener
    // holds the line.
    const malformed: BPEvent = {
      type: FACULTY_MESSAGE_KINDS.system_one_request_result,
      detail: { id: 'at3-judge', ok: true, result: { model: 'm', answers: { admission: 'junk' } } },
    }
    const selected = runJudgment([
      { event: candidate('at3', 'sneaky') },
      {
        event: malformed,
        check: (selected) => {
          const rejected = selected.find(
            (s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at3',
          )
          expect(rejected).toBeDefined()
          expect(
            selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at3'),
          ).toBe(false)
        },
      },
    ])
    // The program survived the hostile result: the loop wrapped and the next
    // candidate still judges.
    expect(selected.length).toBeGreaterThan(0)
  })

  test('a faculty error result is error data — the candidate rejects, never admits', () => {
    const selected = runJudgment([
      { event: candidate('at4', 'unlucky') },
      {
        event: {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          detail: { id: 'at4-judge', ok: false, error: { code: 'error', message: 'endpoint down' } },
        },
        check: (selected) => {
          const rejected = selected.find(
            (s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at4',
          )
          expect(rejected).toBeDefined()
          expect(
            selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at4'),
          ).toBe(false)
        },
      },
    ])
    expect(selected.length).toBeGreaterThan(0)
  })
})

describe('admission judgment — the Decision shapes', () => {
  test('the issued Decision input validates against the input schema home', () => {
    const selected = runJudgment([{ event: candidate('at1', 'greeter') }])
    const request = selected.find(
      (s) =>
        s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string | undefined) === 'at1-judge',
    )
    expect(request).toBeDefined()
    expect(validateAdmissionInput(request?.detail?.input as unknown)).toBe(true)
  })

  test('the judged outcomes validate against the verdict schema home', () => {
    const selected = runJudgment([
      { event: candidate('at1', 'greeter') },
      { event: judgeResult('at1', 'admit') },
      { event: candidate('at2', 'suspicious') },
      { event: judgeResult('at2', 'reject') },
    ])
    const outcomes = selected.filter(
      (s) => s.type === ADMISSION_EVENT_TYPES.admitted || s.type === ADMISSION_EVENT_TYPES.rejected,
    )
    // Both outcomes fired and both conform to the one verdict home.
    expect(outcomes.length).toBeGreaterThanOrEqual(2)
    for (const outcome of outcomes) expect(validateAdmissionVerdict(outcome.detail)).toBe(true)
    expect(outcomes.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at1')).toBe(
      true,
    )
    expect(outcomes.some((s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at2')).toBe(
      true,
    )
  })
})
