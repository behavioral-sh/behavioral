/**
 * The plugin-threads proposal path — the ICL threads turning a proposal
 * (plugin, file) into a live thread candidate. Discovery is names-only
 * forever (`sh.behavioral/threads/` filenames in the manifest scan);
 * admission is the trust gate, and this is its machinery:
 *
 * - **import-issue** — a `plugin_threads_proposal` (host ingress: the
 *   explicit proposal act) issues the bun-direct import script through the
 *   shell faculty's `run` op, the plugin root + file riding env. The
 *   script's top-level `await import(...)` executes the plugin file's top
 *   level IN THE WORKER subprocess — the only code-execution moment, once
 *   per content version (slice 3's registry never re-imports an unchanged
 *   admission).
 * - **import-join** — the correlated `shell_request_result` (the `ctx.echo`
 *   join lane, the credential-seam / remote-mcp pattern) maps validated
 *   threads to `plugin_threads_imported`, failures to the typed
 *   `plugin_threads_failed` — errors as data, never a crash.
 * - **candidate-issue / pending-issue** — the imported batch peels one
 *   `plugin_threads_candidate` per thread (the carry recursion: pure-data
 *   threads cannot loop, so the queue rides the events).
 * - **candidate-dispatch** — each candidate issues the `frontier_request
 *   { op: 'add_thread' }` proposal, the thread stamped with the proposal's
 *   target space (absent = root — Root/D; the admission's stamp governs the
 *   mount, never the author's). From here the landed admission path owns
 *   everything: the structural review (livelock detection is part of adding
 *   threads), the judged admission when systemOne is wired, the write.
 *
 * The import script validates EVERY export against the engine's
 * `ThreadSchema` — imported from the engine schema home (the same module
 * the composition itself trusts), never hand-mirrored. An invalid export
 * is skipped with a warning; an unparseable file surfaces the typed error.
 *
 * Requires the shell faculty (its `run` op) — bProgram mounts it when
 * shell is on. The label `plugin-threads` stamps the proposal-lane ops
 * (trace annotation, no routing weight — the REMOTE_MCP_LABEL convention).
 *
 * @packageDocumentation
 */

import type { Thread } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types: the proposal is host ingress; imported/candidate/failed surface; pending is the carry. */
export const PLUGIN_THREADS_EVENT_TYPES = {
  proposal: 'plugin_threads_proposal',
  imported: 'plugin_threads_imported',
  candidate: 'plugin_threads_candidate',
  pending: 'plugin_threads_pending',
  failed: 'plugin_threads_failed',
  /** The registry's skip surface — a decided (plugin, file, hash, space) key never re-adjudicates; the composition emits this. */
  skipped: 'plugin_threads_skipped',
} as const

/** The reverse-domain namespace dir holding behavioral-specific plugin threads (agent-plugins §8.2). */
export const PLUGIN_THREADS_DIR = 'sh.behavioral/threads'

/** The label every op these threads issue carries (trace annotation, no routing weight). */
export const PLUGIN_THREADS_LABEL = 'plugin-threads'

/** The env keys the import script reads: the plugin root and the file under the namespace dir. */
const PLUGIN_ROOT_ENV = 'PLUGIN_THREADS_ROOT'
const PLUGIN_FILE_ENV = 'PLUGIN_THREADS_FILE'

/**
 * The engine schema home, resolved absolutely so the worker's `bun run -`
 * child (whatever its cwd) imports the SAME module the composition trusts —
 * `ajv` + `ThreadSchema` from one home, never hand-mirrored.
 */
const ENGINE_SCHEMA_HOME = new URL('../../behavioral/behavioral.types.ts', import.meta.url).href

// ── The import script (bun-direct, executed in the worker) ──────────────────

