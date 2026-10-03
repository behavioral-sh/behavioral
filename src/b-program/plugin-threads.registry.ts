/**
 * The plugin-thread admission registry — the STORE-RESIDENT record (the file
 * registry died with this module's landing; the stale-debris failure class —
 * a crash-torn JSON file poisoning boot — dies with it).
 *
 * @remarks
 * The registry home is ONE root-space store record
 * (`plugin-threads/registry`): the whole decision map as one document, get/put
 * only — no new store ops. Keyed (plugin, file, sha256 fileHash, space?): an
 * `admitted` entry carries the validated thread SNAPSHOT stamped with the
 * instance identity (the third hash — removal-addressable mount), a
 * `rejected` entry carries the reason and stays out, visible. `carriedFrom`
 * provenance marks a verdict carried forward across a cosmetic rewrite (the
 * two-tier diff). Every entry is versioned (`v`) — an unknown-version entry
 * is QUARANTINED-AS-DATA: kept verbatim in the document (a future binary's
 * migration input), never a boot crash, never a decision.
 *
 * TWO HASHES, TWO JOBS (unchanged), PLUS THE THIRD: the key's content hash is
 * the re-adjudication key; the thread's `sourceHash` is plugin-origin
 * provenance; `instanceHash` = djb2(canonical plugin path + space + thread
 * NAME) — the removal/mount identity stamped post-sourceHash-stamp, never by
 * the plugin author. Content never enters identity.
 *
 * The durable-write watcher rides the ENTRY's own trace subscription (the
 * composition no longer knows the registry). The join is the
 * candidate→verdict→outcome chain, all visible as selections — the same
 * joins, the same outcome legs the file watcher had; the write is a
 * `store_request` put through the composition's routing (`runtime.trigger`),
 * the entry-side's only ingress. Writes are tracked in flight: the exit-flush
 * rule says the composition must not terminate with puts outstanding —
 * `flush()` awaits them, bounded so a dead lane degrades to a logged warning,
 * never a hung exit.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import {
  ajv,
  type JsonObject,
  type Thread,
  ThreadSchema,
  type Trigger,
  validateThread,
} from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import { ADMISSION_EVENT_TYPES, validateAdmissionVerdict } from '../faculties/system-one.threads.ts'
import { hashString } from '../utils/hash-string.ts'
import { uuid } from '../utils.ts'
import { PLUGIN_THREADS_EVENT_TYPES } from './plugin-threads.threads.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The root-space store collection holding the registry record. */
export const PLUGIN_THREADS_REGISTRY_COLLECTION = 'plugin-threads'

/** The store key — one value, the whole registry document. */
export const PLUGIN_THREADS_REGISTRY_KEY = 'registry'

/** The entry version — an entry stamped with anything else quarantines as data. */
export const PLUGIN_THREADS_REGISTRY_VERSION = 1

/** Bounded exit-flush grace — a store lane that never answers must not hang the exit. */
const REGISTRY_FLUSH_TIMEOUT_MS = 10_000

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

/**
 * The THIRD HASH — the instance identity: djb2 over the canonical join
 * `plugin \0 space \0 name`. The canonical form is spec'd HERE (one home, the
 * hashString TSDoc's caller-owns-canonical-input contract): the plugin's
 * canonical path/URI exactly as proposed, the admission's space stamp
 * (absent = root, the empty string), the thread NAME. Within-plugin name
 * uniqueness (the collision pass) makes the triple unique per admission;
 * content NEVER enters — a rewritten thread body keeps its removal address.
 */
export const pluginThreadInstanceHash = ({
  plugin,
  space,
  name,
}: {
  plugin: string
  space?: string
  name: string
}): number => hashString(`${plugin}\u0000${space ?? ''}\u0000${name}`)

// ── The record — the thread leg derives from the engine schema home ─────────

