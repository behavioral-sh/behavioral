/**
 * Shell worker — executes one op per `shell_request` event and returns a
 * single bounded terminal `shell_request_result` event.
 *
 * @remarks
 * Spawned by URL (never imported) and speaks the behavioral event wire:
 * `shell_request` / `shell_cancel` in, `shell_request_result` out, with any
 * request `space` echoed on the result. `detail.input` is validated against
 * the op-discriminated boundary (`shell/types.ts`) — `'run'` = a TypeScript
 * script executed bun-direct (`bun run -`, script on stdin), `'shell'` = a
 * Bun Shell command string through the constant wrapper below.
 *
 * THE EXECUTOR IS BUN EVERYWHERE (the bun-direct conversion, verified
 * empirically 2026-09-21): no bash, no POSIX shell dependency, and the
 * PowerShell/Windows interpreter question dissolves — Bun Shell is
 * cross-platform and bash-like. The `run` op spawns
 * `Bun.spawn(['bun', 'run', '-'])` with the script written to stdin. The
 * `shell` op spawns the same bun entry with the wrapper on stdin; the
 * command rides env (`EXEC_CMD`), the payload rides env (`EXEC_STDIN`) or,
 * over the large-payload threshold (env vars are size-limited per platform),
 * a temp file (`EXEC_CMD_PATH` / `EXEC_STDIN_PATH` + `Bun.file` redirect —
 * the documented-parts recipe: `os.tmpdir()` + `Bun.write()` +
 * `file.delete()`). Payload temp files are deleted in the after-path on
 * EVERY exit — completion and kill alike (`finally` runs in both); the
 * deletes are best-effort `allSettled`, the tmpdir the last resort, never
 * the plan.
 *
 * Containment is the worker's own deadline + group-kill (Bun Shell promises
 * expose no `.timeout()` on 1.3.14, and the group kill is strictly stronger
 * — it reaps trees, not just processes): `detached` makes the bun process a
 * group leader, Bun Shell's children (and the run op's spawned children)
 * join the group, and `kill(-pid, SIGTERM → SIGKILL)` reaps the whole tree —
 * verified to survive the wrapper unchanged. Streamed lines are counted for
 * quotas but not posted: no consumer exists (MINIMAL: router-published
 * delta trace when one does).
 *
 * MINIMAL: control characters beyond ANSI (C0, interlinear annotations) are
 * not sanitized; JSON escaping keeps them harmless in model context.
 *
 * @packageDocumentation
 */

import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ValidateFunction } from 'ajv'
import type { JsonObject } from '../behavioral/behavioral.types.ts'
import { ajv } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import {
  type ShellRequestEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
} from '../faculties/faculties.types.ts'
import { emit, wireInbound } from '../faculties/process-lane.ts'
import {
  type RpcOpError,
  type RpcOpSuccess,
  type ShellCallInput,
  ShellCallInputSchema,
  type ShellError,
  type ShellOpResult,
  type ShellOptions,
  type ShellRpcOpInput,
  type ShellStatus,
  type ShellSuccess,
} from '../faculties/shell/types.ts'
import { send as sendRpc } from './rpc.client.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lines captured into a `paged` result. */
const DEFAULT_LIMIT = 50

/** Default lines skipped before capturing. */
const DEFAULT_OFFSET = 0

/** Default character bound for `raw`, `json`, and `stderr` output. */
const DEFAULT_MAX_CHARACTERS = 8_000

/** Grace between the SIGTERM and SIGKILL halves of a group kill. */
const KILL_GRACE_MS = 500

/** Default wall-clock deadline for one execution. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default stdout+stderr lines allowed before a group kill. */
const DEFAULT_MAX_LINES = 250

/** The bun entry every execution rides — no shell, no bash, just bun. */
const BUN_STDIN_ENTRY = ['bun', 'run', '-'] as const

/**
 * Payload size (characters) over which a command or stdin rides a temp file
 * instead of env — env vars are size-limited per platform (~256KB on macOS).
 */
const LARGE_PAYLOAD_BYTES = 100_000

/**
 * The constant wrapper for the `'shell'` op — the only script besides the
 * caller's that ever rides an execution's stdin.
 *
 * The command arrives via env (small) or a temp file (large); the payload
 * likewise. `.nothrow()` keeps the real exit code (the naive `await $`
 * throws `ShellError`, swallowing both streams and the code);
 * `process.exit(result.exitCode)` propagates it. A stdin redirect is added
 * ONLY when a payload exists — a command carrying its own `<` redirect must
 * not collide with ours.
 */