/**
 * The plugin-thread import recipe — executed bun-direct by the shell
 * worker's `run` op (script on stdin), the target riding env.
 *
 * Imports the plugin file (plugin-root-relative, under the namespace dir),
 * validates EVERY export against the engine `ThreadSchema`, and prints one
 * JSON object on stdout: `{ threads, warnings, hash }` — the validated
 * threads, per-export skip warnings, and the file content hash (the
 * admission registry's re-arm key). An unparseable file prints
 * `{ ok: false, error: { code, message } }` — errors as data, never a crash.
 */
export const PLUGIN_THREAD_IMPORT_SCRIPT = `
import { CryptoHasher } from 'bun'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const { ajv, ThreadSchema } = await import(${JSON.stringify(ENGINE_SCHEMA_HOME)})

const root = process.env.${PLUGIN_ROOT_ENV}
const file = process.env.${PLUGIN_FILE_ENV}
const msg = (err) => (err instanceof Error ? err.message : String(err))

if (root === undefined || file === undefined) {
  console.log(JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'missing plugin root or file' } }))
  process.exit(0)
}

const target = path.resolve(root, ${JSON.stringify(PLUGIN_THREADS_DIR)}, file)

let source
try {
  source = await Bun.file(target).text()
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: { code: 'read_failed', message: msg(err) } }))
  process.exit(0)
}

const hash = new CryptoHasher('sha256').update(source).digest('hex')

let mod
try {
  mod = await import(pathToFileURL(target).href)
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: { code: 'import_failed', message: msg(err) } }))
  process.exit(0)
}

const validate = ajv.compile(ThreadSchema)
const threads = []
const warnings = []
for (const name of Object.keys(mod)) {
  const value = mod[name]
  if (validate(value)) {
    threads.push(value)
  } else {
    warnings.push('Skipped export "' + name + '": ' + ajv.errorsText(validate.errors))
  }
}
console.log(JSON.stringify({ threads, warnings, hash }))
`

// ── Trusted shapes (the thread gates) ───────────────────────────────────────

/**
 * The proposal's shape — the ingress gate. `plugin` is the plugin root
 * path, `file` the filename under the namespace dir, `space` the optional
 * mount target (absent = root — Root/D).
 */
export const PLUGIN_THREADS_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    input: {
      type: 'object',
      properties: {
        plugin: { type: 'string', minLength: 1 },
        file: { type: 'string', minLength: 1 },
        space: { type: 'string', minLength: 1 },
      },
      required: ['plugin', 'file'],
      additionalProperties: false,
    },
  },
  required: ['id', 'input'],
  additionalProperties: false,
} as const

// ── Threads ──────────────────────────────────────────────────────────────────

/** import-issue — a proposal issues the worker import through the run op; the target rides env, the join lane rides ctx.echo. */
const importIssue: Thread = {
  label: 'plugin-threads/import-issue',
  rules: [
    {
      transform: [
        {
          type: PLUGIN_THREADS_EVENT_TYPES.proposal,
          query: `. as $d | { id: ($d.id + "-import"), label: "${PLUGIN_THREADS_LABEL}", ctx: { echo: ({ source: $d.id, plugin: $d.input.plugin, file: $d.input.file } + (if $d.input.space != null then { space: $d.input.space } else {} end)) }, input: { op: "run", script: ${JSON.stringify(PLUGIN_THREAD_IMPORT_SCRIPT)}, format: "json", env: { ${PLUGIN_ROOT_ENV}: $d.input.plugin, ${PLUGIN_FILE_ENV}: $d.input.file } } }`,
          target: FACULTY_MESSAGE_KINDS.shell_request,
          detailSchema: PLUGIN_THREADS_PROPOSAL_SCHEMA,
        },
      ],
    },
  ],
}

// ── The result gates — the join trusts only the shapes it acts on ────────────

