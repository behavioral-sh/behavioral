import { describe, expect, test } from 'bun:test'
import { type CompositionDrive, driveComposition } from '../../b-program/tests/composition-drive.ts'
import type { BPEvent, JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { ADMISSION_EVENT_TYPES, validateAdmissionInput, validateAdmissionVerdict } from '../system-one.threads.ts'
import { DECISIONS_MODEL, startDecisionsServer } from './fixtures/decisions-server.ts'

/**
 * The system-one admission judgment threads through the REAL composition —
 * the BP-native blocking judge: a validated candidate's admission is BLOCKED
 * while a system-one Decision judges the proposed thread; an approval
 * lifts the block (the candidate admits), a rejection holds the line
 * (the candidate never goes live).
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** The declined transform results — the post-switch noise class (the retired transform_error kind). */
const declined = (selected: Selected[]): Selected[] =>
  selected.filter(
    (s) => s.type === FACULTY_MESSAGE_KINDS.transform_request_result && (s.detail as { ok?: boolean })?.ok === false,
  )

/**
 * The judgment drive — through the REAL composition (the transform-faculty
 * ruling): the admission judgment pack's transform listeners (the judge-input
 * mapping, the verdict division) complete only through the fixed fourth
 * faculty, and the judge is a REAL systemOne faculty over a fixture endpoint.
 * The choreography is async and every hop polls. The mid-flight BLOCK pins
 * (the probe admission that must stay held while the Decision is in flight)
 * live at the composition level (b-program.spec.ts — the judged path end to
 * end); this spec pins the pack's own shapes and mappings.
 */
const judgmentDrive = async (
  fixture: Parameters<typeof startDecisionsServer>[0] = {},
): Promise<{ drive: CompositionDrive; server: Awaited<ReturnType<typeof startDecisionsServer>> }> => {
  const server = await startDecisionsServer(fixture)
  // The composition mounts the judgment pack ITSELF when systemOne is wired
  // (models.systemOne defined) — the pack is NOT a host thread here, or it
  // double-mounts and every transform mints twice.
  const drive = driveComposition({
    threads: [],
    models: { systemOne: { url: server.url, model: DECISIONS_MODEL } as unknown as JsonObject },
  })
  return { drive, server }
}

/** The candidate event: a validated proposal awaiting judgment (the composition's emission). */
const candidate = (id: string, name: string): BPEvent => ({
  type: ADMISSION_EVENT_TYPES.candidate,
  detail: { id, thread: { name, description: 'Test thread.', rules: [{ request: { type: 'ping' } }] } },
})

describe('system-one admission judgment threads', () => {
  test('a candidate issues a system_one_request carrying the proposed thread as the Decision input', async () => {
    const { drive, server } = await judgmentDrive()
    try {
      drive.trigger(candidate('at1', 'greeter'))
      await drive.waitUntil((sel) =>
        sel.some(
          (s) =>
            s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string | undefined) === 'at1-judge',
        ),
      )
      const request = drive.selected.find(
        (s) =>
          s.type === FACULTY_MESSAGE_KINDS.system_one_request && (s.detail?.id as string | undefined) === 'at1-judge',
      )
      const input = request?.detail?.input as
        | { state?: { thread?: { name?: string } }; questions?: Record<string, { type?: string }> }
        | undefined
      expect(input?.state?.thread?.name).toBe('greeter')
      expect(input?.questions?.admission?.type).toBe('choice')
      expect(validateAdmissionInput(request?.detail?.input as unknown)).toBe(true)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('approve: the block lifts on the Decision and the admission fires with the candidate id', async () => {
    const { drive, server } = await judgmentDrive()
    try {
      drive.trigger(candidate('at1', 'greeter'))
      await drive.waitUntil((sel) =>
        sel.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at1'),
      )
      const admitted = drive.selected.find(
        (s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at1',
      )
      expect((admitted?.detail as { admit?: boolean } | undefined)?.admit).toBe(true)
      expect(validateAdmissionVerdict(admitted?.detail)).toBe(true)
      // The verdict pair divides IN THE JQ (the two-outcome pattern): the
      // losing sibling matched the result and declined with empty_output —
      // the same decline the retired transform_error trace carried under the
      // in-engine evaluator, now the fail-visible result selection. The
      // OUTCOME is the pin; the sibling decline is the division's shape.
      const siblings = declined(drive.selected)
      for (const s of siblings) expect((s.detail as { reason?: string })?.reason).toBe('empty_output')
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('reject: the block holds through the rejection — no admission for the candidate', async () => {
    const { drive, server } = await judgmentDrive({ pickChoice: 'reject' })
    try {
      drive.trigger(candidate('at2', 'suspicious'))
      await drive.waitUntil((sel) =>
        sel.some((s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at2'),
      )
      const rejected = drive.selected.find(
        (s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at2',
      )
      expect((rejected?.detail as { admit?: boolean } | undefined)?.admit).toBe(false)
      expect(validateAdmissionVerdict(rejected?.detail)).toBe(true)
      // No admission ever fires for the rejected candidate.
      expect(
        drive.selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at2'),
      ).toBe(false)
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('a malformed Decision result is error data — the outage hold, never a throw', async () => {
    // RE-PIN (the outage ruling, 2026-10-03): the fixture answers junk — the
    // systemOne faculty's OUTPUT SCHEMA rejects it and the judgment result
    // comes back the typed error (ok:false). The typed error is the
    // judge-UNAVAILABLE shape: the pack maps it to the HOLD-AND-RETRY marker,
    // never a durable rejection — fail-closed means HELD (the candidate never
    // admits), and the composition's hosted retries drive from here.
    const { drive, server } = await judgmentDrive({ junkAnswer: true })
    try {
      drive.trigger(candidate('at3', 'sneaky'))
      await drive.waitUntil((sel) =>
        sel.some((s) => s.type === ADMISSION_EVENT_TYPES.judgeUnavailable && (s.detail?.id as string) === 'at3'),
      )
      expect(
        drive.selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at3'),
      ).toBe(false)
      // The pack survived the hostile result: the declined selections are
      // the verdict division's siblings (empty_output — the retired
      // transform_error trace's content), never a crash.
      for (const s of declined(drive.selected)) expect((s.detail as { reason?: string })?.reason).toBe('empty_output')
    } finally {
      drive.terminate()
      await server.close()
    }
  })

  test('a faculty error result is error data — the outage hold, the candidate never admits', async () => {
    // RE-PIN (the outage ruling, 2026-10-03): every decision request
    // rate-limits — the faculty retries (4 attempts) and fails through to
    // the typed error. The typed error HOLDS (the judge-unavailable marker,
    // the composition-hosted re-issues bounded at 3) — the candidate never
    // admits, and no durable rejection ever fires for an outage.
    const { drive, server } = await judgmentDrive({ rateLimitFirst: 99 })
    try {
      drive.trigger(candidate('at4', 'unlucky'))
      await drive.waitUntil((sel) =>
        sel.some((s) => s.type === ADMISSION_EVENT_TYPES.judgeUnavailable && (s.detail?.id as string) === 'at4'),
      )
      expect(
        drive.selected.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at4'),
      ).toBe(false)
      expect(
        drive.selected.some((s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at4'),
      ).toBe(false)
    } finally {
      drive.terminate()
      await server.close()
    }
  })
})

describe('admission judgment — the Decision shapes', () => {
  test('the judged outcomes validate against the verdict schema home — both branches', async () => {
    // The admit drive and the reject drive together cover both verdict
    // branches against the one outcome home.
    const approve = await judgmentDrive()
    const reject = await judgmentDrive({ pickChoice: 'reject' })
    try {
      approve.drive.trigger(candidate('at1', 'greeter'))
      reject.drive.trigger(candidate('at2', 'suspicious'))
      await approve.drive.waitUntil((sel) =>
        sel.some((s) => s.type === ADMISSION_EVENT_TYPES.admitted && (s.detail?.id as string) === 'at1'),
      )
      await reject.drive.waitUntil((sel) =>
        sel.some((s) => s.type === ADMISSION_EVENT_TYPES.rejected && (s.detail?.id as string) === 'at2'),
      )
      const outcomes = [
        ...approve.drive.selected.filter((s) => s.type === ADMISSION_EVENT_TYPES.admitted),
        ...reject.drive.selected.filter((s) => s.type === ADMISSION_EVENT_TYPES.rejected),
      ]
      expect(outcomes.length).toBeGreaterThanOrEqual(2)
      for (const outcome of outcomes) expect(validateAdmissionVerdict(outcome.detail)).toBe(true)
    } finally {
      approve.drive.terminate()
      await approve.server.close()
      reject.drive.terminate()
      await reject.server.close()
    }
  })
})
