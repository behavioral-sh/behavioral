/**
 * The remote-mcp threads — the MCP layering over the shell faculty's
 * generic `rpc` op. This is where "MCP" lives: the op is transport-shaped,
 * and these threads stamp the protocol envelope, drives discovery, executes
 * tools, runs the multi-round-trip elicitation loop, and retries retryable
 * remote failures.
 *
 * @remarks
 * Per the Direction/A ruling (MCP 2026-07-28 is stateless): no handshake, no
 * session id — every request carries the protocol stamp in-band, and every
 * response is one stateless HTTP POST's answer.
 *
 * - **Request stamping** — every rpc op the threads issue carries the
 *   `_meta` envelope (`io.modelcontextprotocol/protocolVersion` +
 *   `clientInfo` + `clientCapabilities`, the reserved request-envelope keys
 *   for this revision) and the `MCP-Protocol-Version` header. The op carries
 *   the envelope; the threads stamp it.
 * - **Discovery** — `remote_mcp_discover { url }` issues `server/discover`,
 *   chains `tools/list`, registers the tools in the store registry
 *   (alongside the skills/plugins tenants), and surfaces
 *   `remote_mcp_discovered`.
 * - **Execution** — `remote_mcp_call { url, tool, args }` issues `tools/call`
 *   and surfaces `remote_mcp_call_result`.
 * - **MRTR** — an `input_required` result (the reserved `inputRequests` /
 *   `requestState` members; at-least-one) surfaces
 *   `remote_mcp_elicitation` to the host; the host answers with
 *   `remote_mcp_elicitation_response` (the elicitation detail echoed + the
 *   bare `inputResponses`) and the threads retry `tools/call` with the
 *   answers + a byte-exact `requestState` echo, on a FRESH request id, up to
 *   the round cap.
 * - **Retry** — retryable remote failures (deadline, network, generic 5xx)
 *   re-request the op with the attempt advanced, bounded. `retry-after`
 *   rides as data when a server sends it (the op surfaces the remote code).
 *
 * THE JOIN LANE: cross-event state (the original call behind a result, the
 * attempt counter, the MRTR round) rides the shell wire's `ctx` echo — the
 * out-of-band lane beside `input` (the you.com MCP `_meta` pattern:
 * host-supplied, round-tripped verbatim, never model-facing). Auth rides the
 * credential seam (`shell/rpc-auth.threads.ts`): a 401 challenge maps to the
 * typed `credential_required`, and the seam vends + replays with the token.
 *
 * Trusted response shapes — the threads AJV-validate ONLY the four responses
 * it acts on (`server/discover`, `tools/list`, `tools/call`,
 * `InputRequiredResult`); a response failing its trusted shape silently
 * no-matches the acting transform (the result stays visible as an unmatched
 * event in the frontier traces) — fail-closed, not silently-wrong.
 *
 * Requires shell + security + store — bProgram mounts it only when all three
 * are on.
 *
 * MINIMAL: the failed-vend surfacing rides the security faculty's error-branch
 * ctx echo (the vend-failure thread) — the caller learns the typed
 * absent-credential error instead of pending forever.
 *
 * @packageDocumentation
 */

import type { Thread } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types: discover/call are ingress; discovered/callResult/elicitation surface; the response is host ingress. */
export const REMOTE_MCP_EVENT_TYPES = {
  discover: 'remote_mcp_discover',
  call: 'remote_mcp_call',
  discovered: 'remote_mcp_discovered',
  callResult: 'remote_mcp_call_result',
  elicitation: 'remote_mcp_elicitation',
  elicitationResponse: 'remote_mcp_elicitation_response',
} as const

/** The store registry tenant holding registered remote tools, keyed by server URL. */
export const REMOTE_MCP_STORE_COLLECTION = 'remote-mcp'

/** The protocol revision these threads speak (the 2026-07-28 stateless era). */
export const REMOTE_MCP_PROTOCOL_VERSION = '2026-07-28'

/** The label every rpc op these threads issue carries (trace annotation, no routing weight). */
export const REMOTE_MCP_LABEL = 'remote-mcp'

/** Bounded retry: a retryable failure re-requests the op until this many attempts. */
export const REMOTE_MCP_MAX_ATTEMPTS = 2

