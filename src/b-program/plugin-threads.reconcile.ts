/**
 * The plugin-threads boot reconciliation — core threads over existing
 * actuators (the design.md-scan precedent): a boot once-thread triggers the
 * reconciliation, the standing read-issue loop reads the store-resident
 * registry record, and per entry the shell `run` op stats + sha256s the
 * plugin file. All joins ride `ctx.echo` (threads are stateless). The two
 * verdict legs are EVENTS the composition's host leg consumes:
 *
 * - `plugin_threads_mount` (file unchanged, hash match) — the composition
 *   addThreads the snapshot, stamped exactly as admitted. NEVER re-imported:
 *   the unchanged-key verdict IS the cross-run admission skip.
 * - `plugin_threads_removed` (file missing) — the composition removeThreads
 *   the instance hash LIVE; the registry watcher marks the record `removed`.
 * - `plugin_threads_import_diff` (file changed, imported once) — the
 *   composition deepEqual-compares each fresh export against the stored
 *   snapshot: identical → the verdict CARRIES (the watcher writes the new
 *   record under the new file-hash key with `carriedFrom` provenance; an
 *   admitted carry also mounts) ; different → the full landed proposal path
 *   re-adjudicates. Import failures surface as the typed
 *   `plugin_threads_failed` — visible, never a crash.
 *
 * The queue is the carry recursion (the imported-batch peel pattern): pure
 * data cannot loop, so the per-entry walk rides the events. Unknown-version
 * entries (v !== 1) and already-`removed` entries are filtered in the read —
 * quarantined-as-data never reconciles. Rejected entries reconcile TOO: a
 * cosmetic rewrite carries the rejection forward (re-arming a rejection
 * requires a semantic change).
 *
 * Requires shell + store. The label `plugin-threads-reconcile` stamps the
 * ops (trace annotation, no routing weight).
 *
 * @packageDocumentation
 */

import { ajv, type Thread } from '../behavioral/behavioral.types.ts'
import {
  PLUGIN_THREAD_IMPORT_SCRIPT,
  PLUGIN_THREADS_DIR,
  PLUGIN_THREADS_EVENT_TYPES,
} from './plugin-threads.threads.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types: the reconciliation's verdict surfaces. */
export const RECONCILE_EVENT_TYPES = {
  /** The (re)trigger — the boot once-thread requests it; the reload ingress re-issues it. */
  reconcile: 'plugin_threads_reconcile',
  /** The reload ingress — the host-validated trigger that re-runs the reconciliation mid-run. */
  reload: 'plugin_threads_reload',
  /** The per-entry walk's carry event — the queue rides the events. */
  queue: 'plugin_threads_reconcile_queue',
  /** The stat verdict event — the join's single fan-out point (no empty-select noise). */
  stat: 'plugin_threads_reconcile_stat',
  /** File unchanged + admitted snapshot: the composition mounts the snapshot. */
  mount: 'plugin_threads_mount',
  /** File missing (or export retired): LIVE teardown + the record marked removed. */
  removed: 'plugin_threads_removed',
  /** File changed, imported once: the composition deepEqual-diffs exports vs snapshot. */
  importDiff: 'plugin_threads_import_diff',
  /** Verdict carried forward: the watcher writes the new record; an admitted carry also mounts. */
  carried: 'plugin_threads_carried',
} as const

/** The logical op label — the shell_request trace annotation. */
export const RECONCILE_LABEL = 'plugin-threads-reconcile'

/** The echo-step discriminators — the joins' trust gates. */
const STEP_READ = 'reconcile-read'
const STEP_STAT = 'reconcile-stat'
const STEP_IMPORT = 'reconcile-import'

/** The env keys the stat/import scripts read (the proposal path's convention). */
const PLUGIN_ROOT_ENV = 'PLUGIN_THREADS_ROOT'
const PLUGIN_FILE_ENV = 'PLUGIN_THREADS_FILE'

