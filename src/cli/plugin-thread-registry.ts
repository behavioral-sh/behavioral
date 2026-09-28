/**
 * The plugin-thread admission registry — the durable record of admission
 * decisions, host-local under `<home>` (the config.ts/traces pattern —
 * never the space-scoped store).
 *
 * @remarks
 * Keyed (plugin, file, content hash, space): an `admitted` entry carries
 * the validated thread SNAPSHOT — threads are pure data, so a boot mounts
 * straight from the snapshot and never re-imports the plugin file for an
 * unchanged admission. A `rejected` entry carries the reason and stays out,
 * visible in traces. Hash keying means a plugin update re-arms the proposal:
 * new thread code is never silently admitted. Re-proposal triggers are
 * exactly the key's dimensions — a new file, a changed hash, or a new
 * target space; root and a named space hold independent entries for the
 * same thread.
 *
 * The file is an external boundary (user-editable, crash-persisted), so the
 * whole registry validates against the AJV schema on read — the thread leg
 * derives from the engine's own `ThreadSchema` home, never hand-mirrored —
 * and a malformed file fails fast with its path (the load-config pattern),
 * never silently ignored. Writes are synchronous by design: the
 * composition's trace-listener outcome legs fire-and-forget, so an async
 * writer could reorder or drop the last admission on exit (the trace-log
 * sink's rule).
 *
 * @packageDocumentation
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ajv, type Thread, ThreadSchema } from '../behavioral/behavioral.types.ts'
import { behavioralHome } from '../old-faculties/behavioral-home.ts'

/** The registry file under `<home>` — one JSON document, the whole registry. */
export const PLUGIN_THREAD_REGISTRY_FILE = 'plugin-threads.json'

/** One admission decision for one (plugin, file, hash, space) key. */
export type PluginThreadRegistryEntry = { status: 'admitted'; thread: Thread } | { status: 'rejected'; reason: string }

/** The registry — a map from decision key to decision. */
export type PluginThreadRegistry = Record<string, PluginThreadRegistryEntry>

/**
 * The decision key — the tuple (plugin, file, content hash, target space),
 * JSON-encoded (paths contain separators; the encoding is unambiguous).
 * An absent space and a named space are independent keys (Root/D).
 */
export const pluginThreadRegistryKey = ({
  plugin,
  file,
  hash,
  space,
}: {
  plugin: string
  file: string
  hash: string
  space?: string
}): string => JSON.stringify([plugin, file, hash, space ?? null])

/** The registry file's path under a home root. */
export const pluginThreadRegistryPath = (home: string): string => join(home, PLUGIN_THREAD_REGISTRY_FILE)

/** One decision's shape — the thread leg is the engine ThreadSchema home, never a mirror. */
const ENTRY_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: { status: { type: 'string', const: 'admitted' }, thread: ThreadSchema },
      required: ['status', 'thread'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { status: { type: 'string', const: 'rejected' }, reason: { type: 'string', minLength: 1 } },
      required: ['status', 'reason'],
      additionalProperties: false,
    },
  ],
} as const

const REGISTRY_SCHEMA = {
  type: 'object',
  additionalProperties: ENTRY_SCHEMA,
} as const

const validateRegistry = ajv.compile(REGISTRY_SCHEMA)

/**
 * Read the registry under `<home>` (default: the behavioral home). A missing
 * file reads as empty — a fresh harness has no decisions yet. A malformed or
 * schema-invalid file fails fast with its path: the registry gates what code
 * boots, so a corrupt file is never silently ignored (the load-config
 * pattern).
 */
export const readPluginThreadRegistry = (home: string = behavioralHome()): PluginThreadRegistry => {
  const path = pluginThreadRegistryPath(home)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return {}
    throw new Error(`plugin-threads registry could not be read at ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`plugin-threads registry is not valid JSON at ${path}: ${(err as Error).message}`)
  }
  if (!validateRegistry(parsed)) {
    throw new Error(`plugin-threads registry is invalid at ${path}: ${ajv.errorsText(validateRegistry.errors)}`)
  }
  return parsed as PluginThreadRegistry
}

/**
 * Persist the whole registry (validated at the boundary — the entries came
 * through the composition's own admission path, but the write is the last
 * line of defense before the file becomes boot input).
 */
export const writePluginThreadRegistry = (home: string, registry: PluginThreadRegistry): void => {
  if (!validateRegistry(registry)) {
    throw new Error(`plugin-threads registry entry is invalid: ${ajv.errorsText(validateRegistry.errors)}`)
  }
  writeFileSync(pluginThreadRegistryPath(home), `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}