/** Bounded MRTR: the elicitation loop runs until this many rounds. */
export const REMOTE_MCP_MAX_ROUNDS = 2

// The protocol stamp — the reserved request-envelope `_meta` keys for this
// revision, plus the header form. RESULTS never carry these (they are
// request-envelope keys only).
const STAMP_HEADERS = `{ "MCP-Protocol-Version": "${REMOTE_MCP_PROTOCOL_VERSION}" }`

const STAMP_META = `{ "io.modelcontextprotocol/protocolVersion": "${REMOTE_MCP_PROTOCOL_VERSION}", "io.modelcontextprotocol/clientInfo": { name: "behavioral", version: "0.0.0" }, "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } }`

// ── The four trusted response shapes ─────────────────────────────────────────
// Minimal slices of the 2026-07-28 responses the threads act on — the trust
// boundary for anything crossing in from a remote server. Loose on members
// the threads do not consume (the responses carry _meta, icons, …).

/** `server/discover` result — the threads trust the advertised versions. */
export const REMOTE_MCP_DISCOVER_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    supportedVersions: { type: 'array', items: { type: 'string' }, minItems: 1 },
    capabilities: { type: 'object' },
  },
  required: ['supportedVersions'],
  additionalProperties: true,
} as const

/** `tools/list` result — the threads trust the tool names (registration keys). */
export const REMOTE_MCP_TOOLS_LIST_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          inputSchema: { type: 'object' },
        },
        required: ['name'],
        additionalProperties: true,
      },
    },
  },
  required: ['tools'],
  additionalProperties: true,
} as const

/** `tools/call` result — the threads trust the content array shape (loose members). */
export const REMOTE_MCP_CALL_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'array', items: { type: 'object' } },
    isError: { type: 'boolean' },
  },
  additionalProperties: true,
} as const

/**
 * `InputRequiredResult` — the reserved `inputRequests` / `requestState`
 * members, at-least-one (the server seam's rule). The MRTR handshake's
 * embedded requests ride `inputRequests`; the opaque `requestState` echoes
 * byte-exact on the retry.
 */
export const REMOTE_MCP_INPUT_REQUIRED_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    inputRequests: { type: 'object' },
    requestState: { type: 'string', minLength: 1 },
  },
  anyOf: [{ required: ['inputRequests'] }, { required: ['requestState'] }],
  additionalProperties: true,
} as const

// ── Shared jq fragments ──────────────────────────────────────────────────────

// (The retry-vs-surface division is schema-expressible now — the op computes
// `retryable` once where the numeric comparison lives, so no shared jq
// fragment is needed. The gates below carry the whole division.)

/**
 * The retry gate: a FAILURE-shaped shell result the retry listener acts on —
 * `ok` const false, the join lane (`ctx.echo`) present with the attempt
 * stamped, and the op-computed `retryable: true` under the attempt cap.
 * `credential_required` never matches (the seam stamps it `retryable: false`
 * and owns it); successes never match. The schema is the whole match — the
 * jq never declines, so no genuine failure emits a transform_error.
 */
const rpcRetryGate = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: false },
    error: {
      type: 'object',
      required: ['retryable'],
      properties: { retryable: { type: 'boolean', const: true } },
    },
    ctx: {
      type: 'object',
      required: ['echo'],
      properties: {
        echo: {
          type: 'object',
          required: ['attempt'],
          properties: { attempt: { type: 'integer', maximum: REMOTE_MCP_MAX_ATTEMPTS - 1 } },
        },
      },
    },
  },
  required: ['id', 'ok', 'error', 'ctx'],
} as const

/**
 * The surface gate (per leg): a FAILURE-shaped shell result the surface
 * listeners act on — non-retryable (any attempt), or retryable with the
 * attempt at the cap (only the retry thread's own advance stamps that).
 * `credential_required` never matches: the vend-and-replay seam owns those.
 * Together with the retry gate the division is total — a genuine failure
 * matches exactly one side, so no listener ever declines into an
 * empty-output transform_error trace.
 */
