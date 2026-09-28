import type { JSONSchemaType } from 'ajv'
import { ajv, type Thread, ThreadSchema } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { type ChoiceQuestion, choiceQuestionSchema } from './schemas.ts'

/**
 * The System One faculty's threads — the admission judgment threads (the
 * BP-native blocking judge) and the supervision threads (the runtime
 * circuit breaker — the admission pattern rotated to runtime).
 *
 * @remarks
 * **Admission judgment** — when systemOne is wired, a validated candidate
 * (the `add_thread` op's structural verdict) does not admit directly: its
 * admission is BLOCKED while a system-one Decision judges the proposed
 * thread, and the Decision determines whether the block lifts.
 *
 * Three threads, mounted by `bProgram` only when systemOne is on (the judge
 * requires the Decisions lane; the frontier — its structural layer — is the
 * in-process embed, always present):
 *
 * - **`admission-issue`** — a `thread_candidate` event (the composition's
 *   emission: a validated candidate awaiting judgment) issues the correlated
 *   `system_one_request` (`<candidate>-judge`) carrying the proposed thread
 *   as the Decision input (state: the thread; question: a choice between
 *   `admit` and `reject`).
 * - **`admission-gate`** — the blocking judge itself. It waits for a
 *   candidate, then BLOCKS every `thread_admission` while the Decision is in
 *   flight. The block lifts only when the judgment's outcome lands: an
 *   approve-shaped result, or the rejection event (so a rejection holds the
 *   line through its own processing — the candidate never goes live — without
 *   poisoning later candidates' admissions). Then the loop wraps to the next
 *   candidate (a block-only span would hold forever; the waitFor pair is
 *   what releases it, per the guard-thread pattern's inverse).
 * - **`admission-verdict`** — the judge-correlated result maps to the
 *   outcome: `thread_admission { id, admit: true }` on an approve choice,
 *   `thread_admission_rejected { id, admit: false }` on anything else —
 *   a not-ok result, a malformed answer, a non-`admit` choice. Fail-closed:
 *   the only road to admission is an explicit approve.
 *
 * The composition owns the write: `thread_admission` selections admit the
 * pending candidate (the id map stays the authorization); rejected ids drop.
 * Concurrent candidates each judge independently (id-correlated); the gate's
 * block is the type-scoped judging window, advisory when several judgments
 * overlap — per-candidate correctness lives in the correlation, never in the
 * window.
 *
 * MINIMAL: the Decision's policy (what makes a thread "appropriate") is the
 * fixed instruction below; a policy input rides a config seam when a named
 * need arrives. Hostile-thread forgery of `thread_admission` is the same
 * class as the existing frontier_request self-request posture — a known
 * frontier for a later hardening slice.
 *
 * **Supervision** — `supervisionThreads({ watch, threshold })` builds one
 * count-bounded supervisor per watched event type: the thread's rule
 * position is the counter, the trip rule blocks the type mid-cascade and
 * surfaces `supervision_tripped { type, count, threshold }`, and the hold
 * rule parks the block until a `supervision_release` for that type (the
 * wrap-back is the counter reset). See the supervision section below.
 *
 * @packageDocumentation
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types: the candidate in, the judged outcome out. */
export const ADMISSION_EVENT_TYPES = {
  candidate: 'thread_candidate',
  admitted: 'thread_admission',
  rejected: 'thread_admission_rejected',
} as const

/** The judge-request correlation suffix: `<candidate>-judge` ↔ the result's echoed id. */
export const ADMISSION_JUDGE_SUFFIX = '-judge'

/** The Decision question the judgment asks (the `admission` choice). */
export const ADMISSION_QUESTION = 'admission'

// ── Trusted shapes ───────────────────────────────────────────────────────────

/** A candidate's detail: the composition-validated proposal, keyed by the pending admission id. */
export const ADMISSION_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    thread: ThreadSchema,
  },
  required: ['id', 'thread'],
  additionalProperties: false,
} as const

