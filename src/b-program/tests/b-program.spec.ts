import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTUATOR_MESSAGE_KINDS } from '../../actuators/actuators.constants.ts'
import {
  validateSecurityCancelEvent,
  validateSecurityRequestEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateStoreRequestEvent,
} from '../../actuators/actuators.schemas.ts'
import { useActuator } from '../../actuators/use-actuator.ts'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import {
  ADMISSION_PROGRESS,
  admissionCandidateMintThreads,
  admissionStructuralOutcomeThreads,
} from '../../faculties/frontier-analysis.threads.ts'
import {
  ADMISSION_EVENT_TYPES,
  admissionJudgmentThreads,
  SUPERVISION_EVENT_TYPES,
  supervisionJudgmentThreads,
  supervisionRecoveryThreads,
  supervisionThreads,
} from '../../faculties/system-one.threads.ts'
import { startDecisionsServer } from '../../faculties/tests/fixtures/decisions-server.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from '../../faculties/tests/fixtures/model-server.ts'
import { hashString } from '../../utils.ts'
import { bProgram, type LaneBuilder } from '../b-program.ts'
import { pluginThreadsReconcileThreads } from '../plugin-threads.reconcile.ts'
import {
  PLUGIN_THREADS_REGISTRY_COLLECTION,
  PLUGIN_THREADS_REGISTRY_KEY,
  PLUGIN_THREADS_REGISTRY_VERSION,
  pluginThreadInstanceHash,
  watchPluginThreadRegistry,
} from '../plugin-threads.registry.ts'
import { PLUGIN_THREADS_EVENT_TYPES, pluginThreadsThreads } from '../plugin-threads.threads.ts'
import {
  REMOTE_MCP_EVENT_TYPES,
  REMOTE_MCP_PROTOCOL_VERSION,
  REMOTE_MCP_STORE_COLLECTION,
  remoteMcpThreads,
} from '../remote-mcp.threads.ts'
import { rpcAuthThreads } from '../rpc-auth.threads.ts'
import { shellThreads } from '../shell.threads.ts'

/**
 * bProgram — the runtime composition — through its REAL surface: the
 * spec builds the lanes exactly as the host entry does (useActuator
 * builders), mints the reachability-gated packs, folds the registry, and
 * wires the durable-write watcher. The host attaches ingress and
 * observation through the returned handle — `runtime.trigger(...)`
 * and `runtime.useTrace(...)`.
 *
 * Lifecycle note: the composition does NOT flush its deferred thread mounts at
 * construction. The host subscribes (`runtime.useTrace`), then calls
 * `runtime.start()` — the flush runs after subscribers attach, so boot-cascade
 * selection traces (e.g. the skill-scan `shell_request`) are observable.
 * `runtime.trigger` auto-starts (idempotent), so a host that never calls
 * `start()` still boots on its first event.
 *
 * The default threads are faculty-shipped: the shell threads
 * (shell/threads.ts — skill/plugin scans + links) mounts with shell+store
 * on; the remote-mcp threads mounts with shell+security+store on.
 */

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const waitForTraces = async (
  traces: Trace[],
  until: (selections: SelectionTrace[]) => boolean,
  // The worker-lane world boots three workers per composition (the old embed
  // was in-process) — the fail-fast deadline widens to match the choreography.
  timeoutMs = 15_000,
) => {
  const deadline = Date.now() + timeoutMs
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for traces; saw: ${JSON.stringify(traces.map((t) => t.kind))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Find a selected store_request by op and collection. */
/** Find a selected store_request by op and collection. */
const storeRequest = (traces: Trace[], op: string, collection: string): SelectionTrace | undefined =>
  selectionsOf(traces).find((t) => {
    if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
    const detail = t.selected.detail as { op?: string; input?: { collection?: string } } | undefined
    return detail?.op === op && detail?.input?.collection === collection
  })

// The admission policy rides the MINT (the orchestration ruling): the route
// seam no longer enriches, so a direct trigger carries the derived progress
// vocabulary itself (the carry pack composes it on the real proposal path).
// The `maxDepth` in the fixtures exercises the requester override — passed
// through unchanged below the ceiling. Shared by the admission-path and the
// outage-shape describes.
const addThreadRequest = (id: string, thread: JsonObject, extra?: JsonObject): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
  detail: {
    id,
    op: 'add_thread',
    input: { thread, progress: ADMISSION_PROGRESS, maxDepth: 8, ...extra },
  },
})

/** A spec lane: the name rides beside the builder (the composition routes by it). */
type SpecLane = { name: 'shell' | 'store' | 'security'; build: LaneBuilder }

/** The spec's actuator lanes — built exactly as the host entry builds them (useActuator). */
const shellLane = (env?: Record<string, string>): SpecLane => ({
  name: 'shell',
  build: useActuator({
    command: ['bun', 'run', 'shell.actuator.ts'],
    name: 'shell',
    ...(env === undefined ? {} : { env }),
    validateRequest: validateShellRequestEvent,
    validateCancel: validateShellCancelEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
  }),
})

const storeLane = (env?: Record<string, string>): SpecLane => ({
  name: 'store',
  build: useActuator({
    command: ['bun', 'run', 'store.actuator.ts'],
    name: 'store',
    ...(env === undefined ? {} : { env }),
    // No cancel contract — the request schema is the gate.
    validateRequest: validateStoreRequestEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.store_request_result,
  }),
})

const securityLane = (env?: Record<string, string>): SpecLane => ({
  name: 'security',
  build: useActuator({
    command: ['bun', 'run', 'security.actuator.ts'],
    name: 'security',
    ...(env === undefined ? {} : { env }),
    validateRequest: validateSecurityRequestEvent,
    validateCancel: validateSecurityCancelEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.credential_result,
  }),
})

/** The probe-fixture shell lane — crash/echo shapes the REAL shell never produces. */
const probeShellLane = (): SpecLane => ({
  name: 'shell',
  build: useActuator({
    command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
    name: 'shell',
    validateRequest: validateShellRequestEvent,
    validateCancel: validateShellCancelEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
  }),
})

/** The pack mint — the entry's reachability conditions, mirrored for the default world. */
const packsFor = (names: Set<string>): Thread[] => {
  const packs: Thread[] = []
  if (names.has('shell') && names.has('store')) packs.push(...shellThreads)
  if (names.has('shell')) packs.push(...pluginThreadsThreads)
  if (names.has('shell') && names.has('store')) packs.push(...pluginThreadsReconcileThreads)
  if (names.has('shell') && names.has('security')) packs.push(...rpcAuthThreads)
  if (names.has('shell') && names.has('security') && names.has('store')) packs.push(...remoteMcpThreads)
  return packs
}

/**
 * Construct the composition, attach observation, then start (the boot flush).
 * The default world: all three actuator lanes + their reachability-gated
 * packs + the registry watcher (the entry's durable-write legs) — the full
 * entry constructor, in spec miniature.
 *
 * THE TEMP-HOME TRIPWIRE: every lane boots against a per-call temp home via
 * the spawn env-override pattern (`env: { BEHAVIORAL_HOME: <temp> }` —
 * explicit threading, never runtime mutation). The terminate wrapper removes
 * the home, so no spec leaks store-db debris into the real home.
 */
