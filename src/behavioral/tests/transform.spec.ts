import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type {
  PendingBidsTrace,
  SelectionTrace,
  Trace,
  TransformErrorTrace,
  TransformTrace,
} from '../behavioral.types.ts'

/**
 * The transform contract — executed in-engine (2026-09-18):
 *
 * A thread rule may declare `transform: [{ type, query, target }]` — "when the
 * `type` event is selected, evaluate the jq `query` over its detail and re-enter
 * with the result as a `target` event." The engine evaluates synchronously via
 * jq-wasm (`first()` — the whole first output, parsed), adds a `once` re-entry
 * thread requesting the target, and the super-step chain picks it up:
 * request-origin, no kick, no external loop, no sleeps.
 *
 * Failure paths are errors-as-data: jq error, no detail, empty output, and
 * non-object output each trace `transform_error` with a machine-readable reason
 * and the target never fires. The engine core never throws.
 */

describe('transform idiom — in-engine jq execution', () => {
  test('single transform: whole first output re-enters request-origin', () => {
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

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const ship = selections.find((s) => s.selected.type === 'ship')
    expect(ship).toBeDefined()
    expect(ship!.selected.detail).toEqual({ id: 'o-1', total: 42 })
    // In-engine re-entry is request-origin — no ingress mark.
    expect(ship!.selected.ingress).toBeUndefined()

    const pendingBids = traces.filter((t): t is PendingBidsTrace => t.kind === TRACE_MESSAGE_KINDS.pending_bids)
    const labels = pendingBids.flatMap((t) => t.threads.map((th) => th.name))
    expect(labels).toContain('Transform(shaper => ship)')
  })

  test('space-scoped: the re-entry carries the declaring thread space', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      space: 's1',
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', space: 's1', detail: { order: { id: 'o-9' } } })

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const ship = selections.find((s) => s.selected.type === 'ship')
    expect(ship).toBeDefined()
    expect(ship!.selected.space).toBe('s1')

    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces).toHaveLength(1)
    expect(transformTraces[0]!.transformers[0]!.space).toBe('s1')
  })

  test('fan-out: multiple transform listeners on one event all fire', () => {
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
    program.trigger({
      type: 'order',
      detail: { order: { id: 'o-2' }, billing: { account: 'acc-9' } },
    })

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const ship = selections.find((s) => s.selected.type === 'ship')
    const invoice = selections.find((s) => s.selected.type === 'invoice')
    expect(ship).toBeDefined()
    expect(invoice).toBeDefined()
    expect(ship!.selected.detail).toEqual({ id: 'o-2' })
    expect(invoice!.selected.detail).toEqual({ account: 'acc-9' })
  })

  test('partial fan-out: a failed transformer does not prevent sibling targets', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [
        {
          transform: [
            { type: 'order', query: '.order', target: 'ship' },
            // Scalar output — not a JsonObject, so this contract fails.
            { type: 'order', query: '.total', target: 'total' },
          ],
        },
      ],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-3' }, total: 7 } })

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const ship = selections.find((s) => s.selected.type === 'ship')
    expect(ship).toBeDefined()
    expect(ship!.selected.detail).toEqual({ id: 'o-3' })
    expect(selections.some((s) => s.selected.type === 'total')).toBe(false)

    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('non_object_output')
    expect(errors[0]!.transformer.target).toBe('total')
    expect(errors[0]!.transformer.thread).toBe('shaper')
  })

  test('jq_error: an invalid query traces stderr and never fires the target', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order.', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-4' } } })

    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('jq_error')
    expect(errors[0]!.stderr).toBeDefined()
    expect(errors[0]!.exitCode).toBeDefined()
    expect(errors[0]!.transformer.target).toBe('ship')

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selections.some((s) => s.selected.type === 'ship')).toBe(false)
  })

  test('empty_output: a query producing no output traces and never fires the target', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.missing? // empty', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-5' } } })

    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('empty_output')
    expect(errors[0]!.stderr).toBeUndefined()

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selections.some((s) => s.selected.type === 'ship')).toBe(false)
  })

  test('no_detail: a transform listener on a detail-less event traces and never fires the target', () => {
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

    // The listener matched — the declared reshape is recorded, then the failure.
    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces).toHaveLength(1)
    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('no_detail')

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selections.some((s) => s.selected.type === 'ship')).toBe(false)
  })

  test('jq_timeout: a never-terminating query is killed at the timeout and never fires the target', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: 'while(true; .)', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-7' } } })

    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('jq_timeout')
    expect(errors[0]!.stderr).toBeUndefined()
    expect(errors[0]!.transformer.target).toBe('ship')

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selections.some((s) => s.selected.type === 'ship')).toBe(false)
  })

  test('pool recovery: a timeout is isolated — the next transform in the same program still evaluates', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'spinner',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'spin', query: 'while(true; .)', target: 'never' }] }],
    })
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    // The runaway query is killed at the eval timeout…
    program.trigger({ type: 'spin', detail: { spin: true } })
    // …and the warm pool respawns, so a later transform still re-enters.
    program.trigger({ type: 'order', detail: { order: { id: 'o-9', total: 5 } } })

    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('jq_timeout')
    expect(errors[0]!.transformer.target).toBe('never')

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selections.some((s) => s.selected.type === 'never')).toBe(false)
    const ship = selections.find((s) => s.selected.type === 'ship')
    expect(ship).toBeDefined()
    expect(ship!.selected.detail).toEqual({ id: 'o-9', total: 5 })
  })

  test("the warm pool is unref'd — a process that only ran a transform still exits", () => {
    // `bun test` force-exits after a run, so a leaked (ref'd) worker would be
    // invisible here. The real runtime is `bun run` (serve/CLI), which blocks
    // on a live worker — exercise that boundary in a subprocess.
    const script = `import { evaluateTransform } from '${new URL('../behavioral.utils.ts', import.meta.url).pathname}'\nconsole.log('done', JSON.stringify(evaluateTransform('.a', { a: 1 })))`
    const proc = Bun.spawnSync({
      cmd: [process.execPath, 'run', '-'],
      stdin: new TextEncoder().encode(script),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
    expect(proc.exitCode).toBe(0)
    expect(new TextDecoder().decode(proc.stdout)).toContain('done')
  })

  test('output_too_large: a result beyond the shared-buffer cap traces and never fires the target', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '{ big: [range(50000)] }', target: 'ship' }] }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-8' } } })

    const errors = traces.filter((t): t is TransformErrorTrace => t.kind === TRACE_MESSAGE_KINDS.transform_error)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.reason).toBe('output_too_large')
    expect(errors[0]!.transformer.target).toBe('ship')

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    expect(selections.some((s) => s.selected.type === 'ship')).toBe(false)
  })

  test('daemon semantics: an ingressMatch:false waiter matches the re-entered target', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })
    addThread({
      name: 'ship-waiter',
      description: 'Test thread.',
      once: true,
      rules: [{ waitFor: [{ type: 'ship', ingressMatch: false }] }, { request: { type: 'shipped' } }],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'order', detail: { order: { id: 'o-6', total: 7 } } })

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const ship = selections.find((s) => s.selected.type === 'ship')
    expect(ship).toBeDefined()
    // Internal re-entry is request-origin — an ingressMatch:false waiter matches.
    expect(ship!.selected.ingress).toBeUndefined()
    expect(selections.some((s) => s.selected.type === 'shipped')).toBe(true)
  })

  test('transform trace shape: transformers carry query, target, thread — emitted before the payload selection', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({
      name: 'observer-test',
      description: 'Test thread.',
      rules: [
        {
          transform: [
            { type: 'evt', query: '.a', target: 'out_a' },
            { type: 'evt', query: '.b', target: 'out_b' },
          ],
        },
      ],
    })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'evt', detail: { a: 1, b: 2 } })

    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces).toHaveLength(1)
    const trace = transformTraces[0]!
    expect(trace.transformers).toHaveLength(2)
    expect(trace.transformers[0]!.thread).toBe('observer-test')
    expect(trace.transformers[0]!.query).toBe('.a')
    expect(trace.transformers[0]!.target).toBe('out_a')
    expect(trace.transformers[1]!.target).toBe('out_b')

    // The transform trace is emitted before the selection that carries the payload.
    const transformIndex = traces.findIndex((t) => t.kind === TRACE_MESSAGE_KINDS.transform)
    const selectionIndex = traces.findIndex(
      (t) => t.kind === TRACE_MESSAGE_KINDS.selection && (t as SelectionTrace).selected.type === 'evt',
    )
    expect(transformIndex).toBeGreaterThanOrEqual(0)
    expect(selectionIndex).toBeGreaterThanOrEqual(0)
    expect(transformIndex).toBeLessThan(selectionIndex)
  })

  test('no transform trace when no transform listeners match', () => {
    const program = behavioral()
    const { addThread } = program
    addThread({ name: 'waiter', description: 'Test thread.', rules: [{ waitFor: [{ type: 'other' }] }] })

    const traces: Trace[] = []
    program.useTrace((msg) => {
      traces.push(msg)
    })
    program.trigger({ type: 'unrelated', detail: { x: 1 } })

    expect(traces.filter((t) => t.kind === TRACE_MESSAGE_KINDS.transform)).toHaveLength(0)
    expect(traces.filter((t) => t.kind === TRACE_MESSAGE_KINDS.transform_error)).toHaveLength(0)
  })
})