const rpcSurfaceGate = (legs: string[]) =>
  ({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      ok: { type: 'boolean', const: false },
      error: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', not: { const: 'credential_required' } } },
      },
      ctx: {
        type: 'object',
        required: ['echo'],
        properties: {
          echo: {
            type: 'object',
            required: ['leg'],
            properties: { leg: { enum: legs }, attempt: { type: 'integer' } },
          },
        },
      },
    },
    required: ['id', 'ok', 'error', 'ctx'],
    anyOf: [
      {
        type: 'object',
        properties: {
          error: { type: 'object', required: ['retryable'], properties: { retryable: { const: false } } },
        },
      },
      {
        type: 'object',
        properties: {
          ctx: {
            type: 'object',
            properties: {
              echo: {
                type: 'object',
                required: ['attempt'],
                properties: { attempt: { type: 'integer', minimum: REMOTE_MCP_MAX_ATTEMPTS } },
              },
            },
          },
        },
      },
    ],
  }) as const

// ── Threads ──────────────────────────────────────────────────────────────────

/** discover-issue — `remote_mcp_discover` issues the stamped `server/discover` op. */
const discoverIssue: Thread = {
  label: 'remote-mcp/discover-issue',
  rules: [
    {
      transform: [
        {
          type: REMOTE_MCP_EVENT_TYPES.discover,
          query: `. as $d | select($d.input.url != null) | { id: ($d.id + "-discover"), label: "${REMOTE_MCP_LABEL}", ctx: { echo: { source: $d.id, url: $d.input.url, leg: "discover", attempt: 0 } }, input: { op: "rpc", url: $d.input.url, method: "server/discover", headers: ${STAMP_HEADERS}, params: { _meta: ${STAMP_META} } } }`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              input: { type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'] },
            },
            required: ['id', 'input'],
          },
        },
      ],
    },
  ],
}

/** tools-issue — the discover result (trusted shape) chains the stamped `tools/list` op. */
const toolsIssue: Thread = {
  label: 'remote-mcp/tools-issue',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | select($d.ok == true and $d.ctx.echo.leg == "discover") | { id: ($d.ctx.echo.source + "-tools"), label: "${REMOTE_MCP_LABEL}", ctx: { echo: { source: $d.ctx.echo.source, url: $d.ctx.echo.url, leg: "tools", attempt: 0 } }, input: { op: "rpc", url: $d.ctx.echo.url, method: "tools/list", headers: ${STAMP_HEADERS}, params: { _meta: ${STAMP_META} } } }`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean' },
              result: {
                type: 'object',
                properties: { output: REMOTE_MCP_DISCOVER_RESULT_SCHEMA },
                required: ['output'],
              },
            },
            required: ['id', 'ok', 'result'],
          },
        },
      ],
    },
  ],
}

/** register — the tools result (trusted shape) registers the tenant and surfaces the outcome. */
const register: Thread = {
  label: 'remote-mcp/register',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | select($d.ok == true and $d.ctx.echo.leg == "tools") | { id: ("rmcp-register-" + $d.ctx.echo.source), op: "put", input: { collection: "${REMOTE_MCP_STORE_COLLECTION}", key: $d.ctx.echo.url, value: { url: $d.ctx.echo.url, tools: $d.result.output.tools } } }`,
          target: FACULTY_MESSAGE_KINDS.store_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean' },
              result: {
                type: 'object',
                properties: { output: REMOTE_MCP_TOOLS_LIST_RESULT_SCHEMA },
                required: ['output'],
              },
            },
            required: ['id', 'ok', 'result'],
          },
        },
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | select($d.ok == true and $d.ctx.echo.leg == "tools") | { id: $d.ctx.echo.source, ok: true, input: { url: $d.ctx.echo.url, tools: $d.result.output.tools } }`,
          target: REMOTE_MCP_EVENT_TYPES.discovered,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean' },
              result: {
                type: 'object',
                properties: { output: REMOTE_MCP_TOOLS_LIST_RESULT_SCHEMA },
                required: ['output'],
              },
            },
            required: ['id', 'ok', 'result'],
          },
        },
      ],
    },
  ],
}

/** call-issue — `remote_mcp_call` issues the stamped `tools/call` op. */
const callIssue: Thread = {
  label: 'remote-mcp/call-issue',
  rules: [
    {
      transform: [
        {
          type: REMOTE_MCP_EVENT_TYPES.call,
          query: `. as $d | select($d.input.url != null and $d.input.tool != null) | { id: ($d.id + "-call"), label: "${REMOTE_MCP_LABEL}", ctx: { echo: { source: $d.id, url: $d.input.url, tool: $d.input.tool, args: ($d.input.args // {}), leg: "call", round: 0, attempt: 0 } }, input: { op: "rpc", url: $d.input.url, method: "tools/call", headers: ${STAMP_HEADERS}, params: { name: $d.input.tool, arguments: ($d.input.args // {}), _meta: ${STAMP_META} } } }`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              input: {
                type: 'object',
                properties: { url: { type: 'string', minLength: 1 }, tool: { type: 'string', minLength: 1 } },
                required: ['url', 'tool'],
              },
            },
            required: ['id', 'input'],
          },
        },
      ],
    },
  ],
}

