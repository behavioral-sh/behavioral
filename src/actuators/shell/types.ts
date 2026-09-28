/**
 * Types shared by the shell faculty process (`shell/faculty.ts`) and its
 * event-wire consumers.
 *
 * @remarks
 * Types only — no runtime values, so importing this module has no side
 * effects on either side of the process boundary. The faculty runs as a
 * spawned process (stdio lines, never imported by the host), so the host
 * must never import the faculty for types; both sides import here instead.
 * The wire itself is the behavioral event vocabulary (`shell_request` /
 * `shell_cancel` in, one `shell_request_result` out) defined in
 * `src/faculties/faculties.types.ts` — only the `detail.input` and
 * `detail.result` payload shapes live here.
 *
 * The input is OP-DISCRIMINATED (the bun-direct conversion): `'run'`
 * executes a TypeScript script bun-direct (`bun run -`, script on stdin —
 * the recipe flavor); `'shell'` executes a Bun Shell command string through
 * the worker's constant wrapper (command via env; payload via env or, over
 * the large-payload threshold, a temp file the worker deletes on every
 * exit). The two flavors share the bounded-execution knobs; per-call data
 * for `'run'` scripts rides `env` (`bun run -` consumes stdin as the
 * script).
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'

/** Output representation for a completed execution. */
export type ShellFormat = 'paged' | 'json' | 'raw'

/** Terminal state of one execution. */
export type ShellStatus = 'completed' | 'timeout' | 'line_quota' | 'canceled' | 'error'

/**
 * Per-execution options.
 *
 * @remarks
 * `format`/`offset`/`limit` are the model-facing subset; `cwd`/`env`/`stdin`
 * and the bound knobs (`timeoutMs`/`maxLines`/`maxCharacters`) are host-only.
 * Host over-ceiling values are clamped, not rejected, and the clamp is
 * reported in {@link ShellSuccess.clamped}.
 */
export type ShellOptions = {
  /** Working directory for the execution. Defaults to the faculty's `cwd`. */
  cwd?: string
  /** Environment overrides merged over `process.env`. */
  env?: Record<string, string>
  /** Host-only payload written to the executed command's stdin (shell op only — channeled by the faculty). */
  stdin?: string
  /** Output representation. @default 'paged' */
  format?: ShellFormat
  /** Lines to skip before capturing. @default 0 */
  offset?: number
  /** Maximum lines to capture into the result. @default 50 */
  limit?: number
  /** Wall-clock deadline; the faculty group-kills on expiry. @default 30_000 */
  timeoutMs?: number
  /** Total stdout+stderr lines allowed before the faculty group-kills. @default 250 */
  maxLines?: number
  /** Character bound for `raw`/`json`/`stderr` output. @default 8_000 */
  maxCharacters?: number
}

// ---------------------------------------------------------------------------
// Op inputs — one shape per op, no legacy `script`-string catch-all
// ---------------------------------------------------------------------------

/** The `'run'` op input — a TypeScript script executed bun-direct. */
export type ShellRunOpInput = {
  op: 'run'
  /** The script source; `bun run -` reads it from stdin. */
  script: string
  cwd?: string
  env?: Record<string, string>
  format?: ShellFormat
  offset?: number
  limit?: number
  timeoutMs?: number
  maxLines?: number
  maxCharacters?: number
}

/** The `'shell'` op input — a Bun Shell command string through the wrapper. */
export type ShellShellOpInput = {
  op: 'shell'
  /** The Bun Shell command (pipes, &&/||, $(…), redirects — bash-like dialect). */
  command: string
  /** Data for the command's stdin — env channel, or temp file over the size threshold. */
  stdin?: string
  cwd?: string
  env?: Record<string, string>
  format?: ShellFormat
  offset?: number
  limit?: number
  timeoutMs?: number
  maxLines?: number
  maxCharacters?: number
}

/** The `'rpc'` op input — a generic remote JSON-RPC 2.0 call over HTTP POST. */
export type ShellRpcOpInput = {
  op: 'rpc'
  /** The remote endpoint URL — one stateless POST per call. */
  url: string
  /** The JSON-RPC method name (transport-shaped; protocol semantics live in threads). */
  method: string
  /** The JSON-RPC params object, when the method takes one. */
  params?: JsonObject
  /**
   * Declare the call needs a vended credential: without a token the op
   * short-circuits as typed `credential_required` (the threads' vend-
   * and-replay capture payload) — it never calls the remote unauthenticated.
   * The token itself rides `authToken`, injected by the replaying thread.
   */
  auth?: boolean
  /** The vended bearer token — set by the replaying thread, never model input. */
  authToken?: string
  /** Op-supplied headers (e.g. the remote-mcp threads' MCP-Protocol-Version stamp). */
  headers?: Record<string, string>
  /** Wall-clock deadline for the call. @default 30_000 */
  timeoutMs?: number
}

/** The `shell_request` event's `detail.input` — one discriminated shape per op. */
export type ShellCallInput = ShellRunOpInput | ShellShellOpInput | ShellRpcOpInput

// ---------------------------------------------------------------------------
// Input boundary (shared knobs + per-op payloads; strict at every level)
// ---------------------------------------------------------------------------

