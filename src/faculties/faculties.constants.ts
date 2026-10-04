import { keyMirror } from '../utils.ts'

/**
 * The default space — the root. Part of the wire vocabulary (space stamping
 * rides every event + trace); the daemon's store actuator carries its own
 * byte-identical copy (`src/actuators/store.types.ts`, the two-homes
 * ruling: the daemon layer owns wire copies, this tree owns the browser-side
 * wire home).
 */
export const ROOT_SPACE = 'root'

/**
 * Discriminant values for the faculty event wire — every `*_request` /
 * `*_request_result` pair a faculty speaks, plus the crash event. The
 * wire layer's registry.
 */
export const FACULTY_MESSAGE_KINDS = keyMirror(
  'system_two_request',
  'system_two_request_result',
  'system_two_cancel',
  'system_one_request',
  'system_one_request_result',
  'system_one_cancel',
  'shell_request',
  'shell_request_result',
  'shell_cancel',
  'credential_request',
  'credential_result',
  'credential_cancel',
  'frontier_analysis_request',
  'frontier_analysis_request_result',
  'store_request',
  'store_request_result',
  'transform_request',
  'transform_request_result',
  'faculty_error',
)

/**
 * The actuator routing registry — lane name → the wire kinds that route to
 * it. ONE home: the composition's routing (b-program.ts) and the daemon's
 * faculty bridge derive from the same table; a parallel table would drift.
 */
export const ACTUATOR_ROUTE: Record<string, string[]> = {
  shell: [FACULTY_MESSAGE_KINDS.shell_request, FACULTY_MESSAGE_KINDS.shell_cancel],
  store: [FACULTY_MESSAGE_KINDS.store_request],
  security: [FACULTY_MESSAGE_KINDS.credential_request, FACULTY_MESSAGE_KINDS.credential_cancel],
}

/**
 * The trace push kind — the composition worker's upstream trace leg rides
 * the faculty-wire framing as `{ type: 'trace', detail: <trace> }`. The
 * bridge folds it into the daemon's one observability stream; the daemon
 * fan-out delivers it to scoped clients only.
 */
export const TRACE_PUSH_KIND = 'trace'
