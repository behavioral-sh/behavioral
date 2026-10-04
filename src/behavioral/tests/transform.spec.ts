import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { PendingBidsTrace, SelectionTrace, Trace, TransformTrace } from '../behavioral.types.ts'

/**
 * The transform idiom — the REQUEST MINT (the transform-faculty ruling):
 *
 * A thread rule may declare `transform: [{ type, query, target }]` — "when
 * the `type` event is selected, hand the event's detail to the transform
 * faculty and re-enter with the result as a `target` event." The ENGINE
 * evaluates NOTHING: a match mints a `transform_request` once-thread — the
 * same re-entry mechanism as the old target mint — and the COMPOSITION
 * routes it to the fixed fourth faculty, parks the reshape contract, and
 * mints the target at the result leg. Targets select one super-step later
 * (the async wire); failures surface as the ok:false result selection —
 * the `transform_error` trace kind retires.
 *
 * These pins are the ENGINE-side contract: the mint, the trace, the umwelt
 * carry, and the never-evaluate floor. The evaluation outcomes live with
 * the faculty (src/faculties/tests/transform.faculty.spec.ts); the
 * composition legs live with b-program (b-program.spec.ts).
 */

const selections = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const requestSelections = (traces: Trace[]): SelectionTrace[] =>
  selections(traces).filter((s) => s.selected.type === 'transform_request')

describe('transform idiom — the request mint', () => {
  test('a transform match mints the transform_request once-thread — the request selects with the idiom', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-1', total: 42 } } })

    const requests = requestSelections(traces)
    expect(requests).toHaveLength(1)
    const detail = requests[0]!.selected.detail as { id: string; query: string; target: string; detail?: unknown }
    expect(detail.query).toBe('.order')
    expect(detail.target).toBe('ship')
    // The jq input rides verbatim — the selected event's detail.
    expect(detail.detail).toEqual({ order: { id: 'o-1', total: 42 } })
    // The correlation id is a minted uuid — non-empty string.
    expect(typeof detail.id).toBe('string')
    expect(detail.id.length).toBeGreaterThan(0)
    // The request is request-origin — no ingress mark.
    expect(requests[0]!.selected.ingress).toBeUndefined()

    // The minted thread is a once-thread (ephemeral, mint-unique key).
    const pendingBids = traces.filter((t): t is PendingBidsTrace => t.kind === TRACE_MESSAGE_KINDS.pending_bids)
    const labels = pendingBids.flatMap((t) => t.threads.map((th) => th.name))
    expect(labels).toContain('TransformRequest(shaper => ship)')
  })

  test('the transform trace stays mint-time and gains the request id', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-2' } } })

    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces).toHaveLength(1)
    const transformer = transformTraces[0]!.transformers[0]!
    expect(transformer.thread).toBe('shaper')
    expect(transformer.query).toBe('.order')
    expect(transformer.target).toBe('ship')
    // The trace's id joins the minted request — the composition's park key.
    const requestDetail = requestSelections(traces)[0]!.selected.detail as { id: string }
    expect(transformer.id).toBe(requestDetail.id)

    // Mint-time order: the transform trace precedes the request selection.
    const transformIndex = traces.findIndex((t) => t.kind === TRACE_MESSAGE_KINDS.transform)
    const requestIndex = traces.findIndex(
      (t) => t.kind === TRACE_MESSAGE_KINDS.selection && (t as SelectionTrace).selected.type === 'transform_request',
    )
    expect(transformIndex).toBeLessThan(requestIndex)
  })

  test('the engine never evaluates — no target selection until a result re-enters', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-3' } } })
    // Pump the cascade to quiescence — the bare engine has no answerer.
    program.trigger({ type: 'pump', detail: {} })
    program.trigger({ type: 'pump', detail: {} })

    expect(selections(traces).some((s) => s.selected.type === 'ship')).toBe(false)
  })

  test('the request carries the Direction/R umwelt — the re-entry stamp follows the source event', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      umwelt: 's1',
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', umwelt: 's1', detail: { order: { id: 'o-9' } } })

    const requests = requestSelections(traces)
    expect(requests).toHaveLength(1)
    // The minted once-thread re-enters stamped with the source event's umwelt.
    expect(requests[0]!.selected.umwelt).toBe('s1')
    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces[0]!.transformers[0]!.umwelt).toBe('s1')
  })

  test('a detail-less match still mints — the jq input is omitted, the faculty answers no_detail', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order' })

    const requests = requestSelections(traces)
    expect(requests).toHaveLength(1)
    const detail = requests[0]!.selected.detail as Record<string, unknown>
    expect('detail' in detail).toBe(false)
  })

  test('fan-out: every matched listener mints its own request with its own id', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'multi-shaper',
      description: 'Test thread.',
      rules: [
        {
          transform: [
            { type: 'order', query: '.order', target: 'ship' },
            { type: 'order', query: '.billing', target: 'invoice' },
          ],
        },
      ],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-4' }, billing: { account: 'acc-9' } } })

    const requests = requestSelections(traces)
    expect(requests).toHaveLength(2)
    const ids = requests.map((s) => (s.selected.detail as { id: string }).id)
    expect(new Set(ids).size).toBe(2)
    expect(requests.map((s) => (s.selected.detail as { target: string }).target).sort()).toEqual(['invoice', 'ship'])

    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces[0]!.transformers).toHaveLength(2)
  })

  test('no transform trace and no mint when no transform listeners match', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({ name: 'waiter', description: 'Test thread.', rules: [{ waitFor: [{ type: 'other' }] }] })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'unrelated', detail: { x: 1 } })

    expect(traces.filter((t) => t.kind === TRACE_MESSAGE_KINDS.transform)).toHaveLength(0)
    expect(requestSelections(traces)).toHaveLength(0)
  })

  test('the minted request survives the shaper thread removal — no cascading kill', () => {
    const program = behavioral()
    const { traces } = traceCollector(program)
    program.addThread({
      name: 'shaper',
      description: 'Test thread.',
      instanceHash: 7,
      rules: [{ transform: [{ type: 'arrives', query: '.', target: 'reshaped' }] }],
    })
    program.trigger({ type: 'arrives', detail: { v: 1 } })
    // The transform matched: the engine minted the request once-thread (an
    // ephemeral identity). Remove the shaper; the request STAYS and still
    // selects — the composition's result leg is what mints the target.
    program.removeThread({ instanceHash: 7 })
    expect(requestSelections(traces).length).toBeGreaterThanOrEqual(1)
    program.trigger({ type: 'pump', detail: {} })
    expect(requestSelections(traces).length).toBeGreaterThanOrEqual(1)
    // The shaper itself no longer matches: a second arrival transforms nothing.
    const before = requestSelections(traces).length
    program.trigger({ type: 'arrives', detail: { v: 2 } })
    program.trigger({ type: 'pump', detail: {} })
    expect(requestSelections(traces).length).toBe(before)
  })
})

const traceCollector = (program: ReturnType<typeof behavioral>): { traces: Trace[] } => {
  const traces: Trace[] = []
  program.useTrace((t) => {
    traces.push(t)
  })
  return { traces }
}