/** The ctx echo lane — the join's correlation key (source) plus the registry's target. */
const IMPORT_ECHO_SCHEMA = {
  type: 'object',
  required: ['echo'],
  properties: {
    echo: {
      type: 'object',
      required: ['source', 'plugin', 'file'],
      properties: {
        source: { type: 'string', minLength: 1 },
        plugin: { type: 'string', minLength: 1 },
        file: { type: 'string', minLength: 1 },
        space: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
} as const

/** A successful import — validated threads + the content hash (the registry's re-arm key). */
const IMPORT_SUCCESS_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: {
        jsonData: {
          type: 'object',
          properties: {
            threads: { type: 'array', items: { type: 'object' } },
            hash: { type: 'string', minLength: 1 },
          },
          required: ['threads', 'hash'],
          additionalProperties: true,
        },
      },
      required: ['jsonData'],
      additionalProperties: true,
    },
    ctx: IMPORT_ECHO_SCHEMA,
  },
  required: ['id', 'ok', 'result', 'ctx'],
  additionalProperties: true,
} as const

/** A failed import — a shell-level failure (ok false + error) or the script's typed error (jsonData). */
const IMPORT_FAILURE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ctx: IMPORT_ECHO_SCHEMA,
  },
  required: ['id', 'ctx'],
  anyOf: [
    {
      type: 'object',
      properties: { ok: { type: 'boolean', const: false }, error: { type: 'object' } },
      required: ['ok', 'error'],
    },
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        result: {
          type: 'object',
          properties: {
            jsonData: {
              type: 'object',
              properties: { ok: { type: 'boolean', const: false }, error: { type: 'object' } },
              required: ['ok', 'error'],
            },
          },
          required: ['jsonData'],
        },
      },
      required: ['ok', 'result'],
    },
  ],
} as const

/** The imported batch's shape — the candidate listeners' gate. */
const IMPORTED_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    input: {
      type: 'object',
      properties: {
        plugin: { type: 'string', minLength: 1 },
        file: { type: 'string', minLength: 1 },
        hash: { type: 'string', minLength: 1 },
        threads: { type: 'array', items: { type: 'object' } },
        warnings: { type: 'array', items: { type: 'string' } },
        space: { type: 'string', minLength: 1 },
      },
      required: ['plugin', 'file', 'hash', 'threads'],
      additionalProperties: false,
    },
  },
  required: ['id', 'input'],
  additionalProperties: false,
} as const

/** The carry's shape — the pending listeners' gate (the queue rides the events; threads cannot loop). */
const PENDING_SCHEMA = {
  ...IMPORTED_SCHEMA,
  properties: {
    ...IMPORTED_SCHEMA.properties,
    input: {
      ...IMPORTED_SCHEMA.properties.input,
      properties: {
        ...IMPORTED_SCHEMA.properties.input.properties,
        next: { type: 'integer', minimum: 1 },
      },
      required: [...IMPORTED_SCHEMA.properties.input.required, 'next'],
    },
  },
} as const

/** A candidate's shape — the dispatch's gate (one thread, keyed by its add_thread id). */
const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    input: {
      type: 'object',
      properties: {
        thread: { type: 'object' },
        plugin: { type: 'string', minLength: 1 },
        file: { type: 'string', minLength: 1 },
        hash: { type: 'string', minLength: 1 },
        space: { type: 'string', minLength: 1 },
      },
      required: ['thread', 'plugin', 'file', 'hash'],
      additionalProperties: false,
    },
  },
  required: ['id', 'input'],
  additionalProperties: false,
} as const

// ── The join and the candidate recursion ───────────────────────────────────

/** import-join — the correlated result maps to the imported batch or the typed failure (both listeners act only on their own shape). */
const importJoin: Thread = {
  label: 'plugin-threads/import-join',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | { id: $d.ctx.echo.source, input: ({ plugin: $d.ctx.echo.plugin, file: $d.ctx.echo.file, hash: $d.result.jsonData.hash, threads: $d.result.jsonData.threads, warnings: ($d.result.jsonData.warnings // []) } + (if $d.ctx.echo.space != null then { space: $d.ctx.echo.space } else {} end)) }',
          target: PLUGIN_THREADS_EVENT_TYPES.imported,
          detailSchema: IMPORT_SUCCESS_SCHEMA,
        },
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | ($d.error // $d.result.jsonData.error // {}) as $e | { id: $d.ctx.echo.source, input: { plugin: $d.ctx.echo.plugin, file: $d.ctx.echo.file, error: { code: ($e.code // "error"), message: ($e.message // "unknown failure") } } }',
          target: PLUGIN_THREADS_EVENT_TYPES.failed,
          detailSchema: IMPORT_FAILURE_SCHEMA,
        },
      ],
    },
  ],
}