export const startRuntime = (
  options: {
    actuators?: SpecLane[]
    threads?: Thread[]
    models?: Parameters<typeof bProgram>[0]['models']
    /** Caller-owned home — shared across runs (multi-run choreographies); the caller cleans it. */
    home?: string
    /** The outage shape's scheduler seam — the tests drive the timers deterministically. */
    scheduler?: Parameters<typeof bProgram>[0]['scheduler']
  } = {},
) => {
  const callerHome = options.home
  const home = callerHome ?? mkdtempSync(join(tmpdir(), 'bprogram-spec-'))
  const env = { BEHAVIORAL_HOME: home }
  const traces: Trace[] = []
  const lanes = options.actuators ?? [shellLane(env), storeLane(env), securityLane(env)]
  const names = new Set(lanes.map((lane) => lane.name))
  const runtime = bProgram({
    actuators: lanes.map((lane) => lane.build),
    threads: [...(options.threads ?? []), ...packsFor(names)],
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  })
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  const registry = names.has('store') ? watchPluginThreadRegistry({ runtime }) : undefined
  runtime.start()
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await registry?.flush()
    runtime.terminate()
    if (callerHome === undefined) rmSync(home, { recursive: true, force: true })
  }
  return {
    runtime: {
      ...runtime,
      // Terminate stays SYNCHRONOUS (the lanes die with the call — the
      // ownership pin); the temp-home sweep rides after it.
      terminate: (): void => {
        runtime.terminate()
        if (callerHome === undefined) rmSync(home, { recursive: true, force: true })
      },
    },
    traces,
    home,
    registry,
    cleanup,
  }
}

