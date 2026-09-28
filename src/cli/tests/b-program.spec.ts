import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import {
  SecurityCancelEventSchema,
  SecurityRequestEventSchema,
  SecurityRequestResultEventSchema,
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
} from '../../faculties/faculties.types.ts'
import { PLUGIN_THREADS_EVENT_TYPES } from '../../faculties/shell/plugin-threads.threads.ts'
import {
  REMOTE_MCP_EVENT_TYPES,
  REMOTE_MCP_PROTOCOL_VERSION,
  REMOTE_MCP_STORE_COLLECTION,
} from '../../faculties/shell/remote-mcp.threads.ts'
import { useSystemOne } from '../../faculties/system-one/config.ts'
import { startDecisionsServer } from '../../faculties/system-one/tests/fixtures/decisions-server.ts'
import { ADMISSION_EVENT_TYPES, SUPERVISION_EVENT_TYPES } from '../../faculties/system-one/threads.ts'
import { useSystemTwo } from '../../faculties/system-two/config.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from '../../faculties/system-two/tests/fixtures/model-server.ts'
import { useFaculty } from '../../faculties/use-faculty.ts'
import { bProgram } from '../b-program.ts'
import { readPluginThreadRegistry } from '../plugin-thread-registry.ts'

/**
 * bProgram — the runtime composition — through its REAL surface: the
 * hook spawns every faculty itself (engine + frontier router-owned, always
 * on; shell/responses/store default-on, pruned by the `faculties`
 * allow-list). The host attaches ingress and observation through the
 * returned handle — `runtime.trigger(...)` and `runtime.useTrace(...)`.
 * `shell` is the one instance-level override: the pre-curried useFaculty
 * return substituting the default shell faculty.
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

const waitForTraces = async (traces: Trace[], until: (selections: SelectionTrace[]) => boolean) => {
  const deadline = Date.now() + 8_000
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for traces; saw: ${JSON.stringify(traces.map((t) => t.kind))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Find a selected store_request by op and collection. */
const storeRequest = (traces: Trace[], op: string, collection: string): SelectionTrace | undefined =>
  selectionsOf(traces).find((t) => {
    if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
    const detail = t.selected.detail as { op?: string; input?: { collection?: string } } | undefined
    return detail?.op === op && detail?.input?.collection === collection
  })

