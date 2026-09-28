/**
 * Store worker — durable, space-scoped key-value persistence for data that
 * must survive behavioral invocations: run counters, budget ledgers, the
 * discovery catalog.
 *
 * @remarks
 * Spawned by URL (never imported) and speaks the behavioral event wire:
 * `store_request` events in (dispatched by `detail.op`: put / get / delete /
 * query), one `store_request_result` out with the request `space` echoed.
 * No cancel: ops are short-lived (frontier rule).
 *
 * **Space isolation is the non-negotiable floor.** Space comes from the
 * event envelope (provisioner-stamped, thread-space-derived), never from op
 * input — every per-op schema is `additionalProperties: false`, so a
 * `space`/`path`/host key inside `input` is rejected at the boundary.
 * Spaceless requests stamp rows as the root space.
 *
 * **The sqlite schema is worker-internal.** Only JSON ops cross the wire —
 * no SQL, no expressions — so backings stay swappable per host (bun:sqlite
 * here, sql.js, IndexedDB in a browser) without protocol change. The backing
 * is one owned connection for the worker's lifetime (WAL for file dbs), with version-stamped migrations on boot.
 *
 * **Not the authority surface:** threads/html learning stays files+git
 * (2026-09-17 growth-model decision); this store is regenerable index +
 * non-authority durable data.
 *
 * MINIMAL: no pagination/cursor (collections are small), no FTS5 (shallow
 * field filter via LIKE-free scan), no purge/bulk/subscribe ops — add when a
 * consumer exists. Unknown schema_version from a future binary is assumed
 * forward-compatible rather than gated.
 *
 * @packageDocumentation
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject } from '../behavioral/behavioral.types.ts'
import { deepEqual } from '../utils.ts'
import { ACTUATOR_MESSAGE_KINDS } from './actuators.constants.ts'
import { validateStoreRequestEvent } from './actuators.schemas.ts'
import type { StoreRequestEvent } from './actuators.types.ts'
import { behavioralHome } from './behavioral-home.ts'
import { emit, envData, wireInbound } from './process-lane.ts'
import {
  ROOT_SPACE,
  STORE_DB_PATH_KEY,
  type StoreDeleteInput,
  type StoreGetInput,
  type StorePutInput,
  type StoreQueryInput,
} from './store.types.ts'

// ---------------------------------------------------------------------------
// Backing — one owned connection, migrations on boot
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.join(behavioralHome(), 'db.sqlite')
const SCHEMA_VERSION = '1'

const dbPath = (envData(STORE_DB_PATH_KEY) as string | undefined) ?? DEFAULT_DB_PATH
if (dbPath !== ':memory:') {
  mkdirSync(path.dirname(dbPath), { recursive: true })
}
const db = new Database(dbPath)
if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL')

db.exec('CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
const versionRow = db.query(`SELECT value FROM store_meta WHERE key = 'schema_version'`).get() as
  | { value: string }
  | null
  | undefined
// `.get()` returns null (not undefined) for no rows — check both.
if (versionRow === null || versionRow === undefined) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_entries (
      space TEXT NOT NULL,
      collection TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space, collection, key)
    )
  `)
  db.query(`INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)`).run(SCHEMA_VERSION)
}

// ---------------------------------------------------------------------------
// Input boundary — per-op schemas (space/host keys rejected by construction)
// ---------------------------------------------------------------------------

const jsonObjectSchema = { type: 'object', required: [], additionalProperties: true } as const

const PutInputSchema: JSONSchemaType<StorePutInput> = {
  type: 'object',
  properties: {
    collection: { type: 'string', minLength: 1 },
    key: { type: 'string', minLength: 1 },
    value: jsonObjectSchema,
  },
  required: ['collection', 'key', 'value'],
  additionalProperties: false,
}

const GetInputSchema: JSONSchemaType<StoreGetInput> = {
  type: 'object',
  properties: {
    collection: { type: 'string', minLength: 1 },
    key: { type: 'string', minLength: 1 },
  },
  required: ['collection', 'key'],
  additionalProperties: false,
}

const DeleteInputSchema: JSONSchemaType<StoreDeleteInput> = {
  type: 'object',
  properties: {
    collection: { type: 'string', minLength: 1 },
    key: { type: 'string', minLength: 1 },
  },
  required: ['collection', 'key'],
  additionalProperties: false,
}

const QueryInputSchema: JSONSchemaType<StoreQueryInput> = {
  type: 'object',
  properties: {
    collection: { type: 'string', minLength: 1 },
    filter: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: ['collection'],
  additionalProperties: false,
}

const validatePut = ajv.compile(PutInputSchema)
const validateGet = ajv.compile(GetInputSchema)
const validateDelete = ajv.compile(DeleteInputSchema)
const validateQuery = ajv.compile(QueryInputSchema)

// ---------------------------------------------------------------------------
// Event dispatch — the wire surface
// ---------------------------------------------------------------------------

const postResult = ({
  id,
  result,
  space,
  ctx,
}: {
  id: string
  result: unknown
  space?: string
  ctx?: JsonObject
}): void => {
  emit({
    type: ACTUATOR_MESSAGE_KINDS.store_request_result,
    // The uniform envelope: op-runner { ok: true, … } → ok branch (payload =
    // the rest); { isError: true, … } or a throw → error branch. The request's
    // ctx echoes at detail level — the out-of-band join lane (thread
    // orchestration state round-trips beside ok, never model-facing).
    detail: ((): JsonObject & { id: string } => {
      const base = ((): JsonObject & { id: string } => {
        if (typeof result === 'object' && result !== null && 'isError' in result) {
          const { isError, ...rest } = result as { isError: boolean } & JsonObject
          return { id, ok: false, error: { code: 'error', ...(isError ? rest : {}) } }
        }
        if (typeof result === 'object' && result !== null && 'ok' in result) {
          const { ok, ...rest } = result as { ok: boolean } & JsonObject
          return ok ? { id, ok: true, result: rest } : { id, ok: false, error: { code: 'error', ...rest } }
        }
        return { id, ok: true, result: (result ?? {}) as JsonObject }
      })()
      return ctx === undefined ? base : ({ ...base, ctx } as JsonObject & { id: string })
    })(),
    ...(space === undefined ? {} : { space }),
  })
}

type OpRunner = {
  validate: (input: unknown) => boolean
  errors: () => string | null
  run: (input: never, space: string) => unknown
}

const OP_RUNNERS = {
  put: {
    validate: validatePut,
    errors: () => ajv.errorsText(validatePut.errors),
    run: ({ collection, key, value }: StorePutInput, space): { ok: true } => {
      db.query(
        `INSERT INTO store_entries (space, collection, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(space, collection, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(space, collection, key, JSON.stringify(value), Date.now())
      return { ok: true }
    },
  },
  get: {
    validate: validateGet,
    errors: () => ajv.errorsText(validateGet.errors),
    run: ({ collection, key }: StoreGetInput, space): { value: JsonObject | null } => {
      // `.get()` returns null (not undefined) for no rows — check both.
      const row = db
        .query(`SELECT value_json FROM store_entries WHERE space = ? AND collection = ? AND key = ?`)
        .get(space, collection, key) as { value_json: string } | null | undefined
      if (row === null || row === undefined) return { value: null }
      return { value: JSON.parse(row.value_json) as JsonObject }
    },
  },
  delete: {
    validate: validateDelete,
    errors: () => ajv.errorsText(validateDelete.errors),
    run: ({ collection, key }: StoreDeleteInput, space): { deleted: boolean } => {
      const res = db
        .query(`DELETE FROM store_entries WHERE space = ? AND collection = ? AND key = ?`)
        .run(space, collection, key)
      return { deleted: res.changes > 0 }
    },
  },
  query: {
    validate: validateQuery,
    errors: () => ajv.errorsText(validateQuery.errors),
    run: (
      { collection, filter }: StoreQueryInput,
      space,
    ): { rows: Array<{ key: string; value: JsonObject; updated_at: number }> } => {
      const rows = db
        .query(
          `SELECT key, value_json, updated_at FROM store_entries
           WHERE space = ? AND collection = ?
           ORDER BY updated_at DESC, key ASC`,
        )
        .all(space, collection) as Array<{ key: string; value_json: string; updated_at: number }>
      const parsed = rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.value_json) as JsonObject,
        updated_at: row.updated_at,
      }))
      const filtered =
        filter === undefined
          ? parsed
          : parsed.filter((row) =>
              Object.entries(filter).every(([field, expected]) =>
                deepEqual((row.value as Record<string, unknown>)[field], expected),
              ),
            )
      return { rows: filtered }
    },
  },
} satisfies Record<string, OpRunner>

// The wire is the behavioral event vocabulary, validated with the shared
// schemas — the trust boundary for anything crossing into this process. `op`
// is enum-constrained at the event schema, so the runner lookup is defense in
// depth. Every throw is caught and posted as { isError, message } data.
const handleInbound = (message: unknown): void => {
  if (!validateStoreRequestEvent(message)) return
  const event = message as StoreRequestEvent
  const { id, op, input, ctx } = event.detail
  const runner = OP_RUNNERS[op]
  if (runner === undefined) {
    postResult({ id, result: { isError: true, message: `unknown store operation: ${op}` }, space: event.space, ctx })
    return
  }
  if (!runner.validate(input)) {
    postResult({ id, result: { isError: true, message: `invalid input: ${runner.errors()}` }, space: event.space, ctx })
    return
  }
  try {
    postResult({ id, result: runner.run(input as never, event.space ?? ROOT_SPACE), space: event.space, ctx })
  } catch (err) {
    postResult({
      id,
      result: { isError: true, message: err instanceof Error ? err.message : String(err) },
      space: event.space,
      ctx,
    })
  }
}

if (import.meta.main) {
  // Standalone (spawned process) — wire the stdio line lane. An in-process
  // import (the composition's frontier embed) wires nothing: the host's
  // stdin is never touched.
  wireInbound((message) => {
    handleInbound(message)
  })
}