/** candidate-issue — the imported batch peels its first candidate and carries the rest. */
const candidateIssue: Thread = {
  label: 'plugin-threads/candidate-issue',
  rules: [
    {
      transform: [
        {
          type: PLUGIN_THREADS_EVENT_TYPES.imported,
          query:
            '. as $d | select($d.input.threads[0] != null) | { id: ($d.id + "-add-0"), input: ({ thread: $d.input.threads[0], plugin: $d.input.plugin, file: $d.input.file, hash: $d.input.hash } + (if $d.input.space != null then { space: $d.input.space } else {} end)) }',
          target: PLUGIN_THREADS_EVENT_TYPES.candidate,
          detailSchema: IMPORTED_SCHEMA,
        },
        {
          type: PLUGIN_THREADS_EVENT_TYPES.imported,
          query:
            '. as $d | select(($d.input.threads[1:] | length) > 0) | { id: $d.id, input: ({ plugin: $d.input.plugin, file: $d.input.file, hash: $d.input.hash, threads: $d.input.threads[1:], next: 1 } + (if $d.input.space != null then { space: $d.input.space } else {} end)) }',
          target: PLUGIN_THREADS_EVENT_TYPES.pending,
          detailSchema: IMPORTED_SCHEMA,
        },
      ],
    },
  ],
}

/** pending-issue — the carry peels the next candidate until the queue empties. */
const pendingIssue: Thread = {
  label: 'plugin-threads/pending-issue',
  rules: [
    {
      transform: [
        {
          type: PLUGIN_THREADS_EVENT_TYPES.pending,
          query:
            '. as $d | select($d.input.threads[0] != null) | { id: ($d.id + "-add-" + ($d.input.next | tostring)), input: ({ thread: $d.input.threads[0], plugin: $d.input.plugin, file: $d.input.file, hash: $d.input.hash } + (if $d.input.space != null then { space: $d.input.space } else {} end)) }',
          target: PLUGIN_THREADS_EVENT_TYPES.candidate,
          detailSchema: PENDING_SCHEMA,
        },
        {
          type: PLUGIN_THREADS_EVENT_TYPES.pending,
          query:
            '. as $d | select(($d.input.threads[1:] | length) > 0) | { id: $d.id, input: ({ plugin: $d.input.plugin, file: $d.input.file, hash: $d.input.hash, threads: $d.input.threads[1:], next: ($d.input.next + 1) } + (if $d.input.space != null then { space: $d.input.space } else {} end)) }',
          target: PLUGIN_THREADS_EVENT_TYPES.pending,
          detailSchema: PENDING_SCHEMA,
        },
      ],
    },
  ],
}

/** candidate-dispatch — one add_thread frontier proposal per candidate; the admission's space stamp governs the mount, never the author's. */
const candidateDispatch: Thread = {
  label: 'plugin-threads/candidate-dispatch',
  rules: [
    {
      transform: [
        {
          type: PLUGIN_THREADS_EVENT_TYPES.candidate,
          query:
            '. as $d | { id: $d.id, op: "add_thread", input: { thread: (($d.input.thread | del(.space)) + (if $d.input.space != null then { space: $d.input.space } else {} end)) } }',
          target: FACULTY_MESSAGE_KINDS.frontier_request,
          detailSchema: CANDIDATE_SCHEMA,
        },
      ],
    },
  ],
}

/** The plugin-threads proposal threads — mounted by the composition when the shell faculty is on. */
export const pluginThreadsThreads: Thread[] = [importIssue, importJoin, candidateIssue, pendingIssue, candidateDispatch]
