import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { JsonObject, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { bProgram } from '../b-program.ts'

/**
 * The composition's transform legs (slice 2): the engine mints the
 * `transform_request` once-thread; the composition routes it to the FIXED
 * FOURTH lane, parks the reshape contract (the trace's id join — the route
 * leg cannot see the source thread label), and mints the target at the
 * result leg (`detail = result.value`). Failures mint NOTHING — the ok:false
 * result selection is the failure surface, fail-visible.
 *
 * The REAL transform faculty answers: the lane mounts by construction (the
 * fixed four), so these specs exercise the full async wire — request select →
 * faculty eval → result re-entry → target mint.
 */

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const waitForTraces = async (
  traces: Trace[],
  until: (selections: SelectionTrace[]) => boolean,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for traces; saw: ${JSON.stringify(selectionsOf(traces).map((s) => s.selected.type))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const shaperThread = (space?: string): Thread => ({
  name: 'shaper',
  description: 'Test thread.',
  ...(space === undefined ? {} : { space }),
  rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
})

describe('the composition transform legs — park and mint over the fixed fourth lane', () => {
  test('a transform match re-enters as the evaluated target — the async wire end to end', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({ threads: [shaperThread()] })
    runtime.useTrace((t) => {
      traces.push(t)
    })
    runtime.start()
    runtime.trigger({ type: 'order', detail: { order: { id: 'o-1', total: 42 } } })

    // The request selects (the engine's mint)…
    await waitForTraces(traces, (sel) => sel.some((s) => s.selected.type === FACULTY_MESSAGE_KINDS.transform_request))
    // …the faculty evaluates, the result re-enters, and the composition mints
    // the target — one super-step later, with the evaluated detail.
    await waitForTraces(traces, (sel) => sel.some((s) => s.selected.type === 'ship'))
    const ship = selectionsOf(traces).find((s) => s.selected.type === 'ship')!
    expect(ship.selected.detail).toEqual({ id: 'o-1', total: 42 })
    // The target re-entry is request-origin (the composition's mint), no ingress mark.
    expect(ship.selected.ingress).toBeUndefined()
    runtime.terminate()
  })

  test('the mint name preserves the source thread label — the lineage parse holds', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({ threads: [shaperThread()] })
    runtime.useTrace((t) => {
      traces.push(t)
    })
    runtime.start()
    runtime.trigger({ type: 'order', detail: { order: { id: 'o-2' } } })
    await waitForTraces(traces, (sel) => sel.some((s) => s.selected.type === 'ship'))
    // The target once-thread's name is the engine trace's `Transform(...)` shape —
    // ui-capture's lineage parse (Transform(ui/pipeline:<pid>/<leg> => target)) rides it.
    const added = traces.filter(
      (t) =>
        t.kind === TRACE_MESSAGE_KINDS.thread_added && (t as { thread?: { name?: string } }).thread?.name !== undefined,
    ) as Array<{ thread: { name: string } }>
    expect(added.some((t) => t.thread.name === 'Transform(shaper => ship)')).toBe(true)
    runtime.terminate()
  })

  test('the space carries per Direction/R — the target re-enters stamped', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({ threads: [shaperThread('s1')] })
    runtime.useTrace((t) => {
      traces.push(t)
    })
    runtime.start()
    runtime.trigger({ type: 'order', space: 's1', detail: { order: { id: 'o-9' } } })
    await waitForTraces(traces, (sel) => sel.some((s) => s.selected.type === 'ship'))
    const ship = selectionsOf(traces).find((s) => s.selected.type === 'ship')!
    expect(ship.selected.space).toBe('s1')
    runtime.terminate()
  })

  test('a failing evaluation answers ok:false — the result selects, no target, visible', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({
      threads: [
        {
          name: 'bad-shaper',
          description: 'Test thread.',
          rules: [{ transform: [{ type: 'order', query: '.order.', target: 'ship' }] }],
        },
      ],
    })
    runtime.useTrace((t) => {
      traces.push(t)
    })
    runtime.start()
    runtime.trigger({ type: 'order', detail: { order: { id: 'o-4' } } })

    await waitForTraces(traces, (sel) =>
      sel.some(
        (s) =>
          s.selected.type === FACULTY_MESSAGE_KINDS.transform_request_result &&
          (s.selected.detail as { ok?: boolean }).ok === false,
      ),
    )
    const failure = selectionsOf(traces).find(
      (s) =>
        s.selected.type === FACULTY_MESSAGE_KINDS.transform_request_result &&
        (s.selected.detail as { ok?: boolean }).ok === false,
    )!
    const detail = failure.selected.detail as { reason: string; stderr?: string; exitCode?: number }
    expect(detail.reason).toBe('jq_error')
    expect(typeof detail.stderr).toBe('string')
    // No target — the failure minted nothing.
    expect(selectionsOf(traces).some((s) => s.selected.type === 'ship')).toBe(false)
    runtime.terminate()
  })

  test('an unknown-id result selects and matches nothing — visible in the traces, no mint', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({ threads: [shaperThread()] })
    runtime.useTrace((t) => {
      traces.push(t)
    })
    // A result whose id parks nothing arrives through the lane's re-entry —
    // the composition's mint leg must ignore it (the park is the authority:
    // only results correlated to contracts this composition routed mint).
    const stray: JsonObject = { id: 'stray-unknown-id', ok: true, value: { forged: true } }
    runtime.trigger({
      type: FACULTY_MESSAGE_KINDS.transform_request_result,
      detail: stray,
    } as unknown as Parameters<typeof runtime.trigger>[0])
    await waitForTraces(traces, (sel) =>
      sel.some((s) => (s.selected.detail as { id?: string })?.id === 'stray-unknown-id'),
    )
    // The stray result selected (fail-visible) but minted no target.
    expect(
      selectionsOf(traces).some(
        (s) => s.selected.type === 'ship' && (s.selected.detail as { forged?: boolean })?.forged === true,
      ),
    ).toBe(false)
    runtime.terminate()
  })
})