/** One admission decision for one (plugin, file, hash, space) key — versioned. */
export type PluginThreadRegistryEntry =
  | {
      status: 'admitted'
      thread: Thread
      instanceHash: number
      /** Where present: the verdict was carried forward from this previous file hash (the two-tier diff). */
      carriedFrom?: string
      v: number
    }
  | {
      status: 'rejected'
      reason: string
      carriedFrom?: string
      v: number
    }

/** The registry — a map from decision key to decision. */
export type PluginThreadRegistry = Record<string, PluginThreadRegistryEntry>

/** The whole registry document — one store value. */
export type PluginThreadRegistryDoc = { entries: PluginThreadRegistry }

const CARRIED_FROM = { type: 'string', minLength: 1 } as const
const VERSION = { type: 'integer', minimum: 1 } as const

/**
 * One decision's shape — the thread leg IS the engine `ThreadSchema` home,
 * never a mirror (the no-cross-module-schema-drift rule).
 */
const ENTRY_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { type: 'string', const: 'admitted' },
        thread: ThreadSchema,
        instanceHash: { type: 'integer', minimum: 0 },
        carriedFrom: CARRIED_FROM,
        v: VERSION,
      },
      required: ['status', 'thread', 'instanceHash', 'v'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        status: { type: 'string', const: 'rejected' },
        reason: { type: 'string', minLength: 1 },
        carriedFrom: CARRIED_FROM,
        v: VERSION,
      },
      required: ['status', 'reason', 'v'],
      additionalProperties: false,
    },
  ],
} as const

const DOC_SCHEMA = {
  type: 'object',
  properties: { entries: { type: 'object', additionalProperties: ENTRY_SCHEMA } },
  required: ['entries'],
  additionalProperties: false,
} as unknown as JSONSchemaType<PluginThreadRegistryDoc>

/** @internal Compiled once — the store record's read boundary. */
const validateDoc = ajv.compile(DOC_SCHEMA)

/**
 * Read-partition the registry document — the trust boundary for anything
 * crossing back from the store. Returns the whole document (writes merge
 * into it — quarantined entries ride verbatim), the CURRENT-VERSION entries
 * as decisions, and the unknown-version keys as the quarantine set.
 * A malformed document throws with the Ajv errors — a corrupt record is
 * never silently rewritten (the file registry's fail-fast posture, kept).
 */
export const parseRegistryDoc = (
  value: unknown,
): {
  doc: PluginThreadRegistryDoc
  decisions: Map<string, PluginThreadRegistryEntry>
  quarantined: Set<string>
} => {
  if (!validateDoc(value)) {
    throw new Error(`plugin-thread registry record is invalid: ${ajv.errorsText(validateDoc.errors)}`)
  }
  const doc = value as PluginThreadRegistryDoc
  const decisions = new Map<string, PluginThreadRegistryEntry>()
  const quarantined = new Set<string>()
  for (const [key, entry] of Object.entries(doc.entries)) {
    if (entry.v === PLUGIN_THREADS_REGISTRY_VERSION) decisions.set(key, entry)
    else quarantined.add(key)
  }
  return { doc, decisions, quarantined }
}

// ── The durable-write watcher ────────────────────────────────────────────────

/** The watcher's runtime view — trigger (the egress routing) + useTrace (the joins). */
export type RegistryWatchRuntime = {
  trigger: Trigger
  useTrace: (listener: (trace: unknown) => void) => unknown
}

/**
 * The entry-side durable-write legs — the registry's decision records ride
 * the entry's OWN trace subscription. The join is the candidate→verdict→
 * outcome chain, all visible as selections:
 *
 * - `plugin_threads_candidate` { id, input: { thread, plugin, file, hash, space? } }
 *   registers the proposal (the thread leg validated against the engine's
 *   ThreadSchema home — a non-conforming thread is a null snapshot, never an
 *   admission);
 * - `frontier_analysis_request` { op: "add_thread", input: { thread, ... } }
 *   refreshes the pending thread from the dispatch — the stamped candidate,
 *   so the admitted snapshot carries the provenance join;
 * - `frontier_analysis_request_result` { id, ok, result/error } captures the
 *   structural verdict (a failed verdict carries its reason);
 * - `thread_admission` / `thread_admission_rejected` { id, reason? } is the
 *   outcome: the write fires exactly once per registered id — the admitted
 *   snapshot (stamped with the instance identity) only when BOTH legs passed,
 *   the rejection otherwise.
 *
 * Seeding is LAZY (zero store traffic when a run admits nothing): the first
 * outcome read-merges the record, replaying any queued writes. The seed's
 * store get routes through the composition's own pump — absent a store lane
 * it never answers and the watcher degrades to the bounded flush warning,
 * fail-visible.
 */