/**
 * The judge-correlated result detail the verdict listeners trust — the id
 * suffix scopes the lane (other Decisions on the same faculty never match).
 */
export const ADMISSION_JUDGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-judge$' },
    ok: { type: 'boolean' },
  },
  required: ['id', 'ok'],
  additionalProperties: true,
} as const

/**
 * The approve-shaped result — the gate's lift condition. The block releases
 * on an explicit `admit` choice; every other outcome (reject, error,
 * malformed) holds until the rejection event releases it.
 */
export const ADMISSION_JUDGE_APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-judge$' },
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties: {
            [ADMISSION_QUESTION]: {
              type: 'object',
              properties: { choice: { type: 'string', const: 'admit' } },
              required: ['choice'],
            },
          },
          required: [ADMISSION_QUESTION],
        },
      },
      required: ['answers'],
    },
  },
  required: ['id', 'ok', 'result'],
  additionalProperties: true,
} as const

// ── Shared jq fragments ──────────────────────────────────────────────────────

/**
 * The judge answer, normalized: every non-object on the answer path coalesces
 * to `{}` so a hostile/malformed payload can never crash the queries — it
 * falls through to the reject listener (fail-closed), never a jq error.
 */
const JUDGE_ANSWER =
  '(if ($d.result | type) == "object" then $d.result else {} end) as $r | ' +
  '(if ($r.answers | type) == "object" then $r.answers else {} end) as $a | ' +
  '(if ($a.admission | type) == "object" then $a.admission else {} end) as $q'

/** The judged outcome — the Decision's answer mapped to a structured admission call. */
export type AdmissionVerdict = {
  /** The candidate's pending-admission id (the composition's key). */
  id: string
  /** The Decision's call: true admits the candidate, false keeps it out. */
  admit: boolean
  /**
   * Optional free-text why. The choice answer carries no prose today, so the
   * mapping emits none — a reason rides a future answer type, never a guess.
   */
  reason?: string
}

/** The judged outcome's schema — the composition's admission gate validates against this home. */
export const ADMISSION_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    admit: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['id', 'admit'],
  additionalProperties: false,
} as unknown as JSONSchemaType<AdmissionVerdict>

/**
 * The Decision input the judgment issues: the proposed thread rides as state
 * (the schema derives from the engine's ThreadSchema — one home, no
 * mirroring), the question is the admit/reject choice over the shared
 * question schema.
 */
export type AdmissionDecisionInput = {
  state: { lane: 'admission-judgment'; thread: Thread }
  questions: { [ADMISSION_QUESTION]: ChoiceQuestion }
}

export const ADMISSION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'object',
      properties: {
        lane: { type: 'string', const: 'admission-judgment' },
        thread: ThreadSchema,
      },
      required: ['lane', 'thread'],
      additionalProperties: false,
    },
    questions: {
      type: 'object',
      properties: { [ADMISSION_QUESTION]: choiceQuestionSchema },
      required: [ADMISSION_QUESTION],
      additionalProperties: false,
    },
  },
  required: ['state', 'questions'],
  additionalProperties: false,
} as unknown as JSONSchemaType<AdmissionDecisionInput>

/** The issued Decision input's boundary — the threads' jq must produce exactly this. */
export const validateAdmissionInput = ajv.compile(ADMISSION_INPUT_SCHEMA)

/** The judged outcome's boundary — the composition's admission gate consumes only conforming verdicts. */
export const validateAdmissionVerdict = ajv.compile(ADMISSION_VERDICT_SCHEMA)

// ── Threads ──────────────────────────────────────────────────────────────────