const SHELL_OP_WRAPPER = `import { $ } from 'bun'
const cmd = Bun.env.EXEC_CMD_PATH !== undefined
  ? await Bun.file(Bun.env.EXEC_CMD_PATH).text()
  : (Bun.env.EXEC_CMD ?? '')
const stdinPath = Bun.env.EXEC_STDIN_PATH
const stdinData = Bun.env.EXEC_STDIN
const result = stdinPath !== undefined
  ? await $\`\${{ raw: cmd }} < \${Bun.file(stdinPath)}\`.nothrow()
  : stdinData !== undefined && stdinData !== ''
    ? await $\`\${{ raw: cmd }} < \${new Response(stdinData)}\`.nothrow()
    : await $\`\${{ raw: cmd }}\`.nothrow()
process.exit(result.exitCode)
`

// ---------------------------------------------------------------------------
// Input boundary
// ---------------------------------------------------------------------------

const validateShellCallInput = ajv.compile(ShellCallInputSchema)

/** Hard bounds a caller cannot exceed — clamping lives with enforcement. */
const CEILINGS = { timeoutMs: 120_000, maxLines: 5_000, maxCharacters: 200_000, limit: 1_000 } as const

const CLAMPED_KEYS = ['timeoutMs', 'maxLines', 'maxCharacters', 'limit'] as const

/** Clamp over-ceiling bounds, recording every adjustment as `'<key> <given> -> <applied>'`. */
const clampOptions = (input: ShellCallInput): { options: ShellOptions; clamped: string[] } => {
  const clamped: string[] = []
  const options: ShellOptions = {
    // `in` narrowing: the knob fields exist per op branch (the rpc op carries
    // only `timeoutMs`), so each read is guarded by its own presence check.
    ...('format' in input && input.format !== undefined ? { format: input.format } : {}),
    ...('offset' in input && input.offset !== undefined ? { offset: input.offset } : {}),
    ...('limit' in input && input.limit !== undefined ? { limit: input.limit } : {}),
    ...('timeoutMs' in input && input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...('maxLines' in input && input.maxLines !== undefined ? { maxLines: input.maxLines } : {}),
    ...('maxCharacters' in input && input.maxCharacters !== undefined ? { maxCharacters: input.maxCharacters } : {}),
    ...('cwd' in input && input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...('env' in input && input.env !== undefined ? { env: input.env } : {}),
    // The stdin field exists only on the 'shell' branch; the worker channels it.
    ...(input.op === 'shell' && input.stdin !== undefined ? { stdin: input.stdin } : {}),
  }
  for (const key of CLAMPED_KEYS) {
    const given = options[key]
    if (given !== undefined && given > CEILINGS[key]) {
      clamped.push(`${key} ${given} -> ${CEILINGS[key]}`)
      // CLAMPED_KEYS are all numeric ShellOptions fields.
      ;(options as Record<string, number>)[key] = CEILINGS[key]
    }
  }
  return { options, clamped }
}

// ---------------------------------------------------------------------------
// Payload channeling — env for small text, temp file for large
// ---------------------------------------------------------------------------

/** A payload temp file path (OS tmpdir, UUID-named, worker-owned lifetime). */
const payloadTempPath = (): string => path.join(tmpdir(), `shell-payload-${crypto.randomUUID()}.txt`)

/** Channel one payload field: env when small, temp file when large. */
const channelPayload = async ({
  text,
  envKey,
  pathKey,
  env,
  tempFiles,
}: {
  text: string
  envKey: string
  pathKey: string
  env: Record<string, string>
  tempFiles: string[]
}): Promise<void> => {
  if (text.length > LARGE_PAYLOAD_BYTES) {
    const file = payloadTempPath()
    await Bun.write(file, text)
    tempFiles.push(file)
    env[pathKey] = file
  } else {
    env[envKey] = text
  }
}

// ---------------------------------------------------------------------------
// Credential seam — the declarative auth gate (the threads vends)
// ---------------------------------------------------------------------------

/**
 * The rpc op's credential gate: `auth: true` without a token short-circuits
 * as typed `credential_required` — the op never calls the remote
 * unauthenticated, and the vended token reaches it only through the
 * replaying thread (`authToken` on the replayed input). The op itself never
 * knows OAuth — the cross-faculty round-trip is the threads'
 * (`shell/rpc-auth.threads.ts`), not this module's.
 */
const needsCredential = (input: ShellRpcOpInput): boolean => input.auth === true && input.authToken === undefined

// ---------------------------------------------------------------------------
// In-flight execution — enough state to stop it by correlation id
// ---------------------------------------------------------------------------

type StopReason = 'canceled' | 'timeout' | 'line_quota' | 'byte_quota'

type Execution =
  | { kind: 'process'; pid: number; stopReason: StopReason | null }
  | { kind: 'rpc'; controller: AbortController; stopReason: StopReason | null }

/** Executions currently running, keyed by correlation id. */
const active = new Map<string, Execution>()

/**
 * Signal an execution's whole process group, escalating to SIGKILL.
 *
 * @remarks
 * `Bun.spawn`'s `AbortSignal` and native `timeout` kill only the leader: a
 * bun entry that forks (the shell op's children, a run script's own spawns)
 * leaves grandchildren orphaned and reparented to init. Signals must target
 * `-pid` (the group created by `detached: true`), and SIGTERM alone can be
 * trapped or ignored, hence the SIGKILL escalation. Verified to survive the
 * Bun Shell wrapper: wrapper children join the group.
 */
const killGroup = ({ pid }: { pid: number }): void => {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Already exited.
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone — the common case.
    }
  }, KILL_GRACE_MS)
}

