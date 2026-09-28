/**
 * The rpc auth seam's threads — the vend-and-replay spine that wires the
 * shell faculty's `rpc` op to the security faculty's credential vending.
 *
 * @remarks
 * The declarative flow: an `rpc` op declared `auth: true` short-circuits (in
 * the shell faculty) as a typed `credential_required` result echoing the
 * originating request — the capture payload. These threads complete the
 * round-trip:
 *
 * 1. **requestor** — a `credential_required` result (first attempt only: a
 *    replayed call already carries `authToken`) transforms into a
 *    `credential_request { serverUrl }` with the original call riding
 *    `ctx.echo` — the out-of-band lane (the you.com MCP pattern: host-supplied
 *    data rides `detail.ctx` beside `input`, never as a model-facing field).
 * 2. **replayer** — the vended `credential_result` (token + echoed ctx)
 *    replays the original `shell_request` with the bearer merged into the
 *    input. The security faculty never talks to shell directly; this thread
 *    is the only join.
 *
 * The absent-credential branch is deliberately inert: the caller already
 * holds the terminal `credential_required` error, and a replay has nothing
 * to join on — the failed vend is visible as an unmatched `credential_result`
 * in the frontier traces. MINIMAL: no retry/backoff policy here; the generic
 * retry thread pattern covers it when needed.
 *
 * Requires shell + security — bProgram mounts it only when both are on.
 *
 * @packageDocumentation
 */

import type { Thread } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The correlation-suffix distinguishing a vend round-trip from its call. */
export const CREDENTIAL_SUFFIX = '-cred'

/**
 * The gate schema for the shell result events the requestor consumes — the
 * exact `credential_required` failure shape, so successes (the common case)
 * and unrelated failures never even match: a matched listener whose jq
 * declines is an empty-output transform_error trace, stray noise on every
 * clean rpc op. The jq select stays as the defense in depth; the schema is
 * the match gate (the transform idiom's separation).
 */
const RPC_AUTH_RESULT_DETAIL = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', const: 'credential_required' },
        request: {
          type: 'object',
          properties: {
            // `authToken` null-or-absent (jq `== null` semantics): a replayed
            // call carries the token and must not re-capture — the loop bound.
            input: {
              type: 'object',
              properties: {
                url: { type: 'string', minLength: 1 },
                authToken: { type: 'null' },
              },
              required: ['url'],
            },
          },
          required: ['input'],
        },
      },
      required: ['code', 'request'],
    },
  },
  required: ['id', 'ok', 'error'],
} as const

// ── Threads ───────────────────────────────────────────────────────────────────

/**
 * requestor — a `credential_required` shell result (first attempt only: the
 * gate requires no `authToken`, bounding the loop on a post-vend 401)
 * requests a credential for the call's server URL, carrying the original
 * request — and its own out-of-band `ctx` join lane — in `ctx.echo` for the
 * replay join. Serves BOTH paths with one gate: the declarative one (the op
 * short-circuits `auth: true` before calling) and the reactive one (a 401
 * challenge on an unauthenticated call maps to the same typed result).
 */
const credRequestor: Thread = {
  label: 'rpc-auth/requestor',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | select($d.ok == false and $d.error.code? == "credential_required" and ($d.error.request.input.authToken == null)) | {id: ($d.id + "-cred"), input: {serverUrl: $d.error.request.input.url}, ctx: {echo: {id: $d.id, input: $d.error.request.input, ctx: $d.ctx}}}',
          target: FACULTY_MESSAGE_KINDS.credential_request,
          detailSchema: RPC_AUTH_RESULT_DETAIL,
        },
      ],
    },
  ],
}

/**
 * replayer — a vended `credential_result` carrying the echoed request
 * replays the original `shell_request` with the bearer merged into the
 * input and the request's `ctx` join lane restored. The op proceeds with
 * the token; the op itself never knew OAuth.
 */
const credReplayer: Thread = {
  label: 'rpc-auth/replayer',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.credential_result,
          query:
            '. as $d | select($d.ok == true and ($d.result.echo != null)) | {id: $d.result.echo.id, input: ($d.result.echo.input + {authToken: $d.result.token}), ctx: $d.result.echo.ctx}',
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean' },
              result: {
                type: 'object',
                properties: { token: { type: 'string' }, echo: { type: 'object' } },
                required: ['token', 'echo'],
              },
            },
            required: ['id', 'ok', 'result'],
          },
        },
      ],
    },
  ],
}

/**
 * The rpc auth thread library — add to the program alongside the shell
 * faculty; requires the security faculty for the vending leg.
 */
export const rpcAuthThreads: Thread[] = [credRequestor, credReplayer]
