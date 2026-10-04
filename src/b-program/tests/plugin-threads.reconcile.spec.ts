/**
 * The boot reconciliation — core threads over existing actuators: the
 * store-resident registry record diffs against the plugin files on disk
 * (stat + sha256 via the shell `run` op), per entry:
 *
 * - file missing → the host leg removes the instance hash LIVE and the
 *   record is marked `removed` (visible, never silently dropped);
 * - file unchanged (hash match) → the snapshot mounts — NEVER re-imported;
 * - file changed → re-import once (the landed import script, the ONE
 *   execution moment) → deepEqual per export vs the stored snapshot:
 *   identical → the verdict CARRIES forward (a new record under the new
 *   file-hash key, the old verdict, `carriedFrom` provenance — never
 *   silent); different → the full landed proposal path re-adjudicates.
 *
 * All joins ride ctx.echo (threads are stateless). The mount is the
 * HOST-LEG MINT (the ui-dispatcher precedent): the composition addThreads
 * the snapshot on the verified-unchanged verdict, stamped exactly as
 * admitted (the mount scope is the admission's, never the author's).
 *
 * THIS IS the cross-run admission skip: an unchanged admission mounts from
 * its snapshot at boot with no import and no judgment.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTUATOR_MESSAGE_KINDS } from '../../actuators/actuators.constants.ts'
import {
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateStoreRequestEvent,
} from '../../actuators/actuators.schemas.ts'
import { useActuator } from '../../actuators/use-actuator.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type {
  JsonObject,
  SelectionTrace,
  Thread,
  ThreadRemovedTrace,
  Trace,
} from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { startDecisionsServer } from '../../faculties/tests/fixtures/decisions-server.ts'
import { hashString } from '../../utils.ts'
import { bProgram } from '../b-program.ts'
import { pluginThreadsReconcileThreads } from '../plugin-threads.reconcile.ts'
import {
  PLUGIN_THREADS_REGISTRY_COLLECTION,
  PLUGIN_THREADS_REGISTRY_KEY,
  PLUGIN_THREADS_REGISTRY_VERSION,
  pluginThreadInstanceHash,
  pluginThreadRegistryKey,
  watchPluginThreadRegistry,
} from '../plugin-threads.registry.ts'
import { pluginThreadsThreads } from '../plugin-threads.threads.ts'

// ── The harness — real store + shell actuators, per-spec temp home ───────────

const shellLane = (home: string) =>
  useActuator({
    command: ['bun', 'run', 'shell.actuator.ts'],
    name: 'shell',
    env: { BEHAVIORAL_HOME: home },
    validateRequest: validateShellRequestEvent,
    validateCancel: validateShellCancelEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
  })

const storeLane = (home: string) =>
  useActuator({
    command: ['bun', 'run', 'store.actuator.ts'],
    name: 'store',
    env: { BEHAVIORAL_HOME: home },
    validateRequest: validateStoreRequestEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
  })

/** The record seed — written through a direct store put before the composition boots. */
const seedRegistry = async (home: string, entries: Record<string, unknown>): Promise<void> => {
  const store = storeLane(home)
  const seed = bProgram({ actuators: [store] })
  seed.start()
  seed.trigger({
    type: FACULTY_MESSAGE_KINDS.store_request,
    detail: {
      id: 'seed-put',
      op: 'put',
      input: {
        collection: PLUGIN_THREADS_REGISTRY_COLLECTION,
        key: PLUGIN_THREADS_REGISTRY_KEY,
        value: { entries } as unknown as JsonObject,
      },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  seed.terminate()
}

/** The record reader — a second store spawn against the same home db. */
const readRegistryEntries = async (home: string): Promise<Record<string, Record<string, unknown>>> => {
  const store = storeLane(home)
  const results: Array<Record<string, unknown>> = []
  const probe = bProgram({ actuators: [store] })
  probe.useTrace((trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection) results.push(trace.selected.detail as Record<string, unknown>)
  })
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
    const found = results.find((d) => d.id === 'record-read' && d.ok !== undefined)
    if (found !== undefined) {
      probe.terminate()
      return ((found.result as { value?: { entries?: Record<string, Record<string, unknown>> } } | undefined)?.value
        ?.entries ?? {}) as Record<string, Record<string, unknown>>
    }
    if (Date.now() > deadline) throw new Error('registry record never read back')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** The current sha256 of a plugin thread file — the record key's hash dimension. */
export const fileHash = async (path: string): Promise<string> =>
  (
    await Bun.$`bun -e 'const { CryptoHasher } = require("bun"); process.stdout.write(new CryptoHasher("sha256").update(await Bun.file(process.argv[1]).text()).digest("hex"))' ${path}`
      .quiet()
      .nothrow()
  )
    .text()
    .trim()

const greeterSnapshot = (plugin: string, request: string, instanceHash: number): Thread => ({
  name: 'greeter',
  description: 'Test thread.',
  once: true,
  rules: [{ request: { type: request } }],
  sourceHash: hashString(plugin),
  instanceHash,
})

/**
 * The reconciliation world: a temp home, a plugin file on disk (the given
 * body), the record seeded (the builder receives the file path and mints the
 * entries — the record must hash the REAL file), the composition with
 * shell+store + the reconcile pack + the watcher.
 */
const reconcileWorld = async ({
  threadBody,
  seedEntries,
  systemOne,
}: {
  threadBody: string
  seedEntries: (w: { plugin: string; threadPath: string }) => Promise<Record<string, unknown>>
  systemOne?: { url: string }
}): Promise<{
  home: string
  plugin: string
  threadPath: string
  runtime: ReturnType<typeof bProgram>
  traces: Trace[]
  registry: { flush: () => Promise<void> }
  cleanup: () => Promise<void>
}> => {
  const home = mkdtempSync(join(tmpdir(), 'reconcile-spec-'))
  const plugin = mkdtempSync(join(tmpdir(), 'reconcile-plugin-'))
  const threadPath = join(plugin, 'sh.behavioral/threads/t.ts')
  mkdirSync(join(plugin, 'sh.behavioral/threads'), { recursive: true })
  writeFileSync(threadPath, threadBody)
  await seedRegistry(home, await seedEntries({ plugin, threadPath }))
  const traces: Trace[] = []
  const runtime = bProgram({
    actuators: [shellLane(home), storeLane(home)],
    ...(systemOne === undefined
      ? {}
      : { models: { systemOne: { default: { url: systemOne.url } } as unknown as JsonObject } }),
    threads: [...pluginThreadsThreads, ...pluginThreadsReconcileThreads],
  })
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  const registry = watchPluginThreadRegistry({ runtime })
  runtime.start()
  return {
    home,
    plugin,
    threadPath,
    runtime,
    traces,
    registry,
    cleanup: async (): Promise<void> => {
      await registry.flush()
      runtime.terminate()
      rmSync(home, { recursive: true, force: true })
      rmSync(plugin, { recursive: true, force: true })
    },
  }
}

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const waitForTraces = async (traces: Trace[], until: (s: SelectionTrace[]) => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for traces; saw: ${JSON.stringify(traces.map((t) => t.kind))}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const threadAdded = (traces: Trace[], name: string): Trace[] =>
  traces.filter(
    (t) => t.kind === TRACE_MESSAGE_KINDS.thread_added && (t as { thread?: { name?: string } }).thread?.name === name,
  )

const body = (request: string, decorate = ''): string =>
  `${decorate}export const greeter = { name: 'greeter',        description: 'Test thread.', once: true, rules: [{ request: { type: '${request}' } }] }\n`

const pluginThreadsShellRequests = (traces: Trace[]): SelectionTrace[] =>
  selectionsOf(traces).filter(
    (t) =>
      t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
      // The PROPOSAL path's import label exactly — the reconciliation's own
      // stat/import ops carry the distinct `plugin-threads-reconcile` label.
      (t.selected.detail as { label?: string } | undefined)?.label === 'plugin-threads',
  )

describe('the boot reconciliation — unchanged mount', () => {
  test('an unchanged admission mounts its snapshot at boot with NO import and NO judgment — the cross-run skip', async () => {
    const w = await reconcileWorld({
      threadBody: body('hello'),
      seedEntries: async ({ plugin, threadPath }) => {
        const hash = await fileHash(threadPath)
        const instanceHash = pluginThreadInstanceHash({ plugin, name: 'greeter' })
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash })]: {
            status: 'admitted',
            thread: greeterSnapshot(plugin, 'hello', instanceHash),
            instanceHash,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
        }
      },
    })
    try {
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      // The mount is stamped exactly as admitted: the snapshot's own umwelt
      // (root here) and the instance identity ride the thread.
      const added = threadAdded(w.traces, 'greeter').at(-1) as { thread?: Thread }
      expect(added.thread?.instanceHash).toBe(pluginThreadInstanceHash({ plugin: w.plugin, name: 'greeter' }))
      // NO import: zero plugin-threads-labeled shell requests — the snapshot
      // mounted from the record, never re-imported.
      expect(pluginThreadsShellRequests(w.traces)).toHaveLength(0)
      // NO judgment: zero frontier add_thread proposals — the cross-run skip.
      expect(
        selectionsOf(w.traces).filter(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request &&
            (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
        ),
      ).toHaveLength(0)
      // The record is untouched by an unchanged pass.
      expect(Object.keys(await readRegistryEntries(w.home))).toHaveLength(1)
    } finally {
      await w.cleanup()
    }
  }, 20_000)
})

describe('the boot reconciliation — the two-tier diff', () => {
  test('a cosmetic rewrite CARRIES the verdict: no systemOne Decision paid, the new record rides carriedFrom, the snapshot mounts', async () => {
    const server = await startDecisionsServer()
    let h1 = ''
    const w = await reconcileWorld({
      threadBody: body('hello'),
      systemOne: { url: server.url },
      seedEntries: async ({ plugin, threadPath }) => {
        h1 = await fileHash(threadPath)
        const instanceHash = pluginThreadInstanceHash({ plugin, name: 'greeter' })
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash: h1 })]: {
            status: 'admitted',
            thread: greeterSnapshot(plugin, 'hello', instanceHash),
            instanceHash,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
        }
      },
    })
    try {
      // THE COSMETIC REWRITE: a comment line — bytes change, content does not.
      const h2 = await (async (): Promise<string> => {
        writeFileSync(w.threadPath, body('hello', '// a cosmetic comment\n'))
        return fileHash(w.threadPath)
      })()
      expect(h2).not.toBe(h1)
      // Re-run the reconciliation over the changed file (the reload slice's
      // mechanism; boot already reconciled the unchanged file).
      w.runtime.trigger({ type: 'plugin_threads_reconcile', detail: { id: 'spec-carry' } })
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      // ZERO systemOne Decisions: the carry never re-judges formatting churn.
      expect(selectionsOf(w.traces).filter((t) => t.selected.type === 'system_one_request')).toHaveLength(0)
      // The record: the NEW file-hash key carries the OLD verdict forward,
      // provenance visible; the old entry stays (history).
      const entries = await readRegistryEntries(w.home)
      const carriedEntry = entries[pluginThreadRegistryKey({ plugin: w.plugin, file: 't.ts', hash: h2 })]
      expect(carriedEntry?.status).toBe('admitted')
      expect(carriedEntry?.carriedFrom).toBe(h1)
      expect(entries[pluginThreadRegistryKey({ plugin: w.plugin, file: 't.ts', hash: h1 })]?.status).toBe('admitted')
      // The mount: the snapshot's instance identity rides (removal-addressable).
      const added = threadAdded(w.traces, 'greeter').at(-1) as { thread?: Thread }
      expect(added.thread?.instanceHash).toBe(pluginThreadInstanceHash({ plugin: w.plugin, name: 'greeter' }))
    } finally {
      await w.cleanup()
      await server.close()
    }
  }, 30_000)

  test('a semantic rewrite re-adjudicates: the landed proposal path runs, the new thread goes live', async () => {
    const w = await reconcileWorld({
      threadBody: body('hello'),
      seedEntries: async ({ plugin, threadPath }) => {
        const h1 = await fileHash(threadPath)
        const instanceHash = pluginThreadInstanceHash({ plugin, name: 'greeter' })
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash: h1 })]: {
            status: 'admitted',
            thread: greeterSnapshot(plugin, 'hello', instanceHash),
            instanceHash,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
        }
      },
    })
    try {
      // THE SEMANTIC REWRITE: the requested event changes — new thread code.
      writeFileSync(w.threadPath, body('hello2'))
      w.runtime.trigger({ type: 'plugin_threads_reconcile', detail: { id: 'spec-semantic' } })
      // The proposal path runs: the import (plugin-threads label), the
      // add_thread dispatch, the structural verdict, the live thread.
      await waitForTraces(w.traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request &&
            (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
        ),
      )
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      // The LIVE thread is the NEW code: hello2 selects (the old hello never does).
      await waitForTraces(w.traces, (s) => s.some((t) => t.selected.type === 'hello2'))
      expect(selectionsOf(w.traces).some((t) => t.selected.type === 'hello')).toBe(false)
      // The record: the new-hash entry admitted (the outcome leg wrote it).
      const h2 = await fileHash(w.threadPath)
      const entries = await readRegistryEntries(w.home)
      expect(entries[pluginThreadRegistryKey({ plugin: w.plugin, file: 't.ts', hash: h2 })]?.status).toBe('admitted')
    } finally {
      await w.cleanup()
    }
  }, 30_000)

  test('a deleted plugin tears down LIVE: thread_removed fires mid-run and the record marks removed', async () => {
    // A STANDING fixture (the once-greeter self-exhausts after its request
    // selects — nothing live for the teardown to stop): the waiter parks on
    // its waitFor and stays live until the removal.
    const waiter = (plugin: string, instanceHash: number): Thread => ({
      name: 'greeter',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'go' }] }, { request: { type: 'hello' } }],
      sourceHash: hashString(plugin),
      instanceHash,
    })
    const w = await reconcileWorld({
      threadBody: body('hello'),
      seedEntries: async ({ plugin, threadPath }) => {
        const hash = await fileHash(threadPath)
        const instanceHash = pluginThreadInstanceHash({ plugin, name: 'greeter' })
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash })]: {
            status: 'admitted',
            thread: waiter(plugin, instanceHash),
            instanceHash,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
        }
      },
    })
    try {
      // Boot mounts the snapshot (unchanged).
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      // THE DELETION — the plugin file goes away mid-run.
      rmSync(w.threadPath)
      w.runtime.trigger({ type: 'plugin_threads_reconcile', detail: { id: 'spec-delete' } })
      // LIVE teardown: the mounted instance comes down via removeThread —
      // the engine's thread_removed trace, no reboot. (A TRACE-level wait —
      // thread_removed is not a selection.)
      const deadline = Date.now() + 15_000
      while (!w.traces.some((x) => x.kind === TRACE_MESSAGE_KINDS.thread_removed)) {
        if (Date.now() > deadline) throw new Error('thread_removed never fired')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const removed = w.traces.find((x): x is ThreadRemovedTrace => x.kind === TRACE_MESSAGE_KINDS.thread_removed)
      expect(removed?.thread.name).toBe('greeter')
      expect(removed?.instanceHash).toBe(pluginThreadInstanceHash({ plugin: w.plugin, name: 'greeter' }))
      // The record marks removed — visible, never silently dropped.
      const entries = await readRegistryEntries(w.home)
      const removedEntry = Object.values(entries).find((e) => e?.status === 'removed')
      expect(removedEntry).toBeDefined()
      expect(removedEntry?.v).toBe(PLUGIN_THREADS_REGISTRY_VERSION)
    } finally {
      await w.cleanup()
    }
  }, 30_000)

  test('the reload ingress re-runs the reconciliation MID-RUN: a changed plugin mounts without reboot', async () => {
    // A STANDING snapshot parks on its waitFor — nothing selects at boot, so
    // the reload's live evidence is unambiguous.
    const waiter = (plugin: string, instanceHash: number): Thread => ({
      name: 'greeter',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'go' }] }, { request: { type: 'hello' } }],
      sourceHash: hashString(plugin),
      instanceHash,
    })
    const w = await reconcileWorld({
      threadBody: body('hello'),
      seedEntries: async ({ plugin, threadPath }) => {
        const hash = await fileHash(threadPath)
        const instanceHash = pluginThreadInstanceHash({ plugin, name: 'greeter' })
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash })]: {
            status: 'admitted',
            thread: waiter(plugin, instanceHash),
            instanceHash,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
        }
      },
    })
    try {
      // Boot mounts the snapshot (the unchanged verdict) — parked, silent.
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      // THE SEMANTIC CHANGE — mid-run, no reboot.
      writeFileSync(w.threadPath, body('hello2'))
      w.runtime.trigger({ type: 'plugin_threads_reload', detail: { id: 'reload-1' } })
      // The landed proposal path re-adjudicates; the new code goes live.
      await waitForTraces(w.traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request &&
            (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
        ),
      )
      await waitForTraces(w.traces, (s) => s.some((t) => t.selected.type === 'hello2'))
      expect(selectionsOf(w.traces).some((t) => t.selected.type === 'hello')).toBe(false)
    } finally {
      await w.cleanup()
    }
  }, 30_000)

  test('the reload ingress tears a deleted plugin down MID-RUN without reboot', async () => {
    const waiter = (plugin: string, instanceHash: number): Thread => ({
      name: 'greeter',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'go' }] }, { request: { type: 'hello' } }],
      sourceHash: hashString(plugin),
      instanceHash,
    })
    const w = await reconcileWorld({
      threadBody: body('hello'),
      seedEntries: async ({ plugin, threadPath }) => {
        const hash = await fileHash(threadPath)
        const instanceHash = pluginThreadInstanceHash({ plugin, name: 'greeter' })
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash })]: {
            status: 'admitted',
            thread: waiter(plugin, instanceHash),
            instanceHash,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
        }
      },
    })
    try {
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      rmSync(w.threadPath)
      w.runtime.trigger({ type: 'plugin_threads_reload', detail: { id: 'reload-2' } })
      const deadline = Date.now() + 15_000
      while (!w.traces.some((x) => x.kind === TRACE_MESSAGE_KINDS.thread_removed)) {
        if (Date.now() > deadline) throw new Error('thread_removed never fired')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const removed = w.traces.find((x): x is ThreadRemovedTrace => x.kind === TRACE_MESSAGE_KINDS.thread_removed)
      expect(removed?.thread.name).toBe('greeter')
      // The record marks removed.
      const entries = await readRegistryEntries(w.home)
      expect(Object.values(entries).some((e) => e?.status === 'removed')).toBe(true)
    } finally {
      await w.cleanup()
    }
  }, 30_000)

  test('a umwelt-stamped record mounts stamped exactly as admitted; unknown versions never reconcile', async () => {
    const w = await reconcileWorld({
      threadBody: body('hello'),
      seedEntries: async ({ plugin, threadPath }) => {
        const hash = await fileHash(threadPath)
        return {
          [pluginThreadRegistryKey({ plugin, file: 't.ts', hash, umwelt: 's1' })]: {
            status: 'admitted',
            thread: { ...greeterSnapshot(plugin, 'hello', 123), umwelt: 's1' },
            instanceHash: 123,
            v: PLUGIN_THREADS_REGISTRY_VERSION,
          },
          [pluginThreadRegistryKey({ plugin, file: 'future.ts', hash: 'h9' })]: {
            status: 'admitted',
            thread: greeterSnapshot(plugin, 'hello', 456),
            instanceHash: 456,
            v: 99,
          },
        }
      },
    })
    try {
      await waitForTraces(w.traces, () => threadAdded(w.traces, 'greeter').length > 0)
      // The mount scope is the ADMISSION's: stamped s1, never the author's —
      // and the stamped thread is removal-addressable.
      const added = threadAdded(w.traces, 'greeter').at(-1) as { thread?: Thread }
      expect(added.thread?.umwelt).toBe('s1')
      expect(added.thread?.instanceHash).toBe(123)
      // The unknown-version entry never reconciled: no stat ran for it, and
      // its thread never mounted.
      expect(pluginThreadsShellRequests(w.traces)).toHaveLength(0)
      expect(threadAdded(w.traces, 'greeter')).toHaveLength(1)
    } finally {
      await w.cleanup()
    }
  }, 30_000)
})