// ── The stat script (bun-direct, executed in the shell worker) ───────────────

/**
 * The reconcile stat recipe — stats + sha256s the plugin thread file (the
 * SAME text-hash the import script computes, so the record's hash dimension
 * compares byte-faithfully). A missing file is DATA (`exists: false`), not
 * an error — the removed verdict's input.
 */
export const RECONCILE_STAT_SCRIPT = `
import { CryptoHasher } from 'bun'
import * as path from 'node:path'

const root = process.env.${PLUGIN_ROOT_ENV}
const file = process.env.${PLUGIN_FILE_ENV}
const msg = (err) => (err instanceof Error ? err.message : String(err))

if (root === undefined || file === undefined) {
  console.log(JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'missing plugin root or file' } }))
  process.exit(0)
}

const target = path.resolve(root, ${JSON.stringify(PLUGIN_THREADS_DIR)}, file)
const f = Bun.file(target)
if (!(await f.exists())) {
  console.log(JSON.stringify({ exists: false }))
  process.exit(0)
}
const hash = new CryptoHasher('sha256').update(await f.text()).digest('hex')
console.log(JSON.stringify({ exists: true, hash }))
`

// ── Threads ──────────────────────────────────────────────────────────────────

/**
 * reconcile-boot — once: the boot trigger. The reload ingress (a later
 * slice) re-issues the same `plugin_threads_reconcile` event mid-run; the
 * read-issue loop is STANDING, so every trigger reconciles afresh.
 */
const reconcileBoot: Thread = {
  name: 'plugin-threads/reconcile-boot',
  description: 'At boot, triggers the plugin-thread registry reconciliation.',
  once: true,
  rules: [{ request: { type: RECONCILE_EVENT_TYPES.reconcile, detail: { id: 'boot' } } }],
}

/** The reconcile trigger's shape — the id disambiguates concurrent passes. */
const RECONCILE_TRIGGER_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1 } },
  required: ['id'],
  additionalProperties: false,
} as const

/**
 * The reload ingress's detail schema — THE TRUST BOUNDARY (the
 * supervision-override precedent): the listener's gate. NAME THE CEILING:
 * a reload is a CODE-EXECUTION trigger — re-importing a changed plugin
 * executes the plugin file's top level (shell_request-class power arriving
 * over ingress); every changed candidate still passes the admission
 * judgment, but this event must only ever arrive from a trusted driver or
 * a sessioned client (the socket host's client-class gate is the other
 * half of the boundary).
 */
export const PLUGIN_THREADS_RELOAD_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      description: 'The reload pass id — disambiguates concurrent reconciliation passes.',
    },
  },
  required: ['id'],
  additionalProperties: false,
} as const

/** The reload detail's boundary — hosts validate ingress before triggering. */
export const validatePluginThreadsReload = ajv.compile(PLUGIN_THREADS_RELOAD_SCHEMA as never)

/**
 * reload-issue — the reload ingress re-runs the reconciliation MID-RUN: a
 * standing transform (any number of reloads), gated by the reload detail
 * schema — the trust boundary. The pass id derives from the reload's own id.
 */
const reloadIssue: Thread = {
  name: 'plugin-threads/reconcile-reload-issue',
  description: 'The reload ingress: re-runs the plugin-thread reconciliation mid-run.',
  rules: [
    {
      transform: [
        {
          type: RECONCILE_EVENT_TYPES.reload,
          query: '. as $d | { id: ($d.id + "-pass") }',
          target: RECONCILE_EVENT_TYPES.reconcile,
          detailSchema: PLUGIN_THREADS_RELOAD_SCHEMA as never,
        },
      ],
    },
  ],
}

/**
 * read-issue — a reconcile trigger reads the registry record; the pass id
 * names every downstream correlation (the joins are per-pass).
 */
