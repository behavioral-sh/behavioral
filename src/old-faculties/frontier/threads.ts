import type { JsonObject, Thread } from '../../behavioral/behavioral.types.ts'
import { ThreadSchema } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { ADMISSION_EVENT_TYPES } from '../system-one/threads.ts'

/**
 * The frontier faculty's admission-review threads and policy — the
 * structural layer of thread admission (the pilot ruling, 2026-09-25:
 * **livelock detection is part of adding threads**).
 *
 * @remarks
 * A proposed thread is analyzed before it joins the live program: the
 * `add_thread` op's verification runs with the composition's progress
 * specification, so a self-sustaining request loop — a reachable cycle that
 * never selects a progress event — is a `failed` verdict and never admits
 * (fail-closed; `truncated` never passes either). This is the shape that
 * overflowed the recursive super-step cascade at ~8.6k selections; the
 * guard keeps it out before it ever runs.
 *
 * **Progress is composition policy, never requester-claimed**: the derived
 * `*_result` kinds — "progress = an external consumer observed a result" —
 * so a requester cannot launder a livelock past the check by declaring its
 * own vocabulary. The exploration budget is the same posture: the requester
 * may pass `maxDepth` for an edge case, but the composition clamps it.
 *
 * The judgment pack (`system-one/threads.ts`) is the semantic layer above
 * this one: with systemOne wired, a structurally-verified candidate still
 * waits on a Decision. The two layers compose — this file owns the
 * structural verdict's specification.
 *
 * @packageDocumentation
 */

// ── The progress specification ───────────────────────────────────────────────

/**
 * What counts as progress in this composition: every faculty result kind.
 * A reachable cycle that never selects one of these can spin forever
 * without anything external observing a result — a livelock.
 *
 * Derived from the kind registry (the one home), so a new faculty's result
 * kind automatically counts — no list to keep in sync.
 */
export const ADMISSION_PROGRESS: string[] = Object.values(FACULTY_MESSAGE_KINDS).filter((kind) =>
  kind.endsWith('_result'),
)

// ── The exploration budget ──────────────────────────────────────────────────

/** The composition's default exploration depth — the pilot's "20K is a safe max". */
export const ADMISSION_MAX_DEPTH_DEFAULT = 20_000
/**
 * The clamp on a requester-supplied `maxDepth` (an edge case may ask for
 * deeper analysis). Bounds the analysis compute a single proposal can spend.
 */
export const ADMISSION_MAX_DEPTH_CEILING = 100_000

/**
 * Enrich an `add_thread` proposal's analysis input with the composition's
 * policy — the progress specification (always overridden; unspoofable) and
 * the clamped exploration budget (default when absent or malformed).
 */
export const admissionAnalysisInput = (input: JsonObject): JsonObject => {
  const maxDepth = Number((input as { maxDepth?: unknown }).maxDepth)
  return {
    ...input,
    progress: ADMISSION_PROGRESS,
    maxDepth:
      Number.isInteger(maxDepth) && maxDepth >= 1
        ? Math.min(maxDepth, ADMISSION_MAX_DEPTH_CEILING)
        : ADMISSION_MAX_DEPTH_DEFAULT,
  }
}

// ── The review pack ──────────────────────────────────────────────────────────

/**
 * The add_thread proposal's shape — the gate's trigger. Scoped to the op so
 * every other frontier_request (replay/explore/verify) passes the gate by.
 */
const ADD_THREAD_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    op: { type: 'string', const: 'add_thread' },
  },
  required: ['id', 'op'],
  additionalProperties: true,
} as const

/**
 * The add_thread verdict's shape — a result envelope echoing the proposed
 * thread. Scopes the review listeners to add_thread verdicts: every other
 * frontier op's result (and the validate-failure envelope, which carries no
 * `result`) fails this schema and never reaches the jq.
 */
const ADD_THREAD_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean' },
    result: {
      type: 'object',
      properties: { thread: ThreadSchema },
      required: ['thread'],
      additionalProperties: true,
    },
  },
  required: ['id', 'ok', 'result'],
  additionalProperties: true,
} as const

/**
 * The approving verdict's shape — the gate's lift condition: envelope ok AND
 * verdict ok. Every other outcome (a failed verdict — livelock, deadlock,
 * truncation — or an error envelope) holds the block until the rejection
 * event releases it.
 */
const ADD_THREAD_APPROVAL_SCHEMA = {
  ...ADD_THREAD_RESULT_SCHEMA,
  properties: {
    ...ADD_THREAD_RESULT_SCHEMA.properties,
    ok: { type: 'boolean', const: true },
    result: {
      ...ADD_THREAD_RESULT_SCHEMA.properties.result,
      properties: {
        ...ADD_THREAD_RESULT_SCHEMA.properties.result.properties,
        ok: { type: 'boolean', const: true },
      },
    },
  },
} as const

/** admission-review-gate — the blocking reviewer: admission is blocked while the analysis is in flight. */
const reviewGate: Thread = {
  label: 'frontier/admission-review-gate',
  rules: [
    { waitFor: [{ type: FACULTY_MESSAGE_KINDS.frontier_request, detailSchema: ADD_THREAD_REQUEST_SCHEMA }] },
    {
      block: [{ type: ADMISSION_EVENT_TYPES.admitted }],
      waitFor: [
        { type: FACULTY_MESSAGE_KINDS.frontier_request_result, detailSchema: ADD_THREAD_APPROVAL_SCHEMA },
        { type: ADMISSION_EVENT_TYPES.rejected },
      ],
    },
  ],
}

/**
 * admission-review-verdict — the verdict maps to the outcome; everything but
 * an approving verdict rejects. Both listeners are jq filters over the same
 * result envelope; each emits only on its own select() — the jq is the
 * conditional (the transform idiom's two-outcome pattern, per the judgment
 * pack). Fail-closed: the only road to admission is a conforming verdict.
 */
const reviewVerdict: Thread = {
  label: 'frontier/admission-review-verdict',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.frontier_request_result,
          query:
            '. as $d | select(($d.ok // false) == true and ($d.result.ok // false) == true) | { id: $d.id, admit: true }',
          target: ADMISSION_EVENT_TYPES.admitted,
          detailSchema: ADD_THREAD_RESULT_SCHEMA,
        },
        {
          type: FACULTY_MESSAGE_KINDS.frontier_request_result,
          query:
            '. as $d | select((($d.ok // false) != true) or (($d.result.ok // false) != true)) | { id: $d.id, admit: false }',
          target: ADMISSION_EVENT_TYPES.rejected,
          detailSchema: ADD_THREAD_RESULT_SCHEMA,
        },
      ],
    },
  ],
}

/**
 * The structural admission review threads — the BP-native reviewer the
 * composition mounts WITHOUT judgment (mode-exclusive with the judgment
 * pack: with systemOne, the candidate record routes through the Decision
 * instead). The composition still owns the write: `thread_admission`
 * selections admit via the pending-id map (the authorization).
 */
export const admissionReviewThreads: Thread[] = [reviewGate, reviewVerdict]
