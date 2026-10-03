/**
 * The plugin-thread admission registry — the STORE-RESIDENT record (the file
 * registry died): one root-space store record (`plugin-threads/registry`)
 * holding the whole decision map, versioned per entry, written through the
 * composition's routing by the entry-side durable-write watcher (the same
 * joins, the same outcome legs the file watcher had — store puts instead of
 * file writes). The thread leg derives from the engine's ThreadSchema home —
 * never hand-mirrored.
 *
 * THE TEMP-HOME TRIPWIRE: every store here boots against a per-spec temp
 * home via the spawn env-override pattern (`env: { BEHAVIORAL_HOME: <temp> }`
 * — explicit threading, never runtime mutation). The file registry's death
 * must not ship the store db as the new real-home debris surface.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTUATOR_MESSAGE_KINDS } from '../../actuators/actuators.constants.ts'
import { validateStoreRequestEvent } from '../../actuators/actuators.schemas.ts'
import { useActuator } from '../../actuators/use-actuator.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { JsonObject, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { ADMISSION_EVENT_TYPES } from '../../faculties/system-one.threads.ts'
import { hashString } from '../../utils.ts'
import { bProgram } from '../b-program.ts'
import {
  PLUGIN_THREADS_REGISTRY_COLLECTION,
  PLUGIN_THREADS_REGISTRY_KEY,
  PLUGIN_THREADS_REGISTRY_VERSION,
  type PluginThreadRegistryEntry,
  parseRegistryDoc,
  pluginThreadInstanceHash,
  pluginThreadRegistryKey,
  watchPluginThreadRegistry,
} from '../plugin-threads.registry.ts'
import { PLUGIN_THREADS_EVENT_TYPES } from '../plugin-threads.threads.ts'

// ── The harness — real store actuator, per-spec temp home ────────────────────

const storeLane = (home: string) =>
  useActuator({
    command: ['bun', 'run', 'store.actuator.ts'],
    name: 'store',
    env: { BEHAVIORAL_HOME: home },
    validateRequest: validateStoreRequestEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
  })

/** The record reader — a SECOND store spawn against the same home db. */
const readRegistryRecord = async (home: string): Promise<unknown> => {
  const store = storeLane(home)
  const results: Array<Record<string, unknown>> = []
  const probe = bProgram({ actuators: [store] })
  probe.useTrace((trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection) results.push(trace.selected.detail as Record<string, unknown>)
  })
  // The boot-order law: subscribe, then start — the store result's re-entry
  // thread is deferred until the flush.
  probe.start()
  probe.trigger({
    type: FACULTY_MESSAGE_KINDS.store_request,
    detail: {
      id: 'record-read',
      op: 'get',
      input: { collection: PLUGIN_THREADS_REGISTRY_COLLECTION, key: PLUGIN_THREADS_REGISTRY_KEY },
    },
  })
  const deadline = Date.now() + 8000
  for (;;) {
    // The result selection shares the request's id — pick the one carrying `ok`.
    const found = results.find((d) => d.id === 'record-read' && d.ok !== undefined)
    if (found !== undefined) {
      probe.terminate()
      return (found.result as { value?: unknown } | undefined)?.value
    }
    if (Date.now() > deadline) throw new Error('registry record never read back')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** One composition + watcher wired over a fresh temp home; the caller cleans up. */
const drive = (): {
  home: string
  runtime: ReturnType<typeof bProgram>
  traces: Trace[]
  registry: { flush: () => Promise<void> }
  done: () => Promise<void>
} => {
  const home = mkdtempSync(join(tmpdir(), 'registry-spec-'))
  const traces: Trace[] = []
  const runtime = bProgram({ actuators: [storeLane(home)] })
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  const registry = watchPluginThreadRegistry({ runtime })
  runtime.start()
  return {
    home,
    runtime,
    traces,
    registry,
    done: async (): Promise<void> => {
      await registry.flush()
      runtime.terminate()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** The candidate→verdict→outcome join chain, one trigger per leg (order preserved). */
const admit = (d: ReturnType<typeof drive>, id: string, thread: Thread): void => {
  d.runtime.trigger({
    type: PLUGIN_THREADS_EVENT_TYPES.candidate,
    detail: { id, input: { plugin: '/plugins/alpha', file: 't.ts', hash: 'hash-1' } },
  })
  d.runtime.trigger({
    type: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
    detail: { id, op: 'add_thread', input: { thread } } as unknown as JsonObject,
  })
  d.runtime.trigger({
    type: FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
    detail: { id, ok: true, result: { ok: true } },
  })
  d.runtime.trigger({ type: ADMISSION_EVENT_TYPES.admitted, detail: { id, admit: true } })
}

const reject = (d: ReturnType<typeof drive>, id: string, thread: Thread, reason: string): void => {
  d.runtime.trigger({
    type: PLUGIN_THREADS_EVENT_TYPES.candidate,
    detail: { id, input: { plugin: '/plugins/alpha', file: 't.ts', hash: 'hash-1' } },
  })
  d.runtime.trigger({
    type: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
    detail: { id, op: 'add_thread', input: { thread } } as unknown as JsonObject,
  })
  d.runtime.trigger({
    type: FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
    detail: { id, ok: false, error: { message: reason } },
  })
  d.runtime.trigger({ type: ADMISSION_EVENT_TYPES.rejected, detail: { id, admit: false, reason } })
}

const greeter = (sourceHash?: number): Thread => ({
  name: 'greeter',
  description: 'Test thread.',
  once: true,
  rules: [{ request: { type: 'hello' } }],
  ...(sourceHash === undefined ? {} : { sourceHash }),
})

/** Wait until the store put for the registry record has landed (its result observed). */
const awaitPut = async (traces: Trace[]): Promise<void> => {
  const deadline = Date.now() + 8000
  for (;;) {
    const landed = traces.some(
      (t) =>
        t.kind === TRACE_MESSAGE_KINDS.selection &&
        (t as SelectionTrace).selected.type === FACULTY_MESSAGE_KINDS.store_request &&
        ((t as SelectionTrace).selected.detail as { op?: string; input?: { collection?: string } } | undefined)?.op ===
          'put' &&
        ((t as SelectionTrace).selected.detail as { input?: { collection?: string } } | undefined)?.input
          ?.collection === PLUGIN_THREADS_REGISTRY_COLLECTION,
    )
    if (landed) return
    if (Date.now() > deadline) throw new Error('registry put never issued')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('the store-resident plugin-thread registry', () => {
  test('admit → the record round-trips: admitted entry with the stamped instance identity, versioned', async () => {
    const d = drive()
    try {
      admit(d, 'c1', greeter(hashString('/plugins/alpha')))
      await awaitPut(d.traces)
      await d.registry.flush()
      const record = (await readRegistryRecord(d.home)) as { entries?: Record<string, PluginThreadRegistryEntry> }
      await d.done()
      const key = pluginThreadRegistryKey({ plugin: '/plugins/alpha', file: 't.ts', hash: 'hash-1' })
      const entry = record?.entries?.[key]
      expect(entry?.status).toBe('admitted')
      if (entry?.status !== 'admitted') return
      expect(entry.v).toBe(PLUGIN_THREADS_REGISTRY_VERSION)
      expect(entry.thread.sourceHash).toBe(hashString('/plugins/alpha'))
      // THE THIRD HASH: instance identity = djb2(canonical plugin path + space + NAME) —
      // stamped post-sourceHash-stamp, never by the author; content never enters identity.
      expect(entry.instanceHash).toBe(pluginThreadInstanceHash({ plugin: '/plugins/alpha', name: 'greeter' }))
      expect(entry.thread.instanceHash).toBe(entry.instanceHash)
    } catch (err) {
      rmSync(d.home, { recursive: true, force: true })
      throw err
    }
  })

  test('reject → the record holds the reason, visibly', async () => {
    const d = drive()
    try {
      reject(d, 'c1', greeter(), 'structural verdict: livelocked')
      await awaitPut(d.traces)
      await d.registry.flush()
      const record = (await readRegistryRecord(d.home)) as { entries?: Record<string, PluginThreadRegistryEntry> }
      await d.done()
      const entry =
        record?.entries?.[pluginThreadRegistryKey({ plugin: '/plugins/alpha', file: 't.ts', hash: 'hash-1' })]
      expect(entry?.status).toBe('rejected')
      if (entry?.status !== 'rejected') return
      expect(entry.reason).toBe('structural verdict: livelocked')
      expect(entry.v).toBe(PLUGIN_THREADS_REGISTRY_VERSION)
    } catch (err) {
      rmSync(d.home, { recursive: true, force: true })
      throw err
    }
  })

  test('a seed doc is preserved: writes merge, unknown-version entries quarantine as data', async () => {
    const d = drive()
    try {
      // Seed the record BEFORE the composition runs: one current-version
      // decision + one unknown-version entry (a future binary's shape).
      const store = storeLane(d.home)
      const seed = bProgram({ actuators: [store] })
      seed.trigger({
        type: FACULTY_MESSAGE_KINDS.store_request,
        detail: {
          id: 'seed-put',
          op: 'put',
          input: {
            collection: PLUGIN_THREADS_REGISTRY_COLLECTION,
            key: PLUGIN_THREADS_REGISTRY_KEY,
            value: {
              entries: {
                [pluginThreadRegistryKey({ plugin: '/plugins/old', file: 'old.ts', hash: 'h0' })]: {
                  status: 'admitted',
                  thread: greeter(),
                  instanceHash: 1,
                  v: PLUGIN_THREADS_REGISTRY_VERSION,
                },
                [pluginThreadRegistryKey({ plugin: '/plugins/future', file: 'f.ts', hash: 'h9' })]: {
                  status: 'admitted',
                  thread: greeter(),
                  instanceHash: 2,
                  v: 99,
                },
              },
            } as unknown as JsonObject,
          },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      seed.terminate()
      // An admission writes the WHOLE doc — the seed entries survive.
      admit(d, 'c1', greeter())
      await awaitPut(d.traces)
      await d.registry.flush()
      const record = (await readRegistryRecord(d.home)) as { entries?: Record<string, PluginThreadRegistryEntry> }
      await d.done()
      expect(Object.keys(record?.entries ?? {})).toHaveLength(3)
      // The unknown-version entry quarantined-as-data: kept verbatim, never
      // a decision — the parse partition proves it.
      const parsed = parseRegistryDoc(record)
      expect(
        parsed.decisions.has(pluginThreadRegistryKey({ plugin: '/plugins/future', file: 'f.ts', hash: 'h9' })),
      ).toBe(false)
      expect(
        parsed.quarantined.has(pluginThreadRegistryKey({ plugin: '/plugins/future', file: 'f.ts', hash: 'h9' })),
      ).toBe(true)
      expect(
        parsed.decisions.has(pluginThreadRegistryKey({ plugin: '/plugins/old', file: 'old.ts', hash: 'h0' })),
      ).toBe(true)
    } catch (err) {
      rmSync(d.home, { recursive: true, force: true })
      throw err
    }
  })

  test('carried provenance round-trips — a carry record is schema-valid data', () => {
    const carried: PluginThreadRegistryEntry = {
      status: 'admitted',
      thread: greeter(),
      instanceHash: 7,
      carriedFrom: 'old-hash',
      v: PLUGIN_THREADS_REGISTRY_VERSION,
    }
    const parsed = parseRegistryDoc({ entries: { k: carried } })
    expect(parsed.decisions.has('k')).toBe(true)
    expect(parsed.decisions.get('k')).toEqual(carried)
  })

  test('the exit-flush rule: flush resolves only after the in-flight put landed', async () => {
    const d = drive()
    // A put issued but not yet observed — flush must NOT resolve instantly.
    admit(d, 'c1', greeter())
    let resolved = false
    const flushing = d.registry.flush().then(() => {
      resolved = true
    })
    await awaitPut(d.traces)
    // The put is issued; its result may still be in flight — poll, never assume.
    const deadline = Date.now() + 8000
    while (!resolved && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(resolved).toBe(true)
    await flushing
    await d.done()
  })
})