const readIssue: Thread = {
  name: 'plugin-threads/reconcile-read-issue',
  description: 'Reads the store-resident registry record for a reconciliation pass.',
  rules: [
    {
      transform: [
        {
          type: RECONCILE_EVENT_TYPES.reconcile,
          query:
            '. as $d | { id: ($d.id + "-read"), op: "get", input: { collection: "plugin-threads", key: "registry" }, ctx: { echo: { step: "' +
            STEP_READ +
            '", pass: $d.id } } }',
          target: 'store_request',
          detailSchema: RECONCILE_TRIGGER_SCHEMA,
        },
      ],
    },
  ],
}

/** The read result's gate — the echo discriminator + the get envelope. */
const READ_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: { value: { type: 'object', required: [], additionalProperties: true, nullable: true } },
      required: ['value'],
      additionalProperties: true,
    },
    ctx: {
      type: 'object',
      properties: {
        echo: {
          type: 'object',
          properties: { step: { type: 'string', const: STEP_READ } },
          required: ['step'],
          additionalProperties: true,
        },
      },
      required: ['echo'],
      additionalProperties: true,
    },
  },
  required: ['id', 'ok', 'result', 'ctx'],
  additionalProperties: true,
} as const

/**
 * The terminal walk event — the carry's exhaust shape: no listener consumes
 * it (the peel's schema requires the entries+next shape), so the walk ends
 * WITHOUT an empty-select transform_error (the clean-boot discipline).
 */
const WALK_DONE = { done: true } as const

/**
 * queue-issue — the read result fans out into the per-entry walk: the
 * entries array extracts (key → fromjson → the tuple dimensions + the entry
 * body), unknown-version entries (v !== 1) and `removed` entries FILTER OUT
 * (quarantined-as-data never reconciles), and the walk starts at next: 0.
 * A missing record (value null) or an empty one walks nothing — the terminal
 * shape, never an empty-select error.
 */
const queueIssue: Thread = {
  name: 'plugin-threads/reconcile-queue-issue',
  description: 'Fans the registry record out into the per-entry reconciliation walk.',
  rules: [
    {
      transform: [
        {
          type: 'store_request_result',
          query:
            '. as $d | ($d.result.value // {}) as $v | ($v.entries // {}) as $e' +
            ' | [ $e | to_entries[]' +
            ' | (.key | fromjson) as $k | select(.value.v == 1 and .value.status != "removed")' +
            ' | { key: .key, plugin: $k[0], file: $k[1], hash: $k[2], space: $k[3], status: .value.status, thread: .value.thread, reason: .value.reason, instanceHash: .value.instanceHash } ] as $entries' +
            ' | if ($entries | length) > 0 then { id: ($d.id + "-queue"), input: { entries: $entries, next: 0 } } else { id: ($d.id + "-queue"), input: ' +
            JSON.stringify(WALK_DONE) +
            ' } end',
          target: RECONCILE_EVENT_TYPES.queue,
          detailSchema: READ_RESULT_SCHEMA,
        },
      ],
    },
  ],
}

/** The queue event's shape — the walk's carry. */
const QUEUE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    input: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: { type: 'object' } },
        next: { type: 'integer', minimum: 0 },
      },
      required: ['entries', 'next'],
      additionalProperties: false,
    },
  },
  required: ['id', 'input'],
  additionalProperties: false,
} as const

/**
 * entry-issue — the walk peels entry[next]: the stat shell_request (the
 * entry rides the echo to the verdict join) and, when entries remain, the
 * carry event (the queue rides the events).
 */
