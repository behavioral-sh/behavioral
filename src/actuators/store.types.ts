/**
 * Types shared by the store worker (`store.worker.ts`) and its host
 * consumers — the seeding key plus the per-op input and result shapes.
 *
 * @remarks
 * Types only (plus the environment-data key constant) — no runtime side
 * effects, so importing this module is safe on both sides of the worker
 * boundary. The wire itself is the behavioral event vocabulary
 * (`store_request` / `store_request_result`, defined in
 * `src/actuators/actuators.types.ts`); only the op payload shapes live
 * here. The worker compiles and enforces the input schemas itself — the
 * sqlite schema is worker-internal by design (schema churn never becomes
 * protocol churn).
 *
 * @packageDocumentation
 */

import type { JsonObject } from '../behavioral/behavioral.types.ts'

/**
 * Environment-data key for the store db path. The host seeds it with
 * `setEnvironmentData` before spawn (never from agent input); the worker
 * reads it once at startup. `':memory:'` backs a hermetic in-memory db.
 */
export const STORE_DB_PATH_KEY = 'behavioral:store-db-path'

/** The reserved unscoped umwelt identity — the growth model's root umwelt. */
export const ROOT_UMWELT = 'root'

export type StorePutInput = {
  collection: string
  key: string
  value: JsonObject
}

export type StoreGetInput = {
  collection: string
  key: string
}

export type StoreDeleteInput = {
  collection: string
  key: string
}

/** Empty/absent filter enumerates the collection. */
export type StoreQueryInput = {
  collection: string
  filter?: JsonObject
}

export type StoreGetResult = {
  value: JsonObject | null
}

export type StoreDeleteResult = {
  deleted: boolean
}

export type StoreQueryResult = {
  rows: Array<{ key: string; value: JsonObject; updated_at: number }>
}