/** admission-issue — a candidate issues the correlated `system_one_request` with the thread as Decision input. */
const admissionIssue: Thread = {
  label: 'system-one/admission-issue',
  rules: [
    {
      transform: [
        {
          type: ADMISSION_EVENT_TYPES.candidate,
          query: `. as $d | select($d.thread.label != null and $d.thread.rules != null)
| { id: ($d.id + "${ADMISSION_JUDGE_SUFFIX}"), input: {
    state: { lane: "admission-judgment", thread: $d.thread },
    questions: { ${ADMISSION_QUESTION}: { type: "choice",
      instructions: "Admission judgment: decide whether this proposed behavioral thread should join the live program. It is already structurally valid; judge appropriateness — what it requests, waits for, and blocks, and whether that is safe and in scope.",
      criteria: { admit: "The thread is appropriate to admit.", reject: "The thread is not appropriate — keep it out." } } } } }`,
          target: FACULTY_MESSAGE_KINDS.system_one_request,
          detailSchema: ADMISSION_CANDIDATE_SCHEMA,
        },
      ],
    },
  ],
}

/** admission-gate — the blocking judge: admission is blocked while the Decision is in flight. */
const admissionGate: Thread = {
  label: 'system-one/admission-gate',
  rules: [
    { waitFor: [{ type: ADMISSION_EVENT_TYPES.candidate, detailSchema: ADMISSION_CANDIDATE_SCHEMA }] },
    {
      block: [{ type: ADMISSION_EVENT_TYPES.admitted }],
      waitFor: [
        { type: FACULTY_MESSAGE_KINDS.system_one_request_result, detailSchema: ADMISSION_JUDGE_APPROVAL_SCHEMA },
        { type: ADMISSION_EVENT_TYPES.rejected },
      ],
    },
  ],
}

/** admission-verdict — the judge-correlated result maps to the outcome; everything but an explicit approve rejects. */
const admissionVerdict: Thread = {
  label: 'system-one/admission-verdict',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | ${JUDGE_ANSWER}
| select(($d.id | endswith("${ADMISSION_JUDGE_SUFFIX}")) and (($d.ok // false) == true) and ($q.type == "choice") and ($q.choice == "admit"))
| { id: ($d.id | sub("${ADMISSION_JUDGE_SUFFIX}$"; "")), admit: true }`,
          target: ADMISSION_EVENT_TYPES.admitted,
          detailSchema: ADMISSION_JUDGE_RESULT_SCHEMA,
        },
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | ${JUDGE_ANSWER}
| select(($d.id | endswith("${ADMISSION_JUDGE_SUFFIX}")) and ((($d.ok // false) != true) or ($q.type != "choice") or ($q.choice != "admit")))
| { id: ($d.id | sub("${ADMISSION_JUDGE_SUFFIX}$"; "")), admit: false }`,
          target: ADMISSION_EVENT_TYPES.rejected,
          detailSchema: ADMISSION_JUDGE_RESULT_SCHEMA,
        },
      ],
    },
  ],
}

/** The admission judgment threads — mounts with systemOne (the composition wires it). */
export const admissionJudgmentThreads: Thread[] = [admissionIssue, admissionGate, admissionVerdict]

// ── Supervision — the runtime circuit breaker ─────────────────────────────

/**
 * The supervision threads — the runtime circuit breaker, the admission
 * pattern rotated: a supervisor waits on a watched event type, counts
 * selections, and at a threshold BLOCKS the type — the circuit-breaker
 * declaration. The block takes effect at the NEXT super-step, mid-cascade:
 * the cascade's own advance passes through the supervisor each selection,
 * so the breaker fires before the recursive cascade overflows the stack
 * (~8.6k deep). No process kill, no abort signal, no engine surgery.
 *
 * @remarks
 * The counter is the thread's rule position — the pure-BP shape. Each
 * watched-type supervisor is one thread:
 *
 * - `threshold` × `{waitFor: watched}` — every selection of the type resumes
 *   the generator and advances one rule; the position IS the count.
 * - the trip rule — `{block: watched, request: supervision_tripped}` — the
 *   block goes active for the next super-step (the loop's re-request is
 *   filtered, the cascade dies), and the trip surfaces as a typed selection
 *   (NOT an engine trace kind — threads surface typed events to the host,
 *   the mcp auth-surfacer pattern) carrying `{ type, count, threshold }`.
 * - the hold rule — `{block: watched, waitFor: supervision_release}` — parks
 *   the block until a release for THIS type arrives; the wrap back to the
 *   first rule after a release is the counter reset (slice 2's judge wires
 *   the release; slice 3's override ingress does too).
 *
 * The block is type-scoped BY DESIGN — it stops the event KIND, not one
 * thread: correct for a breaker. The watch list is config (v1 watches what
 * the composition tells it to — no auto-discovery); systemOne adds no
 * threads itself, so there is no proposer/judge conflict. Mounts with
 * systemOne (the composition's mount gates).
 *
 * MINIMAL: the threshold is a count, not a rate — a timer event source does
 * not exist in the engine, so count thresholds are the v1 mechanism; a rate
 * rides a future event source if a named need arrives.
 */