/** elicitation — an `input_required` result (trusted shape) surfaces the embedded requests to the host. */
const elicitation: Thread = {
  label: 'remote-mcp/elicitation',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | select($d.ok == true and $d.ctx.echo.leg == "call") | { id: $d.ctx.echo.source, input: { url: $d.ctx.echo.url, tool: $d.ctx.echo.tool, args: $d.ctx.echo.args, round: $d.ctx.echo.round, inputRequests: $d.result.output.inputRequests, requestState: $d.result.output.requestState } }`,
          target: REMOTE_MCP_EVENT_TYPES.elicitation,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean' },
              result: {
                type: 'object',
                properties: { output: REMOTE_MCP_INPUT_REQUIRED_RESULT_SCHEMA },
                required: ['output'],
              },
            },
            required: ['id', 'ok', 'result'],
          },
        },
      ],
    },
  ],
}

/** call-result — a complete `tools/call` result (trusted shape) surfaces to the caller. */
const callResult: Thread = {
  label: 'remote-mcp/call-result',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | select($d.ok == true and $d.ctx.echo.leg == "call" and ($d.result.output.inputRequests == null) and ($d.result.output.requestState == null)) | { id: $d.ctx.echo.source, ok: true, result: $d.result.output }`,
          target: REMOTE_MCP_EVENT_TYPES.callResult,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean' },
              result: { type: 'object', properties: { output: REMOTE_MCP_CALL_RESULT_SCHEMA }, required: ['output'] },
            },
            required: ['id', 'ok', 'result'],
          },
        },
      ],
    },
  ],
}

/** retry-issue — the host's answers retry `tools/call`: fresh request id, answers + the byte-exact `requestState` echo. */
const retryIssue: Thread = {
  label: 'remote-mcp/retry-issue',
  rules: [
    {
      transform: [
        {
          type: REMOTE_MCP_EVENT_TYPES.elicitationResponse,
          query: `. as $d | select(($d.input.round // 0) < ${REMOTE_MCP_MAX_ROUNDS}) | { id: ($d.id + "-call-r" + ((($d.input.round // 0) + 1) | tostring)), label: "${REMOTE_MCP_LABEL}", ctx: { echo: { source: $d.id, url: $d.input.url, tool: $d.input.tool, args: ($d.input.args // {}), leg: "call", round: (($d.input.round // 0) + 1), attempt: 0 } }, input: { op: "rpc", url: $d.input.url, method: "tools/call", headers: ${STAMP_HEADERS}, params: (({ name: $d.input.tool, arguments: ($d.input.args // {}), _meta: ${STAMP_META} }) + (if $d.input.inputResponses != null then { inputResponses: $d.input.inputResponses } else {} end) + (if $d.input.requestState != null then { requestState: $d.input.requestState } else {} end)) } }`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              input: {
                type: 'object',
                properties: { url: { type: 'string' }, tool: { type: 'string' } },
                required: ['url', 'tool'],
              },
            },
            required: ['id', 'input'],
          },
        },
      ],
    },
  ],
}

/** round-cap — the MRTR loop exhausted: the caller gets the typed cap error. */
const roundCap: Thread = {
  label: 'remote-mcp/round-cap',
  rules: [
    {
      transform: [
        {
          type: REMOTE_MCP_EVENT_TYPES.elicitationResponse,
          query: `. as $d | select(($d.input.round // 0) >= ${REMOTE_MCP_MAX_ROUNDS}) | { id: $d.id, ok: false, error: { code: "round_cap", message: "multi-round-trip cap exhausted" } }`,
          target: REMOTE_MCP_EVENT_TYPES.callResult,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, input: { type: 'object' } },
            required: ['id', 'input'],
          },
        },
      ],
    },
  ],
}