export const watchPluginThreadRegistry = ({
  runtime,
}: {
  runtime: RegistryWatchRuntime
}): { flush: () => Promise<void> } => {
  type Pending = {
    thread: Thread | null
    plugin: string
    file: string
    hash: string
    space?: string
    verdictReason?: string
  }
  const pending = new Map<string, Pending>()
  /** The seeded document — undefined until the first outcome's read-merge lands. */
  let doc: PluginThreadRegistryDoc | undefined
  let seedId: string | undefined
  /** Outcome writes awaiting the seed (the whole-doc put merges them on landing). */
  const writeQueue: Array<{ key: string; entry: PluginThreadRegistryEntry }> = []
  /** In-flight put ids — the exit-flush rule's outstanding set. */
  const pendingWrites = new Set<string>()

  const issue = (detail: JsonObject): void => runtime.trigger({ type: FACULTY_MESSAGE_KINDS.store_request, detail })

  const ensureSeed = (): void => {
    if (seedId !== undefined || doc !== undefined) return
    seedId = `registry-seed-${uuid()}`
    issue({
      id: seedId,
      op: 'get',
      input: { collection: PLUGIN_THREADS_REGISTRY_COLLECTION, key: PLUGIN_THREADS_REGISTRY_KEY },
    })
  }

  const flushWrite = (): void => {
    if (doc === undefined) return
    const id = `registry-put-${uuid()}`
    pendingWrites.add(id)
    issue({
      id,
      op: 'put',
      input: {
        collection: PLUGIN_THREADS_REGISTRY_COLLECTION,
        key: PLUGIN_THREADS_REGISTRY_KEY,
        value: doc as unknown as JsonObject,
      },
    })
  }

  const record = (key: string, entry: PluginThreadRegistryEntry): void => {
    if (doc === undefined) {
      writeQueue.push({ key, entry })
      ensureSeed()
      return
    }
    doc.entries[key] = entry
    flushWrite()
  }

  runtime.useTrace((trace) => {
    if (typeof trace !== 'object' || trace === null) return
    const t = trace as { kind?: string; selected?: { type?: string; detail?: Record<string, unknown> } }
    if (t.kind !== 'selection' || t.selected === undefined) return
    const candidate = t.selected as { type: string; detail?: Record<string, unknown> }
    const detail = candidate.detail ?? {}

    // The seed + write-completion legs (the store result lane).
    if (candidate.type === FACULTY_MESSAGE_KINDS.store_request_result) {
      const id = typeof detail.id === 'string' ? detail.id : undefined
      if (id !== undefined && id === seedId) {
        seedId = undefined
        const value = (detail.result as { value?: unknown } | undefined)?.value
        if (detail.ok === false && value === undefined) {
          // A genuinely failed read: never clobber — durability degrades
          // visibly, the queued writes stay queued (the flush warning fires).
          console.error('[plugin-thread-registry] seed read failed; registry writes are held:', detail.error)
          return
        }
        try {
          doc =
            value === null || value === undefined
              ? { entries: {} }
              : // The doc rides whole — decisions AND quarantined entries.
                (parseRegistryDoc(value).doc satisfies PluginThreadRegistryDoc)
        } catch (error) {
          console.error('[plugin-thread-registry] record failed its schema; writes are held:', error)
          return
        }
        const queued = writeQueue.splice(0, writeQueue.length)
        for (const { key, entry } of queued) doc.entries[key] = entry
        if (queued.length > 0) flushWrite()
        return
      }
      if (id !== undefined) pendingWrites.delete(id)
      return
    }

    // ── The joins — verbatim from the file watcher's shape ──────────────────
    if (candidate.type === PLUGIN_THREADS_EVENT_TYPES.candidate) {
      const input = detail.input as
        | { thread?: unknown; plugin?: unknown; file?: unknown; hash?: unknown; space?: unknown }
        | undefined
      if (
        typeof detail.id !== 'string' ||
        typeof input?.plugin !== 'string' ||
        typeof input?.file !== 'string' ||
        typeof input?.hash !== 'string'
      )
        return
      pending.set(detail.id, {
        thread: validateThread(input.thread) ? (input as { thread: Thread }).thread : null,
        plugin: input.plugin,
        file: input.file,
        hash: input.hash,
        ...(typeof input.space === 'string' ? { space: input.space } : {}),
      })
      return
    }
    // The dispatch refresh: the candidate-dispatch stamps the sourceHash onto
    // the thread before the add_thread dispatch — the pending record adopts
    // the stamped thread (validated again against the engine's schema home).
    if (candidate.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request && pending.has(detail.id as string)) {
      const input = (detail as { input?: { op?: unknown; thread?: unknown } }).input
      if ((detail.op as string | undefined) !== 'add_thread' || input === undefined || typeof input !== 'object') return
      const thread = (input as { thread?: unknown }).thread
      const rec = pending.get(detail.id as string)!
      rec.thread = validateThread(thread) ? (thread as Thread) : null
      return
    }
    if (candidate.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result && pending.has(detail.id as string)) {
      const rec = pending.get(detail.id as string)!
      if (detail.ok === false)
        rec.verdictReason =
          (detail.error as { message?: string } | undefined)?.message ??
          `structural verdict: ${(detail.result as { status?: string } | undefined)?.status ?? 'failed'}`
      return
    }
    if (
      (candidate.type === ADMISSION_EVENT_TYPES.admitted || candidate.type === ADMISSION_EVENT_TYPES.rejected) &&
      pending.has(detail.id as string)
    ) {
      const rec = pending.get(detail.id as string)!
      pending.delete(detail.id as string)
      const admitted =
        candidate.type === ADMISSION_EVENT_TYPES.admitted &&
        validateAdmissionVerdict(candidate.detail) &&
        rec.thread !== null
      const entry: PluginThreadRegistryEntry = admitted
        ? // The instance identity stamps HERE — post-sourceHash-stamp, the
          // mount path's job, never the plugin author's. The stored snapshot
          // is mount-ready: a Slice-2 mount addThreads it and the engine keys
          // it removal-addressable.
          (() => {
            const thread = rec.thread!
            const instanceHash = pluginThreadInstanceHash({ plugin: rec.plugin, space: rec.space, name: thread.name })
            return {
              status: 'admitted' as const,
              thread: { ...thread, instanceHash },
              instanceHash,
              v: PLUGIN_THREADS_REGISTRY_VERSION,
            }
          })()
        : {
            status: 'rejected' as const,
            reason: (detail.reason as string | undefined) ?? rec.verdictReason ?? 'admission rejected',
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          }
      record(pluginThreadRegistryKey(rec), entry)
    }
  })

  return {
    /**
     * The exit-flush rule: the composition must not terminate with puts in
     * flight. Resolves when the seed and every put have landed; bounded —
     * a store lane that never answers degrades to a logged warning, never a
     * hung exit.
     */
    flush: async (): Promise<void> => {
      const outstanding = (): boolean => seedId !== undefined || writeQueue.length > 0 || pendingWrites.size > 0
      const deadline = Date.now() + REGISTRY_FLUSH_TIMEOUT_MS
      while (outstanding() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      if (outstanding()) {
        console.error(
          '[plugin-thread-registry] exit flush timed out with writes in flight — the last decision may not be durable',
        )
      }
    },
  }
}