/** Construct the composition, attach observation, then start (the boot flush). */
const startRuntime = (options: Parameters<typeof bProgram>[0] = {}) => {
  const traces: Trace[] = []
  const runtime = bProgram(options)
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  runtime.start()
  return { runtime, traces }
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

  test('a clean boot is trace-clean — successful shell results fire no transform_error noise', async () => {
    const { runtime, traces } = startRuntime()
    try {
      // The boot runs successful shell ops (the skill scan, the plugin
      // manifests) through a composition whose failure-path listeners
      // (rpc-auth, remote-mcp) are mounted. Their gates match only
      // failure-shaped details, so the successes they used to match (then
      // decline into empty-output transform_errors — 8 per boot) never fire.
      await waitForTraces(traces, (s) => storeRequest(s, 'put', 'skills') !== undefined)
      const errors = traces.filter((t) => t.kind === TRACE_MESSAGE_KINDS.transform_error)
      expect(errors).toHaveLength(0)
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

  test('the faculties allow-list prunes faculties: without shell, no route — a triggered shell_request is never answered', async () => {
    const { runtime, traces } = startRuntime({ faculties: ['store'] })
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

  test('shell overrides the default faculty — a host-constructed shell takes the route', async () => {
    const hostShell = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'shell',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })
    const { runtime, traces } = startRuntime({ shell: hostShell })
    try {
      // A raw shell_request (root ingress — no thread involvement): the
      // satellite fixture answers with {ok:true, value:{op}} — a shape the
      // REAL shell never produces. Its arrival proves the override took the
      // shell route. (The faculty's threads ride the host's wiring — [] here by choice.)
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

  test('a crashed satellite re-enters one worker_error event', async () => {
    const hostShell = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'shell',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })
    const { runtime, traces } = startRuntime({ shell: hostShell })
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
    const { runtime, traces } = startRuntime({ faculties: [] })
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

  test('the root guard watches every space: a named-space malformed ui_* message is blocked', async () => {
    const { runtime, traces } = startRuntime({ faculties: [] })
    try {
      // The same invalid ui_render, stamped into s1: the root guard's
      // unstamped block matches every space (Direction/R) — the named-space
      // validation gap is closed with zero new wiring.
      runtime.trigger({ type: 'ui_render', space: 's1', detail: { id: 'r1', target: 'main', swap: 'innerHTML' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === 'ui_render')).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
    }
  })

  describe('add_thread — the admission path', () => {
    const addThreadRequest = (id: string, thread: JsonObject, extra?: JsonObject): BPEvent => ({
      type: FACULTY_MESSAGE_KINDS.frontier_request,
      detail: { id, op: 'add_thread', input: { thread, maxDepth: 8, ...extra } },
    })

    const resultDetailFor = (traces: Trace[], id: string) => {
      const sel = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result &&
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
          addThreadRequest('at1', { label: 'greeter', once: true, rules: [{ request: { type: 'ping' } }] }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'at1')
        // The verdict is data: the frontier validated, the composition owns the write.
        expect(detail?.ok).toBe(true)
        expect(detail?.result?.ok).toBe(true)
        const added = traces.find(
          (t) =>
            t.kind === TRACE_MESSAGE_KINDS.thread_added &&
            (t as { thread?: { label?: string } }).thread?.label === 'greeter',
        )
        expect(added).toBeDefined()
      } finally {
        runtime.terminate()
      }
    })

    test('an invalid proposal is rejected data — no admission, no thread_added', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // `rules` missing: the derived Thread-schema gate rejects the whole input.
        runtime.trigger(addThreadRequest('at2', { label: 'broken' }))
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at2' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'at2')
        expect(detail?.ok).toBe(false)
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { label?: string } }).thread?.label === 'broken',
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
            label: 'worker',
            rules: [{ waitFor: [{ type: 'work' }] }, { request: { type: 'done' } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at3' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const at3Detail = resultDetailFor(traces, 'at3')
        expect(at3Detail?.result?.ok).toBe(true)
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
        runtime.trigger(addThreadRequest('lk1', { label: 'looper', rules: [{ request: { type: 'spin' } }] }))
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'lk1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
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
              (t as { thread?: { label?: string } }).thread?.label === 'looper',
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
            label: 'progress-looper',
            once: true,
            rules: [{ request: { type: FACULTY_MESSAGE_KINDS.store_request_result } }],
          }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'lk2' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'lk2')
        expect(detail?.result?.ok).toBe(true)
        const added = traces.find(
          (t) =>
            t.kind === TRACE_MESSAGE_KINDS.thread_added &&
            (t as { thread?: { label?: string } }).thread?.label === 'progress-looper',
        )
        expect(added).toBeDefined()
      } finally {
        runtime.terminate()
      }
    })

    test('a proposal without maxDepth admits via the composition default budget', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The op schema requires maxDepth, but the composition owns the budget
        // (the ruling): a proposal that omits it is enriched with the default
        // (20k) at the route seam — the analysis runs instead of failing the
        // op's input validation.
        runtime.trigger({
          type: FACULTY_MESSAGE_KINDS.frontier_request,
          detail: {
            id: 'md1',
            op: 'add_thread',
            input: { thread: { label: 'deferred-budget', once: true, rules: [{ request: { type: 'ping' } }] } },
          },
        })
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'md1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'md1')
        expect(detail?.result?.ok).toBe(true)
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { label?: string } }).thread?.label === 'deferred-budget',
          ),
        ).toBe(true)
      } finally {
        runtime.terminate()
      }
    })

    test('a requester-supplied maxDepth flows through: a truncated analysis rejects — fail-closed', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // The pilot-confirmed tradeoff: the override is honored (the edge-case
        // escape hatch), and truncated never passes — a proposal whose state
        // space cannot be explored within the supplied budget is rejected.
        // The two-rule thread needs more than one exploration level.
        runtime.trigger(
          addThreadRequest(
            'md2',
            {
              label: 'two-step',
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
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'md2')
        expect(detail?.result?.ok).toBe(false)
        expect((detail?.result as { status?: string } | undefined)?.status).toBe('truncated')
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { label?: string } }).thread?.label === 'two-step',
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
          addThreadRequest('rv1', { label: 'native-greeter', once: true, rules: [{ request: { type: 'ping' } }] }),
        )
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'rv1',
          ),
        )
        // The admission is a real event selection — the verdict precedes it.
        const selections = selectionsOf(traces)
        const verdictIndex = selections.findIndex(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result &&
            (t.selected.detail as { id?: string }).id === 'rv1',
        )
        const admittedIndex = selections.findIndex(
          (t) =>
            t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'rv1',
        )
        expect(admittedIndex).toBeGreaterThan(verdictIndex)
        // The admitted leg writes on the selection — the provision fires.
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { label?: string } }).thread?.label === 'native-greeter',
          ),
        ).toBe(true)
      } finally {
        runtime.terminate()
      }
    })

    test('the structural rejection is BP-native: a livelocked proposal maps to a thread_admission_rejected selection', async () => {
      const { runtime, traces } = startRuntime()
      try {
        runtime.trigger(addThreadRequest('rv2', { label: 'native-looper', rules: [{ request: { type: 'spin' } }] }))
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
          systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        })
        try {
          // The admitted thread is `once` — its ping selects and the thread completes.
          // (A looping thread here would recurse the engine's super-step cascade
          // unboundedly — a known engine frontier this test does not exercise.)
          runtime.trigger(
            addThreadRequest('aj1', { label: 'greeter', once: true, rules: [{ request: { type: 'ping' } }] }),
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
            (r) => (r.body.state as { thread?: { label?: string } } | undefined)?.thread?.label === 'greeter',
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
                (t as { thread?: { label?: string } }).thread?.label === 'greeter',
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
          systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        })
        try {
          // `once` — under the livelock ruling a looping requester is rejected
          // at the STRUCTURAL layer before the judgment ever runs, so the
          // judgment-rejection test needs a structurally-verifiable candidate:
          // the semantic layer is what must hold the line here.
          runtime.trigger(
            addThreadRequest('aj2', { label: 'suspicious', once: true, rules: [{ request: { type: 'evil' } }] }),
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
                (t as { thread?: { label?: string } }).thread?.label === 'suspicious',
            ),
          ).toBe(false)
          expect(selectionsOf(traces).some((t) => t.selected.type === 'evil')).toBe(false)
        } finally {
          runtime.terminate()
          await server.close()
        }
      })
    })
  })

  describe('runtime supervision (systemOne wired)', () => {
    const watched = 'sup_watched'

    test('the counted trip is judged through the real faculty: the lift releases the block, the program continues', async () => {
      const server = await startDecisionsServer()
      const { runtime, traces } = startRuntime({
        systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        supervision: { watch: [watched], threshold: 4 },
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
        systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        supervision: { watch: [watched], threshold: 4 },
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
        systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        supervision: { watch: [watched], threshold: 4 },
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
        systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        supervision: { watch: [watched], threshold: 4 },
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

  test('terminate kills overridden faculties too — the composition owns every process it invokes', async () => {
    const factory = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'shell',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })
    // Capture the real handle the composition invokes: the host passes the
    // curried factory, so the composition holds the only terminate handle.
    let invoked: ReturnType<typeof factory> | undefined
    let terminated = false
    const hostShell = ((addThreads: Parameters<typeof factory>[0], space?: string) => {
      const handle = factory(addThreads, space)
      invoked = handle
      return {
        ...handle,
        terminate: () => {
          terminated = true
          handle.terminate()
        },
      }
    }) as typeof factory

    const { runtime, traces } = startRuntime({ shell: hostShell })
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
      expect(invoked).toBeDefined()
      runtime.terminate()
      expect(terminated).toBe(true)
    } finally {
      runtime.terminate()
      invoked?.terminate()
    }
  })

  test('a systemTwo override takes the route: the endpoint seeds the process and the result re-enters', async () => {
    const server = await startOpenResponsesServer()
    const { runtime, traces } = startRuntime({ systemTwo: useSystemTwo({ endpoints: { mock: { url: server.url } } }) })
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
    const { runtime, traces } = startRuntime({ systemTwo: useSystemTwo({ endpoints: { mock: { url: server.url } } }) })
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
      systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
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
      systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
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
      const input = (put?.selected.detail as { input?: { key?: string; value?: { tools?: Array<{ name?: string }> } } })
        ?.input
      expect(input?.key).toContain('localhost')
      expect(input?.value?.tools?.[0]?.name).toBe('echo')
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
    const { runtime, traces } = startRuntime({
      security: useFaculty({
        command: ['bun', 'run', '../actuators/security/faculty.ts'],
        name: 'security',
        threads: [],
        env: { MCP_BROKER_URL: brokerUrl, MCP_BROKER_BOOT_SECRET: 'boot-secret' },
        requestSchema: SecurityRequestEventSchema,
        cancelSchema: SecurityCancelEventSchema,
        resultSchema: SecurityRequestResultEventSchema,
      }),
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
        "export const greeter = { label: 'greeter', once: true, rules: [{ request: { type: 'hello' } }] }\n" +
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
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request &&
              (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
          ),
        )
        const adds = selectionsOf(traces).filter(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request &&
            (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
        )
        expect(adds.map((t) => (t.selected.detail as { id?: string }).id)).toEqual(['pt1-add-0'])
        const thread = (adds[0]?.selected.detail as { input?: { thread?: { label?: string } } } | undefined)?.input
          ?.thread
        expect(thread?.label).toBe('greeter')
        // the invalid export skipped with a warning — the imported batch surface carries it
        const imported = selectionsOf(traces).find((t) => t.selected.type === PLUGIN_THREADS_EVENT_TYPES.imported)
        const importedInput = (imported?.selected.detail as { input?: { warnings?: string[] } } | undefined)?.input
        expect(importedInput?.warnings?.some((w) => w.includes('notAThread'))).toBe(true)
        // the verdict admits: the thread_added provision fires — the candidate is live
        await waitForTraces(traces, () =>
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { label?: string } }).thread?.label === 'greeter',
          ),
        )
      } finally {
        runtime.terminate()
      }
    } finally {
      rmSync(plugin, { recursive: true, force: true })
    }
  })

  // The plugin-thread admission registry — host-local under `<home>`
  // (BEHAVIORAL_HOME isolates a whole harness instance, the documented
  // mechanism): admitted decisions snapshot the validated thread, a fresh
  // boot mounts the snapshot and never re-imports the plugin file; rejected
  // decisions stay out, visibly; a changed content hash re-arms the proposal.
  describe('the plugin-thread admission registry', () => {
    const withIsolatedHome = async (run: (home: string, plugin: string) => Promise<void>): Promise<void> => {
      const home = mkdtempSync(join(tmpdir(), 'bprogram-home-'))
      const plugin = mkdtempSync(join(tmpdir(), 'bprogram-plugin-'))
      const prevHome = process.env.BEHAVIORAL_HOME
      process.env.BEHAVIORAL_HOME = home
      try {
        await run(home, plugin)
      } finally {
        process.env.BEHAVIORAL_HOME = prevHome
        rmSync(home, { recursive: true, force: true })
        rmSync(plugin, { recursive: true, force: true })
      }
    }

    /** The fixture plugin thread — its requested event name identifies the snapshot version. */
    const writePluginThread = (plugin: string, request: string): void => {
      const dir = join(plugin, 'sh.behavioral/threads')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 't.ts'),
        `export const greeter = { label: 'greeter', once: true, rules: [{ request: { type: '${request}' } }] }\n`,
      )
    }

    test('admit → a fresh boot mounts the snapshot with no plugin-file import — the OLD snapshot survives a post-admission file mutation', async () => {
      await withIsolatedHome(async (home, plugin) => {
        writePluginThread(plugin, 'hello')
        // run 1: the proposal admits, the registry snapshots the validated thread
        {
          const { runtime, traces } = startRuntime()
          try {
            runtime.trigger({
              type: PLUGIN_THREADS_EVENT_TYPES.proposal,
              detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
            })
            await waitForTraces(traces, () =>
              traces.some(
                (t) =>
                  t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                  (t as { thread?: { label?: string } }).thread?.label === 'greeter',
              ),
            )
          } finally {
            runtime.terminate()
          }
        }
        expect(Object.keys(readPluginThreadRegistry(home))).toHaveLength(1)
        // the plugin file mutates post-admission — the content hash re-arms…
        writePluginThread(plugin, 'hello2')
        // …but a fresh boot mounts the SNAPSHOT: greeter is live with NO
        // proposal, NO import shell_request — the old requested event fires.
        {
          const { runtime, traces } = startRuntime()
          try {
            await waitForTraces(traces, () =>
              traces.some(
                (t) =>
                  t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                  (t as { thread?: { label?: string } }).thread?.label === 'greeter',
              ),
            )
            await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'hello'))
            expect(selectionsOf(traces).some((t) => t.selected.type === 'hello2')).toBe(false)
            expect(
              selectionsOf(traces).some(
                (t) =>
                  t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
                  (t.selected.detail as { label?: string } | undefined)?.label === 'plugin-threads',
              ),
            ).toBe(false)
            expect(selectionsOf(traces).some((t) => t.selected.type === 'hello')).toBe(true)
          } finally {
            runtime.terminate()
          }
        }
      })
    })

    // The registry tests boot multiple full compositions (scans + judged
    // admissions per boot) — process-heavy choreography that exceeds bun's
    // 5s default on slow runners (the CI lesson: green on CI with margin,
    // 5.6s on a 4x-slow container). The explicit timeout buys the runner
    // headroom; waitForTraces' own 8s deadline still fails fast on a
    // genuine break.
    test('reject → the registry holds it out: no boot mount, no re-adjudication — the skip is visible', async () => {
      await withIsolatedHome(async (home, plugin) => {
        const dir = join(plugin, 'sh.behavioral/threads')
        mkdirSync(dir, { recursive: true })
        // a self-sustaining request loop — the livelock guard rejects it
        writeFileSync(
          join(dir, 't.ts'),
          "export const looper = { label: 'looper', rules: [{ request: { type: 'spin' } }] }\n",
        )
        // run 1: the proposal is rejected — the outcome is visible, the registry records why
        {
          const { runtime, traces } = startRuntime()
          try {
            runtime.trigger({
              type: PLUGIN_THREADS_EVENT_TYPES.proposal,
              detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
            })
            await waitForTraces(traces, (s) => s.some((t) => t.selected.type === ADMISSION_EVENT_TYPES.rejected))
          } finally {
            runtime.terminate()
          }
        }
        const registry = readPluginThreadRegistry(home)
        const entry = Object.values(registry)[0]
        expect(entry?.status).toBe('rejected')
        if (entry?.status === 'rejected') expect(entry.reason.length).toBeGreaterThan(0)
        // a fresh boot does NOT mount it
        {
          const { runtime, traces } = startRuntime()
          try {
            await Bun.sleep(300)
            expect(
              traces.some(
                (t) =>
                  t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                  (t as { thread?: { label?: string } }).thread?.label === 'looper',
              ),
            ).toBe(false)
            // a re-proposal of the same content stays out: no import, no
            // add_thread to the frontier — the skip surfaces as its own event
            runtime.trigger({
              type: PLUGIN_THREADS_EVENT_TYPES.proposal,
              detail: { id: 'pt2', input: { plugin, file: 't.ts' } },
            })
            await waitForTraces(traces, (s) => s.some((t) => t.selected.type === PLUGIN_THREADS_EVENT_TYPES.skipped))
            await Bun.sleep(300)
            // the import DID re-run (the hash is only known after the worker
            // import — the proposal act is the designed import moment), but
            // the decided key never reaches the frontier analysis: no verdict
            // comes back for the re-proposal's add_thread id
            expect(
              selectionsOf(traces).some(
                (t) =>
                  t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result &&
                  (t.selected.detail as { id?: string } | undefined)?.id === 'pt2-add-0',
              ),
            ).toBe(false)
          } finally {
            runtime.terminate()
          }
        }
      })
    }, 20_000)

    test('a changed hash re-arms the proposal — the new thread code is a candidate again', async () => {
      await withIsolatedHome(async (home, plugin) => {
        writePluginThread(plugin, 'hello')
        {
          const { runtime, traces } = startRuntime()
          try {
            runtime.trigger({
              type: PLUGIN_THREADS_EVENT_TYPES.proposal,
              detail: { id: 'pt1', input: { plugin, file: 't.ts' } },
            })
            await waitForTraces(traces, () =>
              traces.some(
                (t) =>
                  t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                  (t as { thread?: { label?: string } }).thread?.label === 'greeter',
              ),
            )
          } finally {
            runtime.terminate()
          }
        }
        // the plugin updates — the content hash changes, the proposal re-arms
        writePluginThread(plugin, 'hello2')
        {
          const { runtime, traces } = startRuntime()
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
                  t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request &&
                  (t.selected.detail as { op?: string } | undefined)?.op === 'add_thread',
              ),
            )
            await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'hello2'))
            // the registry now holds both hashes — independent decisions
            expect(Object.keys(readPluginThreadRegistry(home))).toHaveLength(2)
          } finally {
            runtime.terminate()
          }
        }
      })
    }, 20_000)
  })
})
