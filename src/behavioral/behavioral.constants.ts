import { keyMirror } from '../utils.ts'

/**
 * Discriminant values for the `SnapshotMessage` union.
 *
 * @remarks
 * Use the `kind` field to narrow the union:
 * - `'deadlock'` — no unblocked candidate could be selected
 * - `'idle'` — no candidates at all; the program is quiescent (not deadlocked)
 * - `'frontier'` — frontier snapshot per super-step
 * - `'pending_bids'` — pending thread bids per super-step
 * - `'selection'` — event selection trace
 * - `'step'` — a super-step began; `ingress: true` marks an externally
 *   initiated step
 * - `'interrupt'` — a b-thread was terminated by a matching interrupt listener
 * - `'transform'` — a b-thread's transform listener matched; the engine mints
 *   the `transform_request` once-thread (the reshape contract rides to the
 *   fixed fourth faculty — the composition routes it and mints the target at
 *   the result leg); targets select one super-step later
 * - `'trigger_error'` — event rejected at the `trigger` ingress boundary
 * - `'add_thread_error'` — invalid thread arguments passed to `useAddThread`
 * - `'thread_removed'` — a host-authority removal terminated a b-thread
 *   (`removeThread` — the interrupt teardown with host authority, staged to
 *   the next super-step); mirrors `thread_added`'s payload
 *
 * @public
 */
export const TRACE_MESSAGE_KINDS = keyMirror(
  'deadlock',
  'idle',
  'frontier',
  'pending_bids',
  'selection',
  'trigger_error',
  'add_thread_error',
  'thread_added',
  'thread_removed',
  'interrupt',
  'transform',
  'step',
)

/**
 * Discriminant values for the scheduler-facing frontier status.
 *
 * @remarks
 * - `'ready'` — enabled candidates are available for selection
 * - `'deadlock'` — candidates exist but all are blocked
 * - `'idle'` — no candidates at all
 *
 * @public
 */
export const FRONTIER_STATUS = keyMirror('ready', 'deadlock', 'idle')

export const IDIOMS = keyMirror('waitFor', 'interrupt', 'request', 'block', 'transform')

/**
 * The event type the engine mints for a transform match — the reshape
 * contract riding to the fixed fourth faculty. TWO-HOME pairing: the wire
 * home's kinds registry (`faculties.constants.ts`) carries the byte-identical
 * key; the engine cannot import the faculties tree, so the minting side owns
 * this copy (the same ruling as ROOT_SPACE's daemon copy).
 */
export const TRANSFORM_REQUEST_EVENT = 'transform_request'