/** Supervision-owned event types: the trip surfaces; the release lifts a block; the halt stands visible; the override is the host's lift. */
export const SUPERVISION_EVENT_TYPES = {
  tripped: 'supervision_tripped',
  release: 'supervision_release',
  halted: 'supervision_halted',
  override: 'supervision_override',
} as const

/** The judge-request correlation suffix: `<watchedType>-supervision` ↔ the result's echoed id. */
export const SUPERVISION_JUDGE_SUFFIX = '-supervision'

/** The Decision question the supervision judgment asks (the `supervision` choice). */
export const SUPERVISION_QUESTION = 'supervision'

/** The default count threshold — under the ~8.6k cascade overflow, so the breaker fires mid-cascade. */
export const SUPERVISION_DEFAULT_THRESHOLD = 4096

/** The surfaced trip — the breaker's observation, consumed by the host/judge. */
export type SupervisionTripped = {
  /** The watched event type that tripped. */
  type: string
  /** The selections observed at trip — the threshold, by construction. */
  count: number
  /** The configured threshold. */
  threshold: number
}

/** The trip detail's one home — consumers (host egress, the judge) derive from this, never hand-mirror. */
export const SUPERVISION_TRIPPED_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 1 },
    threshold: { type: 'integer', minimum: 1 },
  },
  required: ['type', 'count', 'threshold'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SupervisionTripped>

/** The trip detail's boundary — consumers validate surfaced trips against this home. */
export const validateSupervisionTripped = ajv.compile(SUPERVISION_TRIPPED_SCHEMA)

/**
 * Build the supervision threads — one supervisor per watched type. The watch
 * list is composition config (v1: what it says, no auto-discovery); the
 * threshold defaults under the cascade overflow.
 */
export const supervisionThreads = ({
  watch,
  threshold = SUPERVISION_DEFAULT_THRESHOLD,
}: {
  watch: string[]
  threshold?: number
}): Thread[] =>
  watch.map((watchedType) => ({
    label: `system-one/supervisor(${watchedType})`,
    rules: [
      // The counter: `threshold` wait-steps — each selection of the watched
      // type advances one rule; the position is the count.
      ...Array.from({ length: threshold }, () => ({ waitFor: [{ type: watchedType }] })),
      // The trip: the block goes active for the next super-step (mid-cascade),
      // and the trip surfaces as a typed selection beside it.
      {
        block: [{ type: watchedType }],
        request: {
          type: SUPERVISION_EVENT_TYPES.tripped,
          detail: { type: watchedType, count: threshold, threshold } satisfies SupervisionTripped,
        },
      },
      // The hold: the block parks until a release for THIS type arrives;
      // the wrap back to the counter after a release is the reset.
      {
        block: [{ type: watchedType }],
        waitFor: [
          {
            type: SUPERVISION_EVENT_TYPES.release,
            detailSchema: {
              type: 'object',
              properties: { type: { type: 'string', const: watchedType } },
              required: ['type'],
            },
          },
        ],
      },
    ],
  }))

// ── Supervision — the block-then-judge threads ─────────────────────────

/**
 * The supervision judgment threads — the admission pattern rotated to
 * runtime. On a surfaced trip, `supervision-issue` asks the systemOne judge
 * whether the blocked loop is legitimate; the verdict maps the
 * judge-correlated result back to the supervisor's release/halt:
 *
 * - **lift** (an explicit `lift` choice) → `supervision_release { type }` —
 *   the supervisor's hold rule matches, the block lifts, and the wrap back
 *   to the counter IS the reset (the program continues).
 * - **halt** (the `halt` choice, a malformed answer) →
 *   `supervision_halted { type }` — the block holds; the halt is visible.
 * - **judge unavailable** (the faculty's error branch: 429-exhausted,
 *   timeout, crash) → `supervision_halted { type, reason }` — FAIL-VISIBLE,
 *   locked: the block holds AND the unjudged halt surfaces with the
 *   judge-failure reason. Never silent continuation (fail-open), never an
 *   invisible halt (fail-closed without signal).
 *
 * The three listeners' gates are mutually exclusive (ok false / ok true with
 * choice `lift` / ok true with anything else — the not-const division), so
 * exactly one acts per judge result: no declining sibling, zero
 * transform_errors on any branch — the audit surface stays clean.
 */

/**
 * The Decision input the judgment issues: the loop's identity rides as state
 * (the watched type, the count at trip, the threshold), the question is the
 * lift/halt choice over the shared question schema. One home; the specs and
 * the composition consume this shape, never a mirror.
 */
export type SupervisionDecisionInput = {
  state: { lane: 'supervision'; type: string; count: number; threshold: number }
  questions: { [SUPERVISION_QUESTION]: ChoiceQuestion }
}

export const SUPERVISION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'object',
      properties: {
        lane: { type: 'string', const: 'supervision' },
        type: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1 },
        threshold: { type: 'integer', minimum: 1 },
      },
      required: ['lane', 'type', 'count', 'threshold'],
      additionalProperties: false,
    },
    questions: {
      type: 'object',
      properties: { [SUPERVISION_QUESTION]: choiceQuestionSchema },
      required: [SUPERVISION_QUESTION],
      additionalProperties: false,
    },
  },
  required: ['state', 'questions'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SupervisionDecisionInput>

/** The issued Decision input's boundary — the threads' jq must produce exactly this. */
export const validateSupervisionInput = ajv.compile(SUPERVISION_INPUT_SCHEMA)

/** The surfaced halt — the unjudged or judged halt, standing visible on the wire. */
export type SupervisionHalted = {
  /** The watched event type that stays blocked. */
  type: string
  /** Why the halt stands — the judge-failure detail, when the judge was unavailable. */
  reason?: string
}

/** The halt detail's one home — consumers (host egress, recovery threads) derive from this, never hand-mirror. */
export const SUPERVISION_HALTED_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    reason: { type: 'string' },
  },
  required: ['type'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SupervisionHalted>

/** The halt detail's boundary — consumers validate surfaced halts against this home. */
export const validateSupervisionHalted = ajv.compile(SUPERVISION_HALTED_SCHEMA)

/** The lift-shaped result — the release condition: an explicit `lift` choice on the supervision question. */
export const SUPERVISION_JUDGE_LIFT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-supervision$' },
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties: {
            [SUPERVISION_QUESTION]: {
              type: 'object',
              properties: { choice: { type: 'string', const: 'lift' } },
              required: ['choice'],
            },
          },
          required: [SUPERVISION_QUESTION],
        },
      },
      required: ['answers'],
    },
  },
  required: ['id', 'ok', 'result'],
  additionalProperties: true,
} as const