const entryIssue: Thread = {
  name: 'plugin-threads/reconcile-entry-issue',
  description: 'Peels the next registry entry: stats its plugin file and carries the walk.',
  rules: [
    {
      transform: [
        {
          type: RECONCILE_EVENT_TYPES.queue,
          query:
            '. as $d | select($d.input.entries[$d.input.next] != null) | $d.input.entries[$d.input.next] as $e' +
            ' | { id: ($d.id + "-stat-" + ($d.input.next | tostring)), label: "' +
            RECONCILE_LABEL +
            '", input: { op: "run", script: ' +
            JSON.stringify(RECONCILE_STAT_SCRIPT) +
            ', format: "json", env: { ' +
            PLUGIN_ROOT_ENV +
            ': $e.plugin, ' +
            PLUGIN_FILE_ENV +
            ': $e.file } }, ctx: { echo: { step: "' +
            STEP_STAT +
            '", source: $d.id, index: $d.input.next, entry: $e } } }',
          target: 'shell_request',
          detailSchema: QUEUE_SCHEMA,
        },
        {
          type: RECONCILE_EVENT_TYPES.queue,
          query:
            '. as $d | if (($d.input.next + 1) < ($d.input.entries | length)) then { id: $d.id, input: { entries: $d.input.entries, next: ($d.input.next + 1) } } else { id: $d.id, input: ' +
            JSON.stringify(WALK_DONE) +
            ' } end',
          target: RECONCILE_EVENT_TYPES.queue,
          detailSchema: QUEUE_SCHEMA,
        },
      ],
    },
  ],
}

