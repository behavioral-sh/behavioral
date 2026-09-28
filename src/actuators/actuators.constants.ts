import { keyMirror } from '../utils.ts'

/**
 * Discriminant values for the actuator event wire — the request/cancel/result
 * pairs the actuator processes speak, plus the crash event. The actuator
 * layer's registry (the actuator-owned copy of the faculty wire vocabulary —
 * the values are the wire's, byte-identical on both sides of the boundary).
 */
export const ACTUATOR_MESSAGE_KINDS = keyMirror(
  'shell_request',
  'shell_request_result',
  'shell_cancel',
  'credential_request',
  'credential_result',
  'credential_cancel',
  'store_request',
  'store_request_result',
  'faculty_error',
)