/** The judge-unavailable result — the faculty's error branch (429-exhausted, timeout, crash). */
export const SUPERVISION_JUDGE_ERROR_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-supervision$' },
    ok: { type: 'boolean', const: false },
  },
  required: ['id', 'ok'],
  additionalProperties: true,
} as const

/**
 * An answered-but-not-lift result — a `halt` choice, a malformed answer, or
 * the answer missing entirely (the oneOf's non-object branch and the
 * vacuous `not` cover the junk shapes): everything but an explicit lift
 * halts. Mutually exclusive with the lift gate on `choice` and with the
 * error gate on `ok` — the division is total, so no listener ever declines.
 */
export const SUPERVISION_JUDGE_NONLIFT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-supervision$' },
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties: {
            [SUPERVISION_QUESTION]: {
              oneOf: [
                { type: 'object', properties: { choice: { not: { const: 'lift' } } } },
                { not: { type: 'object' } },
              ],
            },
          },
        },
      },
    },
  },
  required: ['id', 'ok'],
  additionalProperties: true,
} as const

/** The supervision question's jq — one home for the judgment's shape (the issue thread and the retry re-issue share it). */
const SUPERVISION_QUESTION_JQ = `{ ${SUPERVISION_QUESTION}: { type: "choice",
      instructions: "Supervision judgment: the runtime circuit breaker has blocked the watched event type after state.count consecutive selections (the configured threshold is state.threshold). Decide whether this self-sustaining activity is legitimate work that should resume, or an anomaly that should stay halted.",
      criteria: { lift: "The activity is legitimate — lift the block and let the program continue.", halt: "The activity is an anomaly — keep the block; the halt stands." } } }`