describe('bProgram — the runtime composition', () => {
  test('the shell threads ship with the shell faculty: the skill scan self-starts through the composition', async () => {
    const { runtime, traces } = startRuntime()
    try {
      // The skill scan boot is part of the shell threads — starting the
      // composition is enough to start it (no host trigger). Because the
      // subscriber attaches BEFORE `start()`, the boot selection trace is
      // observable…
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'skill-scan-catalog',
        ),
      )
      // …the recipe runs bun-direct… …and the catalog put re-enters (store
      // default-on), gated by the catalog schema. (The links seeder also puts
      // into skill-recipes — match by collection.)
      await waitForTraces(traces, (s) => storeRequest(s, 'put', 'skills') !== undefined)
      const put = storeRequest(selectionsOf(traces), 'put', 'skills')
      const input = (put?.selected.detail as { input?: { collection?: string; key?: string } } | undefined)?.input
      expect(input?.collection).toBe('skills')
      expect(input?.key).toBe('catalog')
    } finally {
      runtime.terminate()
    }
  })

  test('a clean boot is trace-clean — successful shell results fire no declined transform noise', async () => {
    const { runtime, traces } = startRuntime()
    try {
      // The boot runs successful shell ops (the skill scan, the plugin
      // manifests) through a composition whose failure-path listeners
      // (rpc-auth, remote-mcp) are mounted. Their gates match only
      // failure-shaped details, so the successes they used to match (then
      // decline — 8 per boot in the retired transform_error era) never fire.
      // Mint semantics: the declined outcome is the ok:false RESULT selection
      // (the transform_error trace kind retired with the engine switch).
      await waitForTraces(traces, (s) => storeRequest(s, 'put', 'skills') !== undefined)
      const declined = selectionsOf(traces).filter(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.transform_request_result &&
          (t.selected.detail as { ok?: boolean })?.ok === false,
      )
      expect(declined).toHaveLength(0)
    } finally {
      runtime.terminate()
    }
  })

  test('a full round-trip via the default threads: links_request → run op → result re-entry', async () => {
    const { runtime, traces } = startRuntime()
    try {
      runtime.trigger({
        type: 'links_request',
        detail: { id: 'l1', recipe: 'extract-links', input: { markdown: 'See [a](a.ts)' } },
      })
      // Match l1's result — the scan boots' results also re-enter.
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'l1',
        ),
      )
      const result = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'l1',
      )
      const detail = result?.selected.detail as
        | { ok?: boolean; result?: { jsonData?: { links?: Array<{ value: string; text: string }> } } }
        | undefined
      expect(detail?.ok).toBe(true)
      expect(detail?.result?.jsonData).toEqual({ links: [{ value: 'a.ts', text: 'a' }] })
    } finally {
      runtime.terminate()
    }
  })

  test('the actuators allow-list prunes actuators: without shell, no route — a triggered shell_request is never answered', async () => {
    const { runtime, traces } = startRuntime({ actuators: [storeLane()] })
    try {
      // No shell → no scan boot, no shell_request ever. Settle past any
      // boot cascade the threads could have run.
      await Bun.sleep(500)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
      expect(storeRequest(selectionsOf(traces), 'put', 'skills')).toBeUndefined()
      expect(storeRequest(selectionsOf(traces), 'put', 'skill-recipes')).toBeUndefined()
      // The pruning BOUNDS the arbitrary-execution faculty: a host-injected
      // shell_request (a client can send one) has no route, so it never
      // spawns a process and is never answered.
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'pruned-shell', label: 'probe', input: { op: 'echo' } },
      })
      await Bun.sleep(300)
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'pruned-shell',
        ),
      ).toBe(false)
    } finally {
      runtime.terminate()
    }
  })

  test('a host-constructed probe shell lane takes the shell route', async () => {
    const hostShell = probeShellLane()
    const { runtime, traces } = startRuntime({ actuators: [hostShell] })
    try {
      // A raw shell_request (root ingress — no thread involvement): the
      // satellite fixture answers with {ok:true, value:{op}} — a shape the
      // REAL shell never produces. Its arrival proves the host-constructed
      // lane took the shell route (the composition routes by lane name).
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'ov1', label: 'probe', input: { op: 'echo' } },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { ok?: boolean } | undefined)?.ok === true,
        ),
      )
    } finally {
      runtime.terminate()
    }
  })

  test('a crashed satellite re-enters one faculty_error event', async () => {
    const hostShell = probeShellLane()
    const { runtime, traces } = startRuntime({ actuators: [hostShell] })
    try {
      // The crash fixture throws on its FIRST message — drive one into it.
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'c1', label: 'probe', input: { op: 'die' } },
      })
      await waitForTraces(traces, (s) => s.some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error))
      const crash = selectionsOf(traces).find((t) => t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error)
      expect((crash?.selected.detail as { faculty?: string } | undefined)?.faculty).toBe('shell')
    } finally {
      runtime.terminate()
    }
  })

  test('trigger does not flush deferred thread mounts — start() owns the boot', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({})
    runtime.useTrace((trace) => {
      traces.push(trace)
    })
    try {
      // Without start(), the deferred thread mounts are not flushed: a trigger is
      // admitted (the engine is live) but the shell/mcp boot cascades never run.
      runtime.trigger({ type: 'noop', detail: {} })
      await Bun.sleep(200)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
    } finally {
      runtime.terminate()
    }
  })

  test('the root guard threads is mounted: a malformed ui_* message is blocked', async () => {
    const { runtime, traces } = startRuntime({ actuators: [] })
    try {
      // Invalid ui_render (no html): the guard blocks it, so it never selects and
      // the frontier deadlocks — the reject is visible in the trace.
      runtime.trigger({ type: 'ui_render', detail: { id: 'r1', target: 'main', swap: 'innerHTML' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === 'ui_render')).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
    }
  })

  test('the root guard watches every umwelt: a named-umwelt malformed ui_* message is blocked', async () => {
    const { runtime, traces } = startRuntime({ actuators: [] })
    try {
      // The same invalid ui_render, stamped into s1: the root guard's
      // unstamped block matches every umwelt (Direction/R) — the named-umwelt
      // validation gap is closed with zero new wiring.
      runtime.trigger({ type: 'ui_render', umwelt: 's1', detail: { id: 'r1', target: 'main', swap: 'innerHTML' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === 'ui_render')).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
    }
  })

  describe('the admission ownership guard', () => {
    // The orchestration ruling: the admission packs are COMPOSITION-INTERNAL
    // thread data — every orchestration pack is composition-owned and never
    // host-passable, so the double-mount hazard dies by dissolution. The
    // guard is belt, not load-bearing: a host passing an admission pack
    // throws at CONSTRUCTION, naming the collision.
    test('a host passing a composition-owned admission pack throws at construction, naming the collision', () => {
      expect(() => bProgram({ threads: [...admissionJudgmentThreads] })).toThrow(/composition-owned/)
      expect(() => bProgram({ threads: [...admissionStructuralOutcomeThreads] })).toThrow(/composition-owned/)
      expect(() => bProgram({ threads: [...admissionCandidateMintThreads] })).toThrow(/composition-owned/)
      // A mixed list reports EVERY collision, not just the first.
      try {
        bProgram({ threads: [...admissionCandidateMintThreads, ...admissionJudgmentThreads] })
        throw new Error('unreachable — the mixed list must throw')
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain('frontier/admission-candidate-mint')
        expect(message).toContain('system-one/admission-issue')
      }
    })

    test('distinct host packs construct clean — the guard names only the owned set', async () => {
      const runtime = bProgram({
        threads: [
          {
            name: 'host/probe',
            description: 'A host-minted probe thread.',
            rules: [{ request: { type: 'probe' } }],
          },
        ],
      })
      // Construction succeeded — the guard never fires on host-owned names.
      runtime.terminate()
    })
  })

  describe('add_thread — the admission path', () => {
    const resultDetailFor = (traces: Trace[], id: string) => {
      const sel = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result &&
          (t.selected.detail as { id?: string }).id === id,
      )
      return sel?.selected.detail as { id?: string; ok?: boolean; result?: { ok?: boolean } } | undefined
    }

    test('a valid proposal is admitted: the verdict returns and the thread_added provision fires', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // A once-thread: under the livelock ruling, a looping requester is a
        // rejected proposal (its cycle never selects a progress event), so the
        // minimal valid-proposal fixture is the terminating shape.
        runtime.trigger(
          addThreadRequest('at1', {
            name: 'greeter',
            description: 'Test thread.',
            once: true,
            rules: [{ request: { type: 'ping' } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'at1')
        // The verdict is data: the frontier validated, the composition owns the write.
        expect(detail?.ok).toBe(true)
        expect(detail?.result?.ok).toBe(true)

        // Mint semantics (the transform-faculty ruling): the admitted leg
        // trails the result selection by the async verdict chain — the
        // provision is polled, never read synchronously after the result.
        await waitForTraces(
          traces,
          (s) =>
            selectionsOf(s).length >= 0 &&
            traces.some(
              (t) =>
                t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                (t as { thread?: { name?: string } }).thread?.name === 'greeter',
            ),
        )
        expect(
          traces.find(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'greeter',
          ),
        ).toBeDefined()
      } finally {
        runtime.terminate()
      }
    })

    test('an invalid proposal is rejected data — no admission, no thread_added', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // `rules` missing: the derived Thread-schema gate rejects the whole input.
        runtime.trigger(addThreadRequest('at2', { name: 'broken', description: 'Test thread.' }))
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at2' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'at2')
        expect(detail?.ok).toBe(false)
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'broken',
          ),
        ).toBe(false)
      } finally {
        runtime.terminate()
      }
    })

    test('an admitted thread goes live: its request is a candidate in the next super-step', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // A loop on EXTERNAL releases — the legitimate looping shape under the
        // livelock ruling. Its internal state graph has no self-sustaining
        // cycle (`work` is never internally selected), so it verifies and
        // admits; each external release then advances it one round trip.
        runtime.trigger(
          addThreadRequest('at3', {
            name: 'worker',
            description: 'Test thread.',
            rules: [{ waitFor: [{ type: 'work' }] }, { request: { type: 'done' } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at3' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const at3Detail = resultDetailFor(traces, 'at3')
        expect(at3Detail?.result?.ok).toBe(true)
        // Mint semantics: the admitted mount trails the result selection by
        // the async verdict chain — wait for the provision before the release.
        await waitForTraces(traces, () =>
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'worker',
          ),
        )
        // The candidate→live transition: admission re-enters (addThread + step),
        // and the thread participates — released by an external trigger, it
        // selects its request, then keeps participating: the loop wraps and
        // the next release selects `done` again.
        runtime.trigger({ type: 'work' })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'done'))
        const doneSelections = selectionsOf(traces).filter((t) => t.selected.type === 'done')
        expect(doneSelections.length).toBe(1)
        runtime.trigger({ type: 'work' })
        await waitForTraces(traces, (s) => selectionsOf(s).filter((t) => t.selected.type === 'done').length >= 2)
      } finally {
        runtime.terminate()
      }
    })

    test('a self-sustaining request loop never admits — the verdict carries the livelock finding', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The pilot ruling (2026-09-25): livelock detection is part of adding
        // threads. A thread that re-requests its own next event forever — its
        // cycle never selects a progress event — is rejected at admission,
        // fail-closed. This is the exact shape that overflowed the recursive
        // cascade (~8.6k selections): the guard keeps it out before it runs.
        runtime.trigger(
          addThreadRequest('lk1', {
            name: 'looper',
            description: 'Test thread.',
            rules: [{ request: { type: 'spin' } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'lk1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'lk1')
        // The verdict is data: the op ran (the envelope's ok), but the cycle is
        // a livelock — the verdict leg failed, not verified. The pump's
        // conforming check (envelope ok AND result ok) holds the line.
        expect(detail?.ok).toBe(true)
        expect(detail?.result?.ok).toBe(false)
        // The finding names the cycle — the requester reads the why from the verdict.
        const livelocks = (detail?.result as { livelocks?: { code?: string }[] } | undefined)?.livelocks
        expect(livelocks?.length).toBeGreaterThan(0)
        expect(livelocks?.[0]?.code).toBe('livelock')
        // Fail-closed: it never admits and never goes live — no provision, no spin.
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'looper',
          ),
        ).toBe(false)
        expect(selectionsOf(traces).some((t) => t.selected.type === 'spin')).toBe(false)
      } finally {
        runtime.terminate()
      }
    })
    test('a proposal whose cycle internally selects a progress event still admits — the guard is progress-relative', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The other branch of the ruling: livelock = a cycle that never
        // selects a progress event. A self-sustaining cycle that DOES select
        // one — a faculty result kind, the derived `*_result` vocabulary —
        // verifies and admits. The fixture is `once` by design: a LOOPING
        // result-requester self-sustains at runtime (its own request is the
        // candidate that selects, re-arming the thread inside one cascade —
        // the engine's recursive super-step converts that admitted livelock
        // into a stack overflow; the CI lesson). The `once` shape keeps the
        // verdict path under test — the request still selects a progress
        // event inside its cycle — without the runtime spin.
        runtime.trigger(
          addThreadRequest('lk2', {
            name: 'progress-looper',
            description: 'Test thread.',
            once: true,
            rules: [{ request: { type: FACULTY_MESSAGE_KINDS.store_request_result } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'lk2' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'lk2')
        expect(detail?.result?.ok).toBe(true)
        // Mint semantics: the provision trails the result — polled, never read
        // synchronously after the result wait.
        await waitForTraces(traces, () =>
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'progress-looper',
          ),
        )
        expect(
          traces.find(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'progress-looper',
          ),
        ).toBeDefined()
      } finally {
        runtime.terminate()
      }
    })

    test('a proposal without maxDepth fails the op input validation — the budget lives at the mint, never the seam', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The orchestration ruling: the composition's route-seam budget
        // default is DELETED — the policy composes at the proposal carry's
        // dispatch (the carry-path pins hold the 20k default + the clamp).
        // A direct trigger that omits `maxDepth` passes through unchanged and
        // the op's own validation rejects it — fail-closed, visible as the
        // error envelope, never a silent analysis.
        runtime.trigger({
          type: FACULTY_MESSAGE_KINDS.frontier_analysis_request,
          detail: {
            id: 'md1',
            op: 'add_thread',
            input: {
              thread: {
                name: 'deferred-budget',
                description: 'Test thread.',
                once: true,
                rules: [{ request: { type: 'ping' } }],
              },
            },
          },
        })
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'md1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'md1')
        expect(detail?.ok).toBe(false)
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'deferred-budget',
          ),
        ).toBe(false)
      } finally {
        runtime.terminate()
      }
    })

    test('a requester-supplied maxDepth flows through: a truncated analysis rejects — fail-closed', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The pilot-confirmed tradeoff: the override is honored (the edge-case
        // escape hatch), and truncated never passes — a proposal whose state
        // umwelt cannot be explored within the supplied budget is rejected.
        // The two-rule thread needs more than one exploration level.
        runtime.trigger(
          addThreadRequest(
            'md2',
            {
              name: 'two-step',
              description: 'Test thread.',
              once: true,
              rules: [{ request: { type: 'step_one' } }, { request: { type: 'step_two' } }],
            },
            { maxDepth: 1 },
          ),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'md2' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'md2')
        expect(detail?.result?.ok).toBe(false)
        expect((detail?.result as { status?: string } | undefined)?.status).toBe('truncated')
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'two-step',
          ),
        ).toBe(false)
      } finally {
        runtime.terminate()
      }
    })

    test('the structural admission is BP-native: a conforming verdict maps to a thread_admission selection which admits', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The review is threads (the ruling's shape): the verdict selection is
        // mapped — transform and request — to a thread_admission event, and
        // the pump's admitted leg writes on that SELECTION, not on the raw
        // verdict. Admission is observable in the engine's own traces.
        runtime.trigger(
          addThreadRequest('rv1', {
            name: 'native-greeter',
            description: 'Test thread.',
            once: true,
            rules: [{ request: { type: 'ping' } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'rv1',
          ),
        )
        // The admission is a real event selection — the transform CONSUMED the
        // verdict (it cannot fire without it). The emitted order differs under
        // the worker lane (the re-entry is a fresh macrotask, and the same-step
        // transform target can trace before the trigger's selection trace — an
        // emission-order artifact, causality intact), so the old index-ordering
        // assertion gives way to the presence pair.
        const selections = selectionsOf(traces)
        expect(
          selections.some(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request_result &&
              (t.selected.detail as { id?: string }).id === 'rv1',
          ),
        ).toBe(true)
        // The admitted leg writes on the selection — the provision fires.
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'native-greeter',
          ),
        ).toBe(true)
      } finally {
        runtime.terminate()
      }
    })

    test('the candidate mint is thread data: the candidate is thread-minted and the composition mints nothing', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The orchestration ruling (slice 2): the candidate mint moved OUT of
        // the composition's pump into an always-mounted root-stamped thread
        // over the verdict envelope's echoed thread. The structural flow is
        // proposal → verdict → candidate → admission with ZERO composition
        // mints: the old pump-minted `thread-candidate:<id>` once-thread name
        // never appears, while the candidate still selects (the structural
        // outcome's consumer) and the write leg still admits.
        runtime.trigger(
          addThreadRequest('cm1', {
            name: 'minted-greeter',
            description: 'Test thread.',
            once: true,
            rules: [{ request: { type: 'ping' } }],
          }),
        )
        // The candidate is a real selection — thread-minted (the judgment
        // pack's issue waits on the same selection in judged mode).
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.candidate &&
              (t.selected.detail as { id?: string }).id === 'cm1',
          ),
        )
        // ZERO composition mints: the pump's mint thread name is gone.
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              ((t as { thread?: { name?: string } }).thread?.name ?? '').startsWith('thread-candidate:'),
          ),
        ).toBe(false)
        // The flow completes: the outcome stage admits, the write leg mounts.
        await waitForTraces(traces, () =>
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'minted-greeter',
          ),
        )
      } finally {
        runtime.terminate()
      }
    })

    test('the structural rejection is BP-native: a livelocked proposal maps to a thread_admission_rejected selection', async () => {
      const { runtime, traces } = startRuntime()
      try {
        runtime.trigger(
          addThreadRequest('rv2', {
            name: 'native-looper',
            description: 'Test thread.',
            rules: [{ request: { type: 'spin' } }],
          }),
        )
        // The rejection is a selection stamped with the candidate id — visible
        // in the traces, the requester reads the why from the verdict.
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.rejected && (t.selected.detail as { id?: string }).id === 'rv2',
          ),
        )
        expect(
          selectionsOf(traces).some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'rv2',
          ),
        ).toBe(false)
      } finally {
        runtime.terminate()
      }
    })

    describe('add_thread — the admission judgment (systemOne wired)', () => {
      test('the judged path: the Decision approves, the block lifts, the candidate admits and goes live', async () => {
        const server = await startDecisionsServer()
        const { runtime, traces } = startRuntime({
          models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
        })
        try {
          // The admitted thread is `once` — its ping selects and the thread completes.
          // (A looping thread here would recurse the engine's super-step cascade
          // unboundedly — a known engine frontier this test does not exercise.)
          runtime.trigger(
            addThreadRequest('aj1', {
              name: 'greeter',
              description: 'Test thread.',
              once: true,
              rules: [{ request: { type: 'ping' } }],
            }),
          )
          // The judgment's outcome: the admission fires with the candidate id…
          await waitForTraces(traces, (s) =>
            s.some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.admitted &&
                (t.selected.detail as { id?: string }).id === 'aj1',
            ),
          )
          // …the Decision saw the proposed thread (the faculty's recorded request —
          // the semantic layer judged the actual thread, not a schema echo).
          const judged = server.requests.find(
            (r) => (r.body.state as { thread?: { name?: string } } | undefined)?.thread?.name === 'greeter',
          )
          expect(judged).toBeDefined()
          expect(Object.keys(judged?.body.questions ?? {})).toContain('admission')
          // The admission rides the judged outcome — the verdict precedes it.
          const selections = selectionsOf(traces)
          const judgeResultIndex = selections.findIndex(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request_result &&
              (t.selected.detail as { id?: string }).id === 'aj1-judge',
          )
          const admittedIndex = selections.findIndex(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'aj1',
          )
          expect(admittedIndex).toBeGreaterThan(judgeResultIndex)
          // The thread_added provision fires — the composition owns the write.
          expect(
            traces.some(
              (t) =>
                t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                (t as { thread?: { name?: string } }).thread?.name === 'greeter',
            ),
          ).toBe(true)
          // …and the admitted thread goes live — its request selects like any other thread's.
          await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ping'))
        } finally {
          runtime.terminate()
          await server.close()
        }
      })

      test('the judged path: a rejection holds the line — the candidate never admits', async () => {
        const server = await startDecisionsServer({ pickChoice: 'reject' })
        const { runtime, traces } = startRuntime({
          models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
        })
        try {
          // `once` — under the livelock ruling a looping requester is rejected
          // at the STRUCTURAL layer before the judgment ever runs, so the
          // judgment-rejection test needs a structurally-verifiable candidate:
          // the semantic layer is what must hold the line here.
          runtime.trigger(
            addThreadRequest('aj2', {
              name: 'suspicious',
              description: 'Test thread.',
              once: true,
              rules: [{ request: { type: 'evil' } }],
            }),
          )
          // The rejection is visible, stamped with the candidate id…
          await waitForTraces(traces, (s) =>
            s.some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.rejected &&
                (t.selected.detail as { id?: string }).id === 'aj2',
            ),
          )
          // …and the line held: no admission for the rejected candidate, no
          // thread_added provision, nothing live.
          expect(
            selectionsOf(traces).some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.admitted &&
                (t.selected.detail as { id?: string }).id === 'aj2',
            ),
          ).toBe(false)
          expect(
            traces.some(
              (t) =>
                t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                (t as { thread?: { name?: string } }).thread?.name === 'suspicious',
            ),
          ).toBe(false)
          expect(selectionsOf(traces).some((t) => t.selected.type === 'evil')).toBe(false)
          // NEVER STACKED (the orchestration ruling's pin): the candidate is
          // thread-minted even in judgment mode, but NO structural outcome
          // mounts beside the judgment pack — so nothing ever maps the
          // candidate to thread_admission, not even after the rejection's
          // gate lift. Settle past the async wire, then assert the absence
          // holds: a late admitted selection or provision would be the
          // reject-then-admit bug.
          await waitForTraces(traces, (s) =>
            s.some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.candidate &&
                (t.selected.detail as { id?: string }).id === 'aj2',
            ),
          )
          await new Promise((resolve) => setTimeout(resolve, 500))
          expect(
            selectionsOf(traces).some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.admitted &&
                (t.selected.detail as { id?: string }).id === 'aj2',
            ),
          ).toBe(false)
          expect(
            traces.some(
              (t) =>
                t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                (t as { thread?: { name?: string } }).thread?.name === 'suspicious',
            ),
          ).toBe(false)
        } finally {
          runtime.terminate()
          await server.close()
        }
      })
    })
  })

  describe('the outage shape — hold-and-retry (ruled 2026-10-03)', () => {
    // A judge-unavailable verdict (the typed-error / faculty_error shapes)
    // NEVER maps to a durable thread_admission_rejected: it HOLDS (the
    // gate's block holds, no decided record) and the same Decision
    // re-issues on the COMPOSITION-HOSTED backoff — 3 retries, capped
    // exponential with full jitter (the websocket-transport #retry shape,
    // the shared home). Exhaustion leaves the candidate UNDECIDED, held,
    // fail-visible; the next boot/reload re-adjudicates (no record). An
    // explicit judged NO stays durable. The scheduler is injectable — the
    // tests drive the timers deterministically and assert the jitter
    // bounds.
    const injectScheduler = (): {
      scheduler: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }
      scheduled: Array<{ fn: () => void; ms: number }>
    } => {
      const scheduled: Array<{ fn: () => void; ms: number }> = []
      return {
        scheduled,
        scheduler: {
          setTimeout: (fn: () => void, ms: number): unknown => {
            scheduled.push({ fn, ms })
            return scheduled.length
          },
          clearTimeout: (): void => {},
        },
      }
    }

    test('an outage verdict holds and re-issues on the hosted backoff — never a durable reject', async () => {
      // The first judge attempt hits 429s past the faculty's own retry
      // budget (MAX_ATTEMPTS=4, retry-after: 0 — the typed-error result
      // surfaces); the composition's re-issue gets answered and approves.
      const server = await startDecisionsServer({ rateLimitFirst: 4 })
      const { scheduled, scheduler } = injectScheduler()
      const { runtime, traces } = startRuntime({
        scheduler,
        models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
      })
      try {
        runtime.trigger(
          addThreadRequest('oj1', {
            name: 'outage-greeter',
            description: 'Test thread.',
            once: true,
            rules: [{ request: { type: 'ping' } }],
          }),
        )
        // The outage outcome is VISIBLE: the hold event, stamped with the
        // candidate id — and NEVER a durable rejection.
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.judgeUnavailable &&
              (t.selected.detail as { id?: string }).id === 'oj1',
          ),
        )
        expect(
          selectionsOf(traces).some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.rejected && (t.selected.detail as { id?: string }).id === 'oj1',
          ),
        ).toBe(false)
        // The re-issue is scheduled on the composition-hosted backoff:
        // attempt 1's full-jitter bound is 1000ms.
        expect(scheduled.length).toBe(1)
        const first = scheduled[0]!
        expect(first.ms).toBeGreaterThanOrEqual(0)
        expect(first.ms).toBeLessThan(1_000)
        // Fire the timer: the SAME Decision re-issues (the
        // `<candidate>-judge` correlation holds — the server sees the
        // second request).
        first.fn()
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'oj1',
          ),
        )
        // The faculty's internal budget burned four 429s before the typed
        // error; the re-issued Decision's request carries the same body.
        expect(server.requests.length).toBe(5)
        for (const request of server.requests) {
          expect((request.body.state as { thread?: { name?: string } }).thread?.name).toBe('outage-greeter')
        }
        // The retry approved: the write leg mounts.
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'outage-greeter',
          ),
        ).toBe(true)
      } finally {
        runtime.terminate()
        await server.close()
      }
    })

    test('exhaustion holds the candidate undecided — no durable record, the gate lifts for later candidates', async () => {
      // Exactly the exhaustion budget 429s: four judge calls (the ask + the
      // three re-issues, the faculty's internal MAX_ATTEMPTS each) burn
      // sixteen 429s; the next judge call — the later candidate's — is
      // answered and approves.
      const server = await startDecisionsServer({ rateLimitFirst: 16 })
      const { scheduled, scheduler } = injectScheduler()
      const { runtime, traces } = startRuntime({
        scheduler,
        models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
      })
      try {
        // The FULL plugin path drives the flow: the candidate event
        // registers the plugin key (the durable record would ride the
        // entry-side watcher) and the carry's dispatch mints the add_thread
        // request — the outage must NEVER produce a record for it (the
        // next boot/reload re-adjudicates for free).
        runtime.trigger({
          type: PLUGIN_THREADS_EVENT_TYPES.candidate,
          detail: {
            id: 'oe1',
            input: {
              plugin: '/plugins/alpha',
              file: 't.ts',
              hash: 'hash-1',
              sourceHash: 1,
              thread: {
                name: 'exhausted-candidate',
                description: 'Test thread.',
                once: true,
                rules: [{ request: { type: 'ping' } }],
              },
            },
          } as unknown as JsonObject,
        })
        // Drive the hosted timers: each outage schedules one retry; fire
        // the three, and the fourth outage exhausts the budget.
        for (let fires = 0; fires < 3; fires++) {
          await waitForTraces(traces, (s) => scheduled.length > fires)
          scheduled[fires]!.fn()
        }
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.undecided &&
              (t.selected.detail as { id?: string }).id === 'oe1',
          ),
        )
        // Every outcome held: no durable rejection, no admission, no
        // provision.
        expect(
          selectionsOf(traces).some(
            (t) =>
              (t.selected.type === ADMISSION_EVENT_TYPES.rejected ||
                t.selected.type === ADMISSION_EVENT_TYPES.admitted) &&
              (t.selected.detail as { id?: string }).id === 'oe1',
          ),
        ).toBe(false)
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'exhausted-candidate',
          ),
        ).toBe(false)
        // NO durable registry write: the watcher never recorded an outage
        // outcome (or an exhaustion) for the plugin key.
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(
          selectionsOf(traces).some((t) => {
            if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
            const detail = t.selected.detail as { op?: string; input?: { collection?: string } }
            return detail.op === 'put' && detail.input?.collection === PLUGIN_THREADS_REGISTRY_COLLECTION
          }),
        ).toBe(false)
        // The gate lifted on the undecided: a LATER candidate judges and
        // admits — the lane never wedges on one exhausted candidate.
        runtime.trigger(
          addThreadRequest('oe2', {
            name: 'after-exhaustion',
            description: 'Test thread.',
            once: true,
            rules: [{ request: { type: 'ping' } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'oe2',
          ),
        )
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { name?: string } }).thread?.name === 'after-exhaustion',
          ),
        ).toBe(true)
      } finally {
        runtime.terminate()
        await server.close()
      }
    })
  })

  describe('runtime supervision (systemOne wired)', () => {
    const watched = 'sup_watched'

    test('the counted trip is judged through the real faculty: the lift releases the block, the program continues', async () => {
      const server = await startDecisionsServer()
      const { runtime, traces } = startRuntime({
        models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
        threads: [
          ...supervisionThreads({ watch: [watched], threshold: 4 }),
          ...supervisionJudgmentThreads,
          ...supervisionRecoveryThreads({ watch: [watched], threshold: 4 }),
        ],
      })
      try {
        for (let i = 0; i < 4; i++) runtime.trigger({ type: watched, detail: {} })
        // The trip surfaced — the breaker blocked the watched type mid-run.
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.tripped))
        // The judgment ran through the REAL faculty (the result trace proves
        // the round-trip completed) — the state carries the loop's identity,
        // the question is the supervision choice.
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === 'system_one_request_result' &&
              (t.selected.detail as { id?: string }).id === `${watched}-supervision`,
          ),
        )
        const judged = server.requests.find((r) => (r.body.state as { lane?: string }).lane === 'supervision')
        expect(judged).toBeDefined()
        const judgedState = judged?.body.state as { type?: string } | undefined
        expect(judgedState?.type).toBe(watched)
        expect(Object.keys(judged?.body.questions ?? {})).toContain('supervision')
        // The lift: the release fires, no halt, the block lifts — and the
        // watched type selects again. The program continued.
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.release))
        expect(selectionsOf(traces).some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.halted)).toBe(false)
        runtime.trigger({ type: watched, detail: {} })
        await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === watched).length === 5)
      } finally {
        runtime.terminate()
        await server.close()
      }
    })

    test('fail-visible: an unavailable judge holds the block and surfaces the halt with the reason', async () => {
      // The judge is unavailable — every call 429s and the provider exhausts
      // its retries, so the result is the faculty's error branch. The block
      // HOLDS and the halt is visible with the judge-failure reason — never
      // silent continuation, never an invisible halt.
      const server = await startDecisionsServer({ rateLimitFirst: 999 })
      const { runtime, traces } = startRuntime({
        models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
        threads: [
          ...supervisionThreads({ watch: [watched], threshold: 4 }),
          ...supervisionJudgmentThreads,
          ...supervisionRecoveryThreads({ watch: [watched], threshold: 4 }),
        ],
      })
      try {
        for (let i = 0; i < 4; i++) runtime.trigger({ type: watched, detail: {} })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.halted))
        const halted = selectionsOf(traces).find((t) => t.selected.type === SUPERVISION_EVENT_TYPES.halted)
        const haltedDetail = halted?.selected.detail as { type?: string; reason?: string } | undefined
        expect(haltedDetail?.type).toBe(watched)
        expect(typeof haltedDetail?.reason).toBe('string')
        // The block HOLDS: no release ever fired, and a later watched event
        // stays blocked — the count never advances past the threshold.
        expect(selectionsOf(traces).some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)
        runtime.trigger({ type: watched, detail: {} })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(selectionsOf(traces).filter((t) => t.selected.type === watched).length).toBe(4)
      } finally {
        runtime.terminate()
        await server.close()
      }
    })
    test('judge-retry recovers an unjudged halt: the re-issue succeeds, the block lifts', async () => {
      // The fixture 429s exactly the first judgment's four transport attempts
      // (the provider's bounded retry exhausts), so decision 1 fails as an
      // unjudged halt — the recovery thread re-issues the same Decision, and
      // decision 2's calls succeed. The block lifts; the program continues.
      const server = await startDecisionsServer({ rateLimitFirst: 4 })
      const { runtime, traces } = startRuntime({
        models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
        threads: [
          ...supervisionThreads({ watch: [watched], threshold: 4 }),
          ...supervisionJudgmentThreads,
          ...supervisionRecoveryThreads({ watch: [watched], threshold: 4 }),
        ],
      })
      try {
        for (let i = 0; i < 4; i++) runtime.trigger({ type: watched, detail: {} })
        // The unjudged halt surfaces with the judge-failure reason.
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.halted))
        const halted = selectionsOf(traces).find((t) => t.selected.type === SUPERVISION_EVENT_TYPES.halted)
        const haltedDetail = halted?.selected.detail as { type?: string; reason?: string } | undefined
        expect(haltedDetail?.type).toBe(watched)
        expect(typeof haltedDetail?.reason).toBe('string')
        // The recovery: the re-issued judgment succeeded — the release
        // fires and the watched type selects again.
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.release))
        runtime.trigger({ type: watched, detail: {} })
        await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === watched).length === 5)
      } finally {
        runtime.terminate()
        await server.close()
      }
    })

    test('override: the host ingress lifts a standing halt — the human decision path', async () => {
      // The judge is permanently unavailable — the halt stands. The host
      // overrides: the ingress lifts the block for the halted type and the
      // watched type selects again.
      const server = await startDecisionsServer({ rateLimitFirst: 999 })
      const { runtime, traces } = startRuntime({
        models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
        threads: [
          ...supervisionThreads({ watch: [watched], threshold: 4 }),
          ...supervisionJudgmentThreads,
          ...supervisionRecoveryThreads({ watch: [watched], threshold: 4 }),
        ],
      })
      try {
        for (let i = 0; i < 4; i++) runtime.trigger({ type: watched, detail: {} })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.halted))
        expect(selectionsOf(traces).some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.release)).toBe(false)

        runtime.trigger({ type: SUPERVISION_EVENT_TYPES.override, detail: { type: watched } })
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === SUPERVISION_EVENT_TYPES.release))
        runtime.trigger({ type: watched, detail: {} })
        await waitForTraces(traces, (s) => s.filter((t) => t.selected.type === watched).length === 5)
      } finally {
        runtime.terminate()
        await server.close()
      }
    })
  })

  test('terminate kills host-constructed lanes too — the composition owns every lane it completes', async () => {
    // Capture the real handle the composition completes: the host passes the
    // builder, so the composition holds the only terminate handle.
    let terminated = false
    const hostShell: SpecLane = {
      name: 'shell',
      build: (addThreads) => {
        const lane = probeShellLane().build(addThreads)
        return {
          ...lane,
          terminate: () => {
            terminated = true
            lane.terminate()
          },
        }
      },
    }

    const { runtime, traces } = startRuntime({ actuators: [hostShell] })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'ov-term', label: 'probe', input: { op: 'echo' } },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'ov-term',
        ),
      )
      runtime.terminate()
      expect(terminated).toBe(true)
    } finally {
      runtime.terminate()
    }
  })

  test('a systemTwo override takes the route: the endpoint seeds the process and the result re-enters', async () => {
    const server = await startOpenResponsesServer()
    const { runtime, traces } = startRuntime({
      models: { systemTwo: { mock: { url: server.url } } as unknown as JsonObject },
    })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: {
          id: 's2-1',
          input: {
            provider: 'mock',
            modelId: 'mock-model',
            input: [{ type: 'message', role: 'user', content: 'Say hello' }],
          },
        },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.system_two_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 's2-1',
        ),
      )
      const result = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.system_two_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 's2-1',
      )
      const detail = result?.selected.detail as
        | { ok?: boolean; result?: { items?: Array<{ content?: Array<{ text?: string }> }> } }
        | undefined
      expect(detail?.ok).toBe(true)
      expect(detail?.result?.items?.[0]?.content?.[0]?.text).toBe(ASSISTANT_TEXT)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('a malformed system_two_request is blocked by the faculty guard — never selected', async () => {
    const server = await startOpenResponsesServer()
    const { runtime, traces } = startRuntime({
      models: { systemTwo: { mock: { url: server.url } } as unknown as JsonObject },
    })
    try {
      // No `input` — the request detail fails its schema, so the derived guard
      // blocks it and the reject is visible (deadlock), not silently dropped.
      runtime.trigger({ type: FACULTY_MESSAGE_KINDS.system_two_request, detail: { id: 'bad' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.system_two_request)).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('a systemOne override takes the route: the endpoint seeds the process and the result re-enters', async () => {
    const server = await startDecisionsServer()
    const { runtime, traces } = startRuntime({
      models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
    })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.system_one_request,
        detail: {
          id: 's1-1',
          input: { state: 'x', questions: { is_urgent: { type: 'noul', instructions: 'Urgent?' } } },
        },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 's1-1',
        ),
      )
      const result = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 's1-1',
      )
      const detail = result?.selected.detail as
        | { ok?: boolean; result?: { answers?: { is_urgent?: { noul?: number } } } }
        | undefined
      expect(detail?.ok).toBe(true)
      expect(detail?.result?.answers?.is_urgent?.noul).toBe(0.9)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('a malformed system_one_request is blocked by the faculty guard — never selected', async () => {
    const server = await startDecisionsServer()
    const { runtime, traces } = startRuntime({
      models: { systemOne: { url: server.url, model: 'typesafe/jev-1.13' } as unknown as JsonObject },
    })
    try {
      runtime.trigger({ type: FACULTY_MESSAGE_KINDS.system_one_request, detail: { id: 'bad' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request)).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('the remote-mcp threads ships with shell+security+store: discovery registers the tools', async () => {
    // A plain JSON-RPC endpoint speaking server/discover + tools/list — the
    // 2026-07-28 stateless era needs no handshake.
    const rpc = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { id?: unknown; method?: string }
        const method = body.method
        if (method === 'server/discover')
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          })
        if (method === 'tools/list')
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'echo', description: 'echoes' }] },
          })
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } })
      },
    })
    const { runtime, traces } = startRuntime()
    try {
      runtime.trigger({
        type: REMOTE_MCP_EVENT_TYPES.discover,
        detail: { id: 'r1', input: { url: `http://localhost:${rpc.port}/mcp` } },
      })
      // The threads drive the generic rpc op: server/discover → tools/list →
      // the store registry put (alongside the skills/plugins tenants).
      await waitForTraces(traces, (s) => storeRequest(s, 'put', REMOTE_MCP_STORE_COLLECTION) !== undefined)
      const put = storeRequest(selectionsOf(traces), 'put', REMOTE_MCP_STORE_COLLECTION)
      const input = (
        put?.selected.detail as {
          input?: {
            key?: string
            value?: { tools?: Array<{ name?: string; handle?: string; sourceHash?: number }> }
          }
        }
      )?.input
      expect(input?.key).toContain('localhost')
      expect(input?.value?.tools?.[0]?.name).toBe('echo')
      // the registration identity, end-to-end through the REAL stamp script:
      // the server-prefixed handle (the localhost hostname, sanitized) + the
      // server-URI provenance hash — the same hashString mint
      expect(input?.value?.tools?.[0]?.handle).toBe('localhost__echo')
      expect(input?.value?.tools?.[0]?.sourceHash).toBe(hashString(`http://localhost:${rpc.port}/mcp`))
      // The outcome surfaces to the host.
      await waitForTraces(traces, (s) =>
        selectionsOf(s).some((t) => t.selected.type === REMOTE_MCP_EVENT_TYPES.discovered),
      )
      const surfaced = selectionsOf(traces).find((t) => t.selected.type === REMOTE_MCP_EVENT_TYPES.discovered)
      const surfacedDetail = surfaced?.selected.detail as { id?: string } | undefined
      expect(surfacedDetail?.id).toBe('r1')
      // The threads' issued ops carry the protocol stamp (observed on the result lane).
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
            (t.selected.detail as { input?: { headers?: Record<string, string> } }).input?.headers?.[
              'MCP-Protocol-Version'
            ] === REMOTE_MCP_PROTOCOL_VERSION,
        ),
      ).toBe(true)
    } finally {
      runtime.terminate()
      rpc.stop(true)
    }
  })

  test('the credential seam ships with shell+security: an auth rpc op vends, then replays with the bearer', async () => {
    // The JSON-RPC endpoint requires a bearer; the broker vends one.
    const seenAuth: Array<string | undefined> = []
    const rpc = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seenAuth.push(request.headers.get('authorization') ?? undefined)
        if (!request.headers.has('authorization')) return new Response('unauthorized', { status: 401 })
        const body = (await request.json()) as { id?: unknown }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { echoed: true } })
      },
    })
    const broker = Bun.serve({
      port: 0,
      fetch: () => Response.json({ token: 'broker-tok-1' }),
    })
    const brokerUrl = `http://localhost:${broker.port}/`
    // Spawned children see STARTUP env only — the broker binding rides the
    // security override's env-data (the shell/store override pattern).
    // The seam needs the trio: shell (the rpc op), security (the vend — env
    // carries the broker binding), store (the replay cache).
    const { runtime, traces } = startRuntime({
      actuators: [
        shellLane(),
        storeLane(),
        securityLane({ MCP_BROKER_URL: brokerUrl, MCP_BROKER_BOOT_SECRET: 'boot-secret' }),
      ],
    })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: {
          id: 'rpc-auth-1',
          input: { op: 'rpc', url: `http://localhost:${rpc.port}/mcp`, method: 'tools/list', auth: true },
        },
      })
      // The first attempt short-circuits as credential_required; the thread
      // vends through the security faculty and replays with the token.
      await waitForTraces(traces, (s) =>
        selectionsOf(s).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'rpc-auth-1' &&
            (t.selected.detail as { ok?: boolean }).ok === true,
        ),
      )
      const results = selectionsOf(traces).filter(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string }).id === 'rpc-auth-1',
      )
      expect(results.length).toBe(2)
      const first = results[0]?.selected.detail as { error?: { code?: string } } | undefined
      expect(first?.error?.code).toBe('credential_required')
      const final = results[1]?.selected.detail as { ok?: boolean; result?: { output?: { echoed?: unknown } } }
      expect(final.ok).toBe(true)
      expect(final.result?.output?.echoed).toBe(true)
      // The security faculty vended from the broker; the remote saw the bearer.
      expect(seenAuth[0]).toBe('Bearer broker-tok-1')
    } finally {
      runtime.terminate()
      rpc.stop(true)
      broker.stop(true)
    }
  })

  // The plugin-threads proposal path — the vertical through the REAL shell
  // faculty: the proposal issues the worker import (the plugin file's top
  // level executes in the `bun run -` subprocess — the only code-execution
  // moment, behind the explicit proposal act), the ctx.echo join maps the
  // result to candidates, and the landed admission path (structural review,
  // verdict, the pending-id write) carries each candidate live.
  test('the plugin-threads proposal path: one add_thread per validated export, invalid exports skipped with warnings', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'bprogram-plugin-'))
    try {
      const dir = join(plugin, 'sh.behavioral/threads')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 't.ts'),
        "export const greeter = { name: 'greeter',        description: 'Test thread.', once: true, rules: [{ request: { type: 'hello' } }] }\n" +
          'export const notAThread = { nope: true }\n',
      )
      const { runtime, traces } = startRuntime()
      try {
        runtime.trigger({
          type: PLUGIN_THREADS_EVENT_TYPES.proposal,
          detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
        })
        // one add_thread proposal — only the valid export, keyed by its candidate id
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request &&
              (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
          ),
        )
        const adds = selectionsOf(traces).filter(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request &&
            (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
        )
        expect(adds.map((t) => (t.selected.detail as { id?: string }).id)).toEqual(['pt1-add-0'])
        const thread = (
          adds[0]?.selected.detail as
            | {
                input?: { thread?: { name?: string; sourceHash?: number } }
              }
            | undefined
        )?.input?.thread
        expect(thread?.name).toBe('greeter')
        // PROVENANCE: the candidate's thread carries the source hash — djb2
        // over the plugin's canonical source path — stamped at the proposal
        // path, before the add_thread dispatch (the association join key).
        expect(thread?.sourceHash).toBe(hashString(plugin))
        // the invalid export skipped with a warning — the imported batch surface carries it
        const imported = selectionsOf(traces).find((t) => t.selected.type === PLUGIN_THREADS_EVENT_TYPES.imported)
        const importedInput = (imported?.selected.detail as { input?: { warnings?: string[] } } | undefined)?.input
        expect(importedInput?.warnings?.some((w) => w.includes('notAThread'))).toBe(true)
        // the verdict admits: the thread_added provision fires — the candidate
        // is live. The wait demands the PROVENANCE JOIN (name + the proposal's
        // own source hash): a boot-fold-mounted snapshot from a prior run also
        // provisions a greeter — with a different plugin's hash — and must
        // never satisfy this wait (parallel-suite pollution otherwise wins the
        // race and the test passes on the wrong provision).
        const provisionMatches = (t: Trace): boolean =>
          t.kind === TRACE_MESSAGE_KINDS.thread_added &&
          (t as { thread?: { name?: string; sourceHash?: number } }).thread?.name === 'greeter' &&
          (t as { thread?: { sourceHash?: number } }).thread?.sourceHash === hashString(plugin)
        await waitForTraces(traces, () => traces.some(provisionMatches))
        const added = traces.find(provisionMatches)
        expect(added).toBeDefined()
      } finally {
        runtime.terminate()
      }
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })

  // The plugin-thread admission registry — the STORE-RESIDENT record (the
  // file registry died): admitted decisions snapshot the validated thread
  // stamped with the instance identity, rejected decisions carry the reason,
  // a changed content hash re-arms the proposal. Read-back is a second store
  // spawn against the SAME per-spec temp home (the tripwire: explicit
  // env threading, never runtime mutation). The boot-mount semantics (the
  // unchanged-key snapshot mount, never re-import) belong to the boot
  // reconciliation slice.
  describe('the plugin-thread admission registry (store record)', () => {
    const withIsolatedHome = async (run: (plugin: string) => Promise<void>): Promise<void> => {
      const plugin = mkdtempSync(join(tmpdir(), 'bprogram-plugin-'))
      try {
        await run(plugin)
      } finally {
        rmSync(plugin, { recursive: true, force: true })
      }
    }

    /** The fixture plugin thread — its requested event name identifies the snapshot version. */
    const writePluginThread = (plugin: string, request: string): void => {
      const dir = join(plugin, 'sh.behavioral/threads')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 't.ts'),
        `export const greeter = { name: 'greeter',        description: 'Test thread.', once: true, rules: [{ request: { type: '${request}' } }] }\n`,
      )
    }

    /** The record reader — a second store spawn against the SAME temp home db. */
    const readRegistryRecord = async (home: string): Promise<Record<string, unknown>> => {
      const store = storeLane({ BEHAVIORAL_HOME: home })
      const results: Array<Record<string, unknown>> = []
      const probe = bProgram({ actuators: [store.build] })
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
          return ((found.result as { value?: { entries?: Record<string, unknown> } } | undefined)?.value?.entries ??
            {}) as Record<string, unknown>
        }
        if (Date.now() > deadline) throw new Error('registry record never read back')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    test('admit → the record snapshots the validated thread with the stamped instance identity', async () => {
      await withIsolatedHome(async (plugin) => {
        writePluginThread(plugin, 'hello')
        {
          const { runtime, traces, registry, home } = startRuntime()
          try {
            runtime.trigger({
              type: PLUGIN_THREADS_EVENT_TYPES.proposal,
              detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
            })
            await waitForTraces(traces, () =>
              traces.some(
                (t) =>
                  t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                  (t as { thread?: { name?: string } }).thread?.name === 'greeter',
              ),
            )
            await registry?.flush()
            const entries = await readRegistryRecord(home)
            expect(Object.keys(entries)).toHaveLength(1)
            const [entry] = Object.values(entries) as Array<{
              status: string
              thread?: { sourceHash?: number; instanceHash?: number }
              instanceHash?: number
              v?: number
            }>
            expect(entry?.status).toBe('admitted')
            expect(entry?.thread?.sourceHash).toBe(hashString(plugin))
            // THE THIRD HASH: djb2(canonical plugin path + umwelt + NAME) — the
            // registry's OWN content hash stays the re-adjudication key; two
            // hashes, two jobs, plus the mount identity.
            expect(entry?.instanceHash).toBe(pluginThreadInstanceHash({ plugin, name: 'greeter' }))
            expect(entry?.thread?.instanceHash).toBe(entry?.instanceHash)
            expect(entry?.v).toBe(PLUGIN_THREADS_REGISTRY_VERSION)
          } finally {
            runtime.terminate()
          }
        }
      })
    }, 20_000)

    test('reject → the record holds the reason, visibly', async () => {
      await withIsolatedHome(async (plugin) => {
        const dir = join(plugin, 'sh.behavioral/threads')
        mkdirSync(dir, { recursive: true })
        // a self-sustaining request loop — the livelock guard rejects it
        writeFileSync(
          join(dir, 't.ts'),
          "export const looper = { name: 'looper',          description: 'Test thread.', rules: [{ request: { type: 'spin' } }] }\n",
        )
        const { runtime, traces, registry, home } = startRuntime()
        try {
          runtime.trigger({
            type: PLUGIN_THREADS_EVENT_TYPES.proposal,
            detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
          })
          await waitForTraces(traces, (s) => s.some((t) => t.selected.type === ADMISSION_EVENT_TYPES.rejected), 20_000)
          await registry?.flush()
          const entries = await readRegistryRecord(home)
          const entry = Object.values(entries)[0] as { status: string; reason?: string; v?: number }
          expect(entry?.status).toBe('rejected')
          expect(entry?.reason?.length).toBeGreaterThan(0)
          expect(entry?.v).toBe(PLUGIN_THREADS_REGISTRY_VERSION)
        } finally {
          runtime.terminate()
        }
      })
    }, 30_000)

    test('a changed hash re-arms the proposal — the record holds both hashes as independent decisions', async () => {
      await withIsolatedHome(async (plugin) => {
        // ONE home across both runs — the store record is cross-run state.
        const sharedHome = mkdtempSync(join(tmpdir(), 'bprogram-shared-'))
        try {
          writePluginThread(plugin, 'hello')
          {
            const { runtime, traces, registry, home } = startRuntime({ home: sharedHome })
            try {
              runtime.trigger({
                type: PLUGIN_THREADS_EVENT_TYPES.proposal,
                detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
              })
              await waitForTraces(traces, () =>
                traces.some(
                  (t) =>
                    t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                    (t as { thread?: { name?: string } }).thread?.name === 'greeter',
                ),
              )
              await registry?.flush()
              expect(Object.keys(await readRegistryRecord(home))).toHaveLength(1)
            } finally {
              runtime.terminate()
            }
          }
          // the plugin updates — the content hash changes, the proposal re-arms
          writePluginThread(plugin, 'hello2')
          {
            const { runtime, traces, registry, home } = startRuntime({ home: sharedHome })
            try {
              runtime.trigger({
                type: PLUGIN_THREADS_EVENT_TYPES.proposal,
                detail: { id: 'pt2', input: { plugin, file: 't.ts' } },
              })
              // the import re-runs in the worker (a new shell_request)…
              await waitForTraces(traces, (s) =>
                s.some(
                  (t) =>
                    t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
                    (t.selected.detail as { label?: string } | undefined)?.label === 'plugin-threads',
                ),
              )
              // …and the NEW code proposes add_thread again — never silently admitted
              await waitForTraces(traces, (s) =>
                s.some(
                  (t) =>
                    t.selected.type === FACULTY_MESSAGE_KINDS.frontier_analysis_request &&
                    (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
                ),
              )
              await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'hello2'))
              await registry?.flush()
              // the record now holds both hashes — independent decisions
              expect(Object.keys(await readRegistryRecord(home))).toHaveLength(2)
            } finally {
              runtime.terminate()
            }
          }
        } finally {
          rmSync(sharedHome, { recursive: true, force: true })
        }
      })
    }, 20_000)
  })
})