/** Stop one execution: signal a process group, or abort an rpc fetch. First writer wins. */
const stopExecution = ({ execution, reason }: { execution: Execution; reason: StopReason }): void => {
  if (execution.stopReason !== null) return
  execution.stopReason = reason
  if (execution.kind === 'process') killGroup({ pid: execution.pid })
  else execution.controller.abort()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a decoded chunk into complete lines, returning the unterminated tail. */
const takeLines = ({ chunk, carry }: { chunk: string; carry: string }): { lines: string[]; carry: string } => {
  const parts = `${carry}${chunk}`.split('\n')
  const nextCarry = parts.pop() ?? ''
  return { lines: parts, carry: nextCarry }
}

/**
 * Read one process stream to EOF, invoking `onLine` per complete line.
 *
 * @remarks
 * Both streams are pumped concurrently: an unread pipe fills at ~64KB and
 * blocks the child, so a command that writes heavily to stderr would
 * deadlock if stderr were drained only after stdout. `flushLimit` bounds a
 * line that never ends.
 */
const pumpLines = async ({
  stream,
  onLine,
  flushLimit,
}: {
  stream: ReadableStream<Uint8Array>
  onLine: (line: string) => void
  flushLimit: number
}): Promise<void> => {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let carry = ''
  const emit = (segment: string): void => {
    let rest = segment
    while (rest.length > flushLimit) {
      onLine(rest.slice(0, flushLimit))
      rest = rest.slice(flushLimit)
    }
    if (rest !== '') onLine(rest)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const split = takeLines({ chunk: decoder.decode(value, { stream: true }), carry })
    carry = split.carry
    for (const line of split.lines) emit(line)
    while (carry.length >= flushLimit) {
      emit(carry.slice(0, flushLimit))
      carry = carry.slice(flushLimit)
    }
  }
  if (carry !== '') emit(carry)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Characters of stdout echoed into a JSON parse-failure message. */
const JSON_SNIPPET_CHARS = 200

/**
 * Run the `rpc` op — one generic remote JSON-RPC call, abortable by cancel
 * or deadline through the fetch signal. The op is transport-shaped: it
 * carries the envelope, nothing more (MCP semantics live in threads).
 *
 * @remarks
 * Errors-as-data at both layers: the client never throws on transport or
 * protocol failures, and a remote error payload surfaces as `code: 'error'
 * + remoteCode` (the remote failure's own discriminant, for retry policy).
 * A stop (cancel/timeout) wins over the outcome: the abort rejection is
 * mapped to the stop's status, not mislabeled `error`.
 */
const runRpcOp = async ({
  id,
  input,
  options,
}: {
  id: string
  input: ShellRpcOpInput
  options: ShellOptions
}): Promise<RpcOpSuccess | RpcOpError> => {
  const started = performance.now()
  // The declarative auth gate: no vended token, no call — the typed
  // credential_required result is the threads' capture payload.
  if (needsCredential(input)) {
    return {
      code: 'credential_required',
      durationMs: 0,
      retryable: false,
      message: `credential required for ${input.url}`,
      request: { op: 'rpc', input },
    }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const execution: Execution = { kind: 'rpc', controller, stopReason: null }
  active.set(id, execution)
  const deadline = setTimeout(() => stopExecution({ execution, reason: 'timeout' }), timeoutMs)
  try {
    const outcome = await sendRpc({
      url: input.url,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
      // The replayed token rides the input (thread-injected); the op itself
      // never knows OAuth.
      getAuthToken: async () => input.authToken,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      signal: controller.signal,
    })
    const durationMs = Math.round(performance.now() - started)
    // First stop wins over the decoded outcome — the abort rejection is not
    // mislabeled a remote error.
    if (execution.stopReason === 'canceled') return { code: 'canceled', durationMs, retryable: false }
    if (execution.stopReason === 'timeout') return { code: 'timeout', durationMs, retryable: true }
    if (outcome.ok) return { output: outcome.result, durationMs }
    // The reactive auth path: a 401 challenge on an unauthenticated call maps
    // to the typed vend-and-replay capture payload (the threads vends and
    // replays). A 401 on a token'd call stays a remote error — bounded.
    if (outcome.error.code === 401 && input.authToken === undefined) {
      return {
        code: 'credential_required',
        durationMs,
        retryable: false,
        message: `credential required for ${input.url}`,
        request: { op: 'rpc', input },
      }
    }
    return {
      code: 'error',
      durationMs,
      message: outcome.error.message,
      remoteCode: outcome.error.code,
      // The retry-vs-surface discriminant, computed once where the numeric
      // comparison lives: network failure or a remote 5xx is retryable; a
      // 4xx, a JSON-RPC error code, and a malformed response are not.
      retryable:
        outcome.error.code === 'network' || (typeof outcome.error.code === 'number' && outcome.error.code >= 500),
    }
  } finally {
    clearTimeout(deadline)
    active.delete(id)
  }
}

/**
 * Run one op and return its bounded result.
 *
 * @remarks
 * Everything captured is bounded by construction: the paged window by
 * `offset`/`limit`, `raw`/`stderr` by tail-truncation, `json` by the byte
 * quota's group kill, and the whole run by `maxLines` and the deadline.
 * The payload temp files are deleted in the `finally` — the after-path runs
 * on completion AND on every kill.
 */
const runOp = async ({
  id,
  input,
  options,
}: {
  id: string
  input: ShellCallInput
  options: ShellOptions
}): Promise<ShellOpResult> => {
  if (input.op === 'rpc') return runRpcOp({ id, input, options })
  const started = performance.now()
  const format = options.format ?? 'paged'
  const offset = options.offset ?? DEFAULT_OFFSET
  const limit = options.limit ?? DEFAULT_LIMIT
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES

  // The shell op's payload channeling: env for small, temp file for large.
  const tempFiles: string[] = []
  let extraEnv: Record<string, string> | undefined
  if (input.op === 'shell') {
    extraEnv = {}
    await channelPayload({
      text: input.command,
      envKey: 'EXEC_CMD',
      pathKey: 'EXEC_CMD_PATH',
      env: extraEnv,
      tempFiles,
    })
    if (input.stdin !== undefined) {
      await channelPayload({
        text: input.stdin,
        envKey: 'EXEC_STDIN',
        pathKey: 'EXEC_STDIN_PATH',
        env: extraEnv,
        tempFiles,
      })
    }
  }

  const proc = Bun.spawn([...BUN_STDIN_ENTRY], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...(options.env ?? {}), ...(extraEnv ?? {}) },
    // Always piped: an unread stdin would hang any command that reads it;
    // the script (run op) or the wrapper (shell op) IS the stdin payload.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })

  // The run op's script IS the stdin; the shell op's wrapper is. Either way
  // one write, one end — bun reads its source from stdin.
  proc.stdin.write(input.op === 'run' ? input.script : SHELL_OP_WRAPPER)
  proc.stdin.end()

  const execution: Execution = { kind: 'process', pid: proc.pid, stopReason: null }
  active.set(id, execution)
  const deadline = setTimeout(() => stopExecution({ execution, reason: 'timeout' }), timeoutMs)

  try {
    const pagedLines: string[] = []
    const jsonLines: string[] = []
    let sequence = 0
    let stdoutSeen = 0
    let jsonChars = 0
    let rawTail = ''
    let rawChars = 0
    let rawDropped = 0
    let rawTruncated = false
    let stderrTail = ''
    let stderrChars = 0
    let stderrDropped = 0
    let stderrTruncated = false

    /** Enforce the hard line bound — the line that trips the cap is still captured, then the group dies. */
    const enforceLineCap = (): void => {
      if (sequence >= maxLines) stopExecution({ execution, reason: 'line_quota' })
    }

    const onStdoutLine = (raw: string): void => {
      if (execution.stopReason !== null) return
      const clean = Bun.stripANSI(raw)
      sequence += 1
      stdoutSeen += 1
      if (format === 'paged') {
        if (stdoutSeen > offset && pagedLines.length < limit) pagedLines.push(clean)
      } else if (format === 'json') {
        jsonLines.push(clean)
        jsonChars += clean.length + 1
        // A JSON blob over the character bound would flood the model's context
        // wholesale — the group dies rather than the parse.
        if (jsonChars > maxCharacters) stopExecution({ execution, reason: 'byte_quota' })
      } else {
        // Tail-biased: errors surface at the end of output, so the dropped
        // head is the least useful part.
        const next = rawTail === '' ? clean : `${rawTail}\n${clean}`
        rawChars += next.length - rawTail.length
        rawTail = next
        if (rawTail.length > maxCharacters) {
          rawTruncated = true
          rawTail = rawTail.slice(-maxCharacters)
          rawDropped = rawChars - rawTail.length
        }
      }
      enforceLineCap()
    }

    const onStderrLine = (raw: string): void => {
      if (execution.stopReason !== null) return
      const clean = Bun.stripANSI(raw)
      sequence += 1
      const next = stderrTail === '' ? clean : `${stderrTail}\n${clean}`
      stderrChars += next.length - stderrTail.length
      stderrTail = next
      if (stderrTail.length > maxCharacters) {
        stderrTruncated = true
        stderrTail = stderrTail.slice(-maxCharacters)
        stderrDropped = stderrChars - stderrTail.length
      }
      enforceLineCap()
    }

    await Promise.all([
      pumpLines({ stream: proc.stdout, onLine: onStdoutLine, flushLimit: maxCharacters }),
      pumpLines({ stream: proc.stderr, onLine: onStderrLine, flushLimit: maxCharacters }),
    ])

    await proc.exited

    const stopped: ShellStatus =
      execution.stopReason === null
        ? 'completed'
        : execution.stopReason === 'byte_quota'
          ? 'error'
          : execution.stopReason
    const base = {
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      totalLines: stdoutSeen,
      stderr: stderrTruncated ? `${stderrTail}\n[...truncated: ${stderrDropped} chars dropped]` : stderrTail,
      durationMs: Math.round(performance.now() - started),
    }

    if (format === 'json') {
      if (execution.stopReason === 'byte_quota') {
        return {
          code: 'error',
          ...base,
          hasMore: false,
          message: `output_exceeds_max_characters: ${maxCharacters}`,
        }
      }
      // Any other stop (cancel, timeout, line cap) leaves a partial document —
      // report the stop, do not parse half a JSON blob.
      if (execution.stopReason !== null) return { code: stopped, ...base, hasMore: false }
      const text = jsonLines.join('\n')
      try {
        return { ...base, hasMore: false, jsonData: JSON.parse(text) }
      } catch {
        return {
          code: 'error',
          ...base,
          hasMore: false,
          message: `json_parse_failed: ${text.slice(0, JSON_SNIPPET_CHARS)}`,
        }
      }
    }

    if (format === 'raw') {
      const notice = rawTruncated
        ? `\n[...truncated: ${rawDropped} chars dropped — use format 'paged' with offset/limit to page]`
        : ''
      const rawPayload = { ...base, hasMore: rawTruncated, stdout: `${rawTail}${notice}` }
      if (stopped === 'completed') return rawPayload
      return { code: stopped, ...rawPayload }
    }

    const pagedPayload = {
      ...base,
      lines: pagedLines,
      hasMore: stdoutSeen > offset + limit,
    }
    if (stopped === 'completed') return pagedPayload
    return { code: stopped, ...pagedPayload }
  } finally {
    clearTimeout(deadline)
    active.delete(id)
    // The after-path: sensible deletion on EVERY exit — completion and kill
    // alike (the finally runs in both). Best-effort; the tmpdir is the last
    // resort, never the plan.
    if (tempFiles.length > 0) {
      await Promise.allSettled(tempFiles.map((file) => Bun.file(file).delete()))
    }
  }
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/**
 * Post the single terminal result event for an execution (the uniform
 * modified-B envelope: `ok` beside the correlation id; the success payload
 * rides `result`, the failure payload rides `error` with the terminal status
 * as `code`), echoing any request space.
 */
const postResult = ({
  id,
  payload,
  error,
  space,
  ctx,
}: {
  id: string
  payload?: ShellSuccess | RpcOpSuccess
  error?: ShellError | RpcOpError
  space?: string
  ctx?: JsonObject
}): void => {
  emit({
    type: FACULTY_MESSAGE_KINDS.shell_request_result,
    // The request's ctx echoes at detail level — the out-of-band join lane
    // (thread orchestration state round-trips beside ok, never model-facing).
    detail: (error === undefined
      ? { id, ok: true, result: (payload ?? {}) as unknown as JsonObject, ...(ctx === undefined ? {} : { ctx }) }
      : {
          id,
          ok: false,
          error: error as unknown as JsonObject,
          ...(ctx === undefined ? {} : { ctx }),
        }) as unknown as JsonObject & { id: string },
    ...(space === undefined ? {} : { space }),
  })
}

/** An error interior carrying no capture — the run never produced a process. */
const errorInterior = ({ message }: { message: string }): ShellError => ({
  code: 'error',
  exitCode: null,
  signal: null,
  totalLines: 0,
  hasMore: false,
  stderr: '',
  durationMs: 0,
  message,
})

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

/** Route one inbound event. */
const handleInbound = async (message: unknown): Promise<void> => {
  if (validateShellCancelEvent(message)) {
    const cancel = message as import('../faculties/faculties.types.ts').ShellCancelEvent
    const execution = active.get(cancel.detail.id)
    if (execution !== undefined) stopExecution({ execution, reason: 'canceled' })
    return
  }
  // Events failing the shared schema have no correlation id to report to and
  // are dropped — the router only forwards schema-valid events, so this is
  // defense in depth at the process boundary.
  if (!validateShellRequestEvent(message)) return
  const event = message as ShellRequestEvent
  const { id, input, ctx } = event.detail

  // Input that fails the boundary is error data, not a throw: the id is
  // valid, so the caller learns why nothing ran.
  const validate = validateShellCallInput as unknown as ValidateFunction<unknown>
  if (!validate(input)) {
    postResult({
      id,
      space: event.space,
      error: errorInterior({ message: `invalid input: ${ajv.errorsText(validate.errors)}` }),
      ctx,
    })
    return
  }
  // Cast: the op-input schema validated this JsonObject — trust it downstream.
  const opInput = input as ShellCallInput
  const { options, clamped } = clampOptions(opInput)
  // `runOp` never rejects on the host side: any worker-side throw (bad cwd,
  // a kill race) becomes `status: 'error'` data instead.
  try {
    const interior = await runOp({ id, input: opInput, options })
    // The clamp report rides whichever branch ran.
    const withClamp = clamped.length === 0 ? interior : { ...interior, clamped }
    if ('code' in interior) {
      postResult({ id, space: event.space, error: withClamp as ShellError, ctx })
    } else {
      postResult({ id, space: event.space, payload: withClamp as ShellSuccess, ctx })
    }
  } catch (err) {
    postResult({
      id,
      space: event.space,
      error: errorInterior({ message: err instanceof Error ? err.message : String(err) }),
      ctx,
    })
  }
}

// The wire is the behavioral event vocabulary, validated with the shared
// schemas — the trust boundary for anything crossing into this process.
if (import.meta.main) {
  // Standalone (spawned process) — wire the stdio line lane. An in-process
  // import (the composition's frontier embed) wires nothing: the host's
  // stdin is never touched.
  wireInbound((message) => handleInbound(message))
}