/** The stat result's gate — the echo discriminator + the run envelope + the entry. */
const STAT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ctx: {
      type: 'object',
      properties: {
        echo: {
          type: 'object',
          properties: {
            step: { type: 'string', const: STEP_STAT },
            source: { type: 'string', minLength: 1 },
            index: { type: 'integer', minimum: 0 },
            entry: {
              type: 'object',
              properties: {
                key: { type: 'string', minLength: 1 },
                plugin: { type: 'string', minLength: 1 },
                file: { type: 'string', minLength: 1 },
                hash: { type: 'string', minLength: 1 },
                space: { type: 'string', nullable: true },
                status: { type: 'string', minLength: 1 },
                thread: { type: 'object', nullable: true },
                reason: { type: 'string', nullable: true },
                instanceHash: { type: 'integer', nullable: true },
              },
              required: ['key', 'plugin', 'file', 'hash', 'status'],
              additionalProperties: true,
            },
          },
          required: ['step', 'source', 'index', 'entry'],
          additionalProperties: false,
        },
      },
      required: ['echo'],
      additionalProperties: true,
    },
    result: {
      type: 'object',
      properties: {
        jsonData: {
          type: 'object',
          oneOf: [
            {
              type: 'object',
              properties: { exists: { type: 'boolean', const: false } },
              required: ['exists'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { exists: { type: 'boolean', const: true }, hash: { type: 'string', minLength: 1 } },
              required: ['exists', 'hash'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['jsonData'],
      additionalProperties: true,
    },
  },
  required: ['id', 'ctx', 'result'],
  additionalProperties: true,
} as const

/**
 * stat-join — ONE transform computes the verdict (no empty-select noise):
 * removed (file missing) / mount (unchanged + admitted snapshot) / hold
 * (unchanged + rejected snapshot — the rejection holds, nothing emits) /
 * import (changed — the ONE execution moment). The per-verdict followers
 * act on their own const-gated shape.
 */
const statJoin: Thread = {
  name: 'plugin-threads/reconcile-stat-join',
  description: 'Computes the per-entry stat verdict: removed, mount, hold, or the one-moment re-import.',
  rules: [
    {
      transform: [
        {
          type: 'shell_request_result',
          query:
            '. as $d | $d.ctx.echo.entry as $e' +
            ' | { id: ($d.ctx.echo.source + "-stat-" + ($d.ctx.echo.index | tostring)), input: { verdict: (if $d.result.jsonData.exists == false then "removed" elif $d.result.jsonData.hash == $e.hash then (if $e.status == "admitted" then "mount" else "hold" end) else "import" end), entry: $e } }',
          target: RECONCILE_EVENT_TYPES.stat,
          detailSchema: STAT_RESULT_SCHEMA,
        },
      ],
    },
  ],
}

/** The stat verdict event's shape — the followers' const gates. */
const STAT_VERDICT_SCHEMA = (verdict: string) =>
  ({
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      input: {
        type: 'object',
        properties: {
          verdict: { type: 'string', const: verdict },
          entry: {
            type: 'object',
            properties: {
              key: { type: 'string', minLength: 1 },
              plugin: { type: 'string', minLength: 1 },
              file: { type: 'string', minLength: 1 },
              hash: { type: 'string', minLength: 1 },
              space: { type: 'string', nullable: true },
              status: { type: 'string', minLength: 1 },
              thread: { type: 'object', nullable: true },
              reason: { type: 'string', nullable: true },
              instanceHash: { type: 'integer', nullable: true },
            },
            required: ['key', 'plugin', 'file', 'hash', 'status'],
            additionalProperties: true,
          },
        },
        required: ['verdict', 'entry'],
        additionalProperties: false,
      },
    },
    required: ['id', 'input'],
    additionalProperties: true,
  }) as const

/**
 * The verdict followers — each acts on exactly one verdict (const-gated):
 * removed → the LIVE-teardown event; mount → the snapshot mount event;
 * import → the import issue (the landed import script; the entry rides the
 * echo to the import join). `hold` finds no listener — the unchanged
 * rejection holds, visibly idle.
 */
const statFollowers: Thread[] = [
  {
    name: 'plugin-threads/reconcile-stat-removed',
    description: 'A removed verdict emits the LIVE-teardown + record-removed event.',
    rules: [
      {
        transform: [
          {
            type: RECONCILE_EVENT_TYPES.stat,
            query:
              '. as $d | $d.input.entry as $e' +
              ' | { id: ($d.id + "-removed"), input: ({ plugin: $e.plugin, file: $e.file, hash: $e.hash, instanceHash: $e.instanceHash } + (if $e.space != null then { space: $e.space } else {} end)) }',
            target: RECONCILE_EVENT_TYPES.removed,
            detailSchema: STAT_VERDICT_SCHEMA('removed'),
          },
        ],
      },
    ],
  },
  {
    name: 'plugin-threads/reconcile-stat-mount',
    description: 'A mount verdict emits the snapshot mount event (stamped exactly as admitted).',
    rules: [
      {
        transform: [
          {
            type: RECONCILE_EVENT_TYPES.stat,
            query: '. as $d | $d.input.entry as $e | { id: ($d.id + "-mount"), input: { thread: $e.thread } }',
            target: RECONCILE_EVENT_TYPES.mount,
            detailSchema: STAT_VERDICT_SCHEMA('mount'),
          },
        ],
      },
    ],
  },
  {
    name: 'plugin-threads/reconcile-stat-import',
    description: 'An import verdict issues the one-moment re-import (the landed import script).',
    rules: [
      {
        transform: [
          {
            type: RECONCILE_EVENT_TYPES.stat,
            query:
              '. as $d | $d.input.entry as $e' +
              ' | { id: ($d.id + "-import"), label: "' +
              RECONCILE_LABEL +
              '", input: { op: "run", script: ' +
              JSON.stringify(PLUGIN_THREAD_IMPORT_SCRIPT) +
              ', format: "json", env: { ' +
              PLUGIN_ROOT_ENV +
              ': $e.plugin, ' +
              PLUGIN_FILE_ENV +
              ': $e.file } }, ctx: { echo: { step: "' +
              STEP_IMPORT +
              '", source: $d.id, index: 0, entry: $e } } }',
            target: 'shell_request',
            detailSchema: STAT_VERDICT_SCHEMA('import'),
          },
        ],
      },
    ],
  },
]

/** The import result's gate — the echo discriminator + the entry + the script's shapes. */
const IMPORT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ctx: {
      type: 'object',
      properties: {
        echo: {
          type: 'object',
          properties: {
            step: { type: 'string', const: STEP_IMPORT },
            source: { type: 'string', minLength: 1 },
            index: { type: 'integer', minimum: 0 },
            entry: {
              type: 'object',
              properties: {
                key: { type: 'string', minLength: 1 },
                plugin: { type: 'string', minLength: 1 },
                file: { type: 'string', minLength: 1 },
                hash: { type: 'string', minLength: 1 },
                space: { type: 'string', nullable: true },
                status: { type: 'string', minLength: 1 },
                thread: { type: 'object', nullable: true },
                reason: { type: 'string', nullable: true },
                instanceHash: { type: 'integer', nullable: true },
              },
              required: ['key', 'plugin', 'file', 'hash', 'status'],
              additionalProperties: true,
            },
          },
          required: ['step', 'source', 'index', 'entry'],
          additionalProperties: false,
        },
      },
      required: ['echo'],
      additionalProperties: true,
    },
  },
  required: ['id', 'ctx'],
  additionalProperties: true,
} as const

/** A successful reconcile import — the fresh exports + the NEW content hash. */
const IMPORT_SUCCESS_SCHEMA = {
  ...IMPORT_RESULT_SCHEMA,
  properties: {
    ...IMPORT_RESULT_SCHEMA.properties,
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: {
        jsonData: {
          type: 'object',
          properties: {
            threads: { type: 'array', items: { type: 'object' } },
            hash: { type: 'string', minLength: 1 },
            sourceHash: { type: 'integer', minimum: 0 },
          },
          required: ['threads', 'hash', 'sourceHash'],
          additionalProperties: true,
        },
      },
      required: ['jsonData'],
      additionalProperties: true,
    },
  },
  required: ['id', 'ok', 'result', 'ctx'],
  additionalProperties: true,
} as const