const sharedKnobProperties = {
  cwd: { type: 'string', nullable: true },
  env: { type: 'object', required: [], additionalProperties: { type: 'string' }, nullable: true },
  format: { type: 'string', enum: ['paged', 'json', 'raw'], nullable: true },
  offset: { type: 'integer', minimum: 0, nullable: true },
  limit: { type: 'integer', minimum: 1, nullable: true },
  timeoutMs: { type: 'integer', minimum: 1, nullable: true },
  maxLines: { type: 'integer', minimum: 1, nullable: true },
  maxCharacters: { type: 'integer', minimum: 1, nullable: true },
} as const

export const ShellRunOpInputSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'run' },
    script: { type: 'string', minLength: 1 },
    ...sharedKnobProperties,
  },
  required: ['op', 'script'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ShellRunOpInput>

export const ShellShellOpInputSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'shell' },
    command: { type: 'string', minLength: 1 },
    stdin: { type: 'string', nullable: true },
    ...sharedKnobProperties,
  },
  required: ['op', 'command'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ShellShellOpInput>

export const ShellRpcOpInputSchema: JSONSchemaType<ShellRpcOpInput> = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'rpc' },
    url: { type: 'string', minLength: 1 },
    method: { type: 'string', minLength: 1 },
    params: { type: 'object', required: [], additionalProperties: true, nullable: true },
    auth: { type: 'boolean', nullable: true },
    authToken: { type: 'string', nullable: true },
    headers: { type: 'object', required: [], additionalProperties: { type: 'string' }, nullable: true },
    timeoutMs: { type: 'integer', minimum: 1, nullable: true },
  },
  required: ['op', 'url', 'method'],
  additionalProperties: false,
}

/**
 * The op-discriminated input boundary — `anyOf` branches (strict AJV rejects
 * union `type` arrays), `additionalProperties: false` at every level so the
 * op shapes cannot bleed into each other.
 */
export const ShellCallInputSchema = {
  anyOf: [ShellRunOpInputSchema, ShellShellOpInputSchema, ShellRpcOpInputSchema],
} as unknown as JSONSchemaType<ShellCallInput>

// ---------------------------------------------------------------------------
// The result envelope
// ---------------------------------------------------------------------------

/** The success payload — rides `result` on the ok branch. */
export type ShellSuccess = {
  /** Exit code, or `null` when the process was killed by a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. `SIGTERM`), or `null` on a normal exit. */
  signal: string | null
  /** Captured lines when `format` is `paged`. */
  lines?: string[]
  /** Stdout lines emitted, including those outside the window — the paging denominator. */
  totalLines: number
  /** Whether stdout has more lines beyond `offset + limit`. */
  hasMore: boolean
  /** Parsed stdout when `format` is `json`. */
  jsonData?: unknown
  /** Bounded stdout when `format` is `raw`. */
  stdout?: string
  /** Bounded, ANSI-stripped stderr. */
  stderr: string
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number
  /** Over-ceiling options that were clamped, as `'<knob> <given> -> <applied>'`. */
  clamped?: string[]
}

/**
 * The failure payload — rides `error` on the not-ok branch. `code` carries
 * the terminal status verbatim (`timeout` | `line_quota` | `canceled` | `error`);
 * the diagnostics ride alongside.
 */
export type ShellError = {
  code: ShellStatus
  /** Failure detail (json_parse_failed snippets, invalid-input AJV text…). */
  message?: string
  exitCode: number | null
  signal: string | null
  /** Partial captured lines when `format` is `paged` (what the stop produced). */
  lines?: string[]
  totalLines: number
  hasMore: boolean
  stderr: string
  durationMs: number
  clamped?: string[]
}

// ---------------------------------------------------------------------------
// The `rpc` op's result envelope — transport outcomes, not process outcomes
// ---------------------------------------------------------------------------

/** Terminal status of one rpc op — process-op statuses do not apply (no pid). */
export type RpcStatus = 'canceled' | 'timeout' | 'error' | 'credential_required'

/** The rpc success payload — the remote call's decoded `result` rides `output`. */
export type RpcOpSuccess = {
  output: JsonObject
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number
  /** Over-ceiling options that were clamped, as `'<knob> <given> -> <applied>'`. */
  clamped?: string[]
}

/**
 * The rpc failure payload. `code` is the op's terminal status; a remote
 * failure's own discriminant (HTTP status, JSON-RPC error code) rides
 * `remoteCode` so retry policy can treat 5xx/timeouts differently from 4xx.
 * `retryable` is that policy computed ONCE here — network failure, timeout,
 * or `remoteCode >= 500` — so thread listeners divide on the schema field,
 * never a jq numeric check.
 */
export type RpcOpError = {
  code: RpcStatus
  /** Failure detail — the HTTP reason, JSON-RPC error message, or abort text. */
  message?: string
  /** The remote failure's own code, when the call completed with an error response. */
  remoteCode?: number | string
  /** Whether retry policy applies: network failure, timeout, or a remote 5xx. */
  retryable: boolean
  durationMs: number
  clamped?: string[]
  /**
   * The originating request, echoed only on `credential_required` — the
   * vend-and-replay capture payload (the thread's join via `ctx.echo`).
   */
  request?: { op: 'rpc'; input: ShellRpcOpInput }
}

/** Every op runner's interior — one `code`-discriminated error branch over two payload families. */
export type ShellOpResult = ShellSuccess | ShellError | RpcOpSuccess | RpcOpError