/**
 * retry — a retryable remote failure re-requests the op with the attempt
 * advanced (the leg decides the rebuild). Bounded: the gate caps the
 * attempt, and the surface listeners catch the exhausted failure. The
 * credential seam's `credential_required` failures are excluded at the
 * gate — the vend-and-replay owns those. The schema is the whole match;
 * the jq only rebuilds.
 */
const retry: Thread = {
  label: 'remote-mcp/retry',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | { id: $d.id, label: "${REMOTE_MCP_LABEL}", ctx: { echo: ($d.ctx.echo + { attempt: ($d.ctx.echo.attempt + 1) }) }, input: (if $d.ctx.echo.leg == "call" then { op: "rpc", url: $d.ctx.echo.url, method: "tools/call", headers: ${STAMP_HEADERS}, params: { name: $d.ctx.echo.tool, arguments: ($d.ctx.echo.args // {}), _meta: ${STAMP_META} } } elif $d.ctx.echo.leg == "tools" then { op: "rpc", url: $d.ctx.echo.url, method: "tools/list", headers: ${STAMP_HEADERS}, params: ${STAMP_META} } else { op: "rpc", url: $d.ctx.echo.url, method: "server/discover", headers: ${STAMP_HEADERS}, params: ${STAMP_META} } end) }`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: rpcRetryGate,
        },
      ],
    },
  ],
}

/** call-failure — a non-retryable (or exhausted) call failure surfaces to the caller. */
const callFailure: Thread = {
  label: 'remote-mcp/call-failure',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | { id: $d.ctx.echo.source, ok: false, error: { code: $d.error.code, message: $d.error.message, remoteCode: $d.error.remoteCode } }`,
          target: REMOTE_MCP_EVENT_TYPES.callResult,
          detailSchema: rpcSurfaceGate(['call']),
        },
      ],
    },
  ],
}

/** discover-failure — a non-retryable (or exhausted) discovery failure surfaces to the caller. */
const discoverFailure: Thread = {
  label: 'remote-mcp/discover-failure',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | { id: $d.ctx.echo.source, ok: false, error: { code: $d.error.code, message: $d.error.message, remoteCode: $d.error.remoteCode } }`,
          target: REMOTE_MCP_EVENT_TYPES.discovered,
          detailSchema: rpcSurfaceGate(['discover', 'tools']),
        },
      ],
    },
  ],
}

/**
 * vend-failure — the security faculty echoes the request ctx on FAILED vends,
 * so a remote-mcp call whose vend fails surfaces the typed absent-credential error
 * to the caller (no pending-forever wait). Direct (non-remote-mcp) callers carry
 * no remote-mcp ctx — their vend failures never surface a remote-mcp result.
 */
const vendFailure: Thread = {
  label: 'remote-mcp/vend-failure',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.credential_result,
          query: `. as $d | select($d.ok == false and (($d.ctx.echo.ctx.echo.leg // "") == "call")) | { id: $d.ctx.echo.ctx.echo.source, ok: false, error: { code: "error", message: $d.error.message } }`,
          target: REMOTE_MCP_EVENT_TYPES.callResult,
          // The gate is the jq condition in schema form — the failed vend of
          // a REMOTE-MCP call (the ctx echo chain, leg "call"): a direct
          // caller’s failed vend never even matches, so its decline is not an
          // empty-output transform_error trace.
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              ok: { type: 'boolean', const: false },
              error: { type: 'object' },
              ctx: {
                type: 'object',
                required: ['echo'],
                properties: {
                  echo: {
                    type: 'object',
                    required: ['ctx'],
                    properties: {
                      ctx: {
                        type: 'object',
                        required: ['echo'],
                        properties: {
                          echo: {
                            type: 'object',
                            required: ['leg'],
                            properties: { leg: { type: 'string', const: 'call' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            required: ['id', 'ok', 'error', 'ctx'],
          },
        },
      ],
    },
  ],
}

/** The remote-mcp thread library — add to the program alongside the shell faculty. */
export const remoteMcpThreads: Thread[] = [
  discoverIssue,
  toolsIssue,
  register,
  callIssue,
  elicitation,
  callResult,
  retryIssue,
  roundCap,
  retry,
  callFailure,
  discoverFailure,
  vendFailure,
]