/** A failed reconcile import — a shell-level failure or the script's typed error. */
const IMPORT_FAILURE_SCHEMA = {
  ...IMPORT_RESULT_SCHEMA,
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

/**
 * import-join — the correlated import result maps to the diff event (the
 * composition's host leg owns the deepEqual verdict) or the typed failure
 * surface (the proposal path's terminal type — visible, never a crash).
 */
const importJoin: Thread = {
  name: 'plugin-threads/reconcile-import-join',
  description: 'Joins the reconcile import: the diff event, or the typed failure.',
  rules: [
    {
      transform: [
        {
          type: 'shell_request_result',
          query:
            '. as $d | $d.ctx.echo.entry as $e' +
            ' | { id: ($d.ctx.echo.source + "-diff-" + ($d.ctx.echo.index | tostring)), input: ({ plugin: $e.plugin, file: $e.file, hash: $d.result.jsonData.hash, carriedFrom: $e.hash, exports: $d.result.jsonData.threads, snapshot: { status: $e.status, thread: $e.thread, reason: $e.reason } } + (if $e.space != null then { space: $e.space } else {} end)) }',
          target: RECONCILE_EVENT_TYPES.importDiff,
          detailSchema: IMPORT_SUCCESS_SCHEMA,
        },
        {
          type: 'shell_request_result',
          query:
            '. as $d | ($d.error // $d.result.jsonData.error // {}) as $e | $d.ctx.echo.entry as $en' +
            ' | { id: ($d.ctx.echo.source + "-failed-" + ($d.ctx.echo.index | tostring)), input: { plugin: $en.plugin, file: $en.file, error: { code: ($e.code // "error"), message: ($e.message // "unknown failure") } } }',
          target: PLUGIN_THREADS_EVENT_TYPES.failed,
          detailSchema: IMPORT_FAILURE_SCHEMA,
        },
      ],
    },
  ],
}

/** The plugin-threads boot reconciliation threads — mounted by the entry with shell + store on. */
export const pluginThreadsReconcileThreads: Thread[] = [
  reconcileBoot,
  reloadIssue,
  readIssue,
  queueIssue,
  entryIssue,
  statJoin,
  ...statFollowers,
  importJoin,
]