/** The Decision request body's jq — the id derives from `$d.type` in both callers (the trip's and the halt's detail field is the watched type). */
const supervisionRequestJq = (stateJq: string) =>
  `{ id: ($d.type + "${SUPERVISION_JUDGE_SUFFIX}"), input: { state: ${stateJq}, questions: ${SUPERVISION_QUESTION_JQ} } }`

/** supervision-issue — a surfaced trip issues the correlated `system_one_request` with the loop's identity as Decision input. */
const supervisionIssue: Thread = {
  label: 'system-one/supervision-issue',
  rules: [
    {
      transform: [
        {
          type: SUPERVISION_EVENT_TYPES.tripped,
          query: `. as $d | ${supervisionRequestJq('{ lane: "supervision", type: $d.type, count: $d.count, threshold: $d.threshold }')}`,
          target: FACULTY_MESSAGE_KINDS.system_one_request,
          detailSchema: SUPERVISION_TRIPPED_SCHEMA,
        },
      ],
    },
  ],
}

/** supervision-verdict — the judge-correlated result maps to the outcome: an explicit lift releases; everything else halts, fail-visible. */
const supervisionVerdict: Thread = {
  label: 'system-one/supervision-verdict',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | { type: ($d.id | sub("${SUPERVISION_JUDGE_SUFFIX}$"; "")) }`,
          target: SUPERVISION_EVENT_TYPES.release,
          detailSchema: SUPERVISION_JUDGE_LIFT_SCHEMA,
        },
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | { type: ($d.id | sub("${SUPERVISION_JUDGE_SUFFIX}$"; "")), reason: ($d.error.message? // "judge unavailable") }`,
          target: SUPERVISION_EVENT_TYPES.halted,
          detailSchema: SUPERVISION_JUDGE_ERROR_SCHEMA,
        },
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | { type: ($d.id | sub("${SUPERVISION_JUDGE_SUFFIX}$"; "")) }`,
          target: SUPERVISION_EVENT_TYPES.halted,
          detailSchema: SUPERVISION_JUDGE_NONLIFT_SCHEMA,
        },
      ],
    },
  ],
}

/** The supervision judgment threads — mounts with systemOne alongside the breaker (the composition wires it). */
export const supervisionJudgmentThreads: Thread[] = [supervisionIssue, supervisionVerdict]

// ── Supervision — the recovery threads ─────────────────────────────────

/**
 * The supervision recovery threads — thread-orchestrated recovery for a
 * standing halt:
 *
 * - **`supervision-judge-retry`** — an UNJUDGED halt (a reason rides the
 *   detail — the judge was unavailable) re-issues the same Decision. The
 *   attempt count rides the thread's rule position, the generator state —
 *   the same idiom as the supervisor's counter: `maxReissues` re-issue
 *   rules, then the thread parks on the next release and the halt stands
 *   (bounded — no timer exists, so the provider's own 429/529 transport
 *   retry with `retry-after` backoff is the backoff; the thread bounds the
 *   re-asks). A release — a later lift or an override — re-arms the budget.
 *   A JUDGED halt (no reason — the judge answered `halt`) never re-issues:
 *   the judge spoke.
 * - **`supervision-override`** — the host/TUI ingress
 *   (`supervision_override { type }`) lifts the block for the named type —
 *   the human decision path. The listener's detailSchema is the trust
 *   boundary: a malformed override never matches, the block holds.
 */

/** The bounded re-issues for an unjudged halt — past the bound, the halt stands. */
export const SUPERVISION_MAX_REISSUES = 2

/** The host's override ingress — the human lift for one watched type. */
export type SupervisionOverride = {
  /** The watched event type whose block lifts. */
  type: string
}

/** The override detail's one home — the ingress boundary is the listener's gate. */
export const SUPERVISION_OVERRIDE_SCHEMA = {
  type: 'object',
  properties: { type: { type: 'string', minLength: 1 } },
  required: ['type'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SupervisionOverride>

/** The override detail's boundary — hosts validate ingress before triggering. */
export const validateSupervisionOverride = ajv.compile(SUPERVISION_OVERRIDE_SCHEMA)

/**
 * Build the supervision recovery threads — the bounded judge-retry and the
 * override ingress. The watch list scopes both (only watched types re-ask,
 * only watched releases re-arm); the threshold rebuilds the re-issued
 * Decision's state (the count at a standing trip is the threshold, by
 * construction — no selections advance while the type is blocked).
 */
export const supervisionRecoveryThreads = ({
  watch,
  threshold = SUPERVISION_DEFAULT_THRESHOLD,
  maxReissues = SUPERVISION_MAX_REISSUES,
}: {
  watch: string[]
  threshold?: number
  maxReissues?: number
}): Thread[] => [
  {
    label: 'system-one/supervision-judge-retry',
    rules: [
      // The attempt count rides the rule position: each unjudged halt
      // consumes one re-issue; past the bound, the parking rule below holds
      // until a release re-arms the budget.
      ...Array.from({ length: maxReissues }, () => ({
        transform: [
          {
            type: SUPERVISION_EVENT_TYPES.halted,
            query: `. as $d | ${supervisionRequestJq(`{ lane: "supervision", type: $d.type, count: ${threshold}, threshold: ${threshold} }`)}`,
            target: FACULTY_MESSAGE_KINDS.system_one_request,
            // An UNJUDGED halt for a watched type — the reason's presence is
            // the judge-unavailable mark (a judged halt carries no prose).
            detailSchema: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: watch },
                reason: { type: 'string', minLength: 1 },
              },
              required: ['type', 'reason'],
              additionalProperties: false,
            },
          },
        ],
      })),
      // The re-arm: a release (a lift or an override) wraps the budget.
      {
        waitFor: [
          {
            type: SUPERVISION_EVENT_TYPES.release,
            detailSchema: {
              type: 'object',
              properties: { type: { type: 'string', enum: watch } },
              required: ['type'],
            },
          },
        ],
      },
    ],
  },
  {
    label: 'system-one/supervision-override',
    rules: [
      {
        transform: [
          {
            type: SUPERVISION_EVENT_TYPES.override,
            query: `. as $d | { type: $d.type }`,
            target: SUPERVISION_EVENT_TYPES.release,
            detailSchema: SUPERVISION_OVERRIDE_SCHEMA,
          },
        ],
      },
    ],
  },
]
