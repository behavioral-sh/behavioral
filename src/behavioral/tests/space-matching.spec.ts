/**
 * Space matching — ROOT AUTHORITY: an unstamped (root) listener sees every
 * space. Visibility flows UP only: a root listener matches candidates in
 * every space (all four idioms — waitFor, block, interrupt, transform),
 * while a space-stamped listener stays confined to its own space, never
 * matching root events or siblings (Root/D: a thread governing several
 * spaces is admitted per space explicitly, each mount stamped). Root
 * requests still bid only in root — emissions are not observations. The
 * transform target once-thread re-enters stamped with the SOURCE event's
 * space (Direction/R).
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { InterruptTrace, SelectionTrace, Trace, TransformTrace } from '../behavioral.types.ts'

const selectedTypes = (traces: Trace[]): string[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection).map((t) => t.selected.type)

describe('space matching — root authority: the unstamped listener sees every space', () => {
  test('an unstamped thread matches a root (unstamped) event', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 'root-watcher',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', detail: {} })
    expect(selectedTypes(traces)).toContain('pong')
  })

  test('an unstamped thread matches a named-space event — root sees every space', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 'root-watcher',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', space: 'named', detail: {} })
    expect(selectedTypes(traces)).toContain('pong')
  })

  test('a space-stamped thread matches an event in its space', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 's1-watcher',
      description: 'Test thread.',
      space: 's1',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', space: 's1', detail: {} })
    expect(selectedTypes(traces)).toContain('pong')
  })

  test('a space-stamped thread does not match root events or other spaces', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 's1-watcher',
      description: 'Test thread.',
      space: 's1',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', detail: {} })
    expect(selectedTypes(traces)).not.toContain('pong')
    program.trigger({ type: 'ping', space: 's2', detail: {} })
    expect(selectedTypes(traces)).not.toContain('pong')
  })

  test('an unstamped block blocks a named-space candidate — the selection never fires', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 'root-blocker',
      description: 'Test thread.',
      rules: [{ block: [{ type: 'go' }] }],
    })
    program.trigger({ type: 'go', space: 's1', detail: {} })
    expect(selectedTypes(traces)).not.toContain('go')
  })

  test('an unstamped interrupt terminates a thread on a named-space event', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 'victim',
      description: 'Test thread.',
      rules: [{ waitFor: [{ type: 'never' }], interrupt: [{ type: 'boom' }] }, { request: { type: 'after-boom' } }],
    })
    program.trigger({ type: 'boom', space: 's1', detail: {} })
    // The terminated thread never advances — even when its wait becomes
    // satisfiable afterwards.
    program.trigger({ type: 'never', detail: {} })
    const interrupt = traces.find((t): t is InterruptTrace => t.kind === TRACE_MESSAGE_KINDS.interrupt)
    expect(interrupt).toBeDefined()
    expect(interrupt!.threadLabel).toBe('victim')
    expect(selectedTypes(traces)).not.toContain('after-boom')
  })

  test('an unstamped transform matches a named-space event — the target re-enters in the source event space', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 'root-shaper',
      description: 'Test thread.',
      rules: [{ transform: [{ type: 'order', query: '.order', target: 'ship' }] }],
    })
    program.trigger({ type: 'order', space: 's1', detail: { order: { id: 'o-1' } } })

    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const ship = selections.find((s) => s.selected.type === 'ship')
    expect(ship).toBeDefined()
    expect(ship!.selected.space).toBe('s1')

    const transformTraces = traces.filter((t): t is TransformTrace => t.kind === TRACE_MESSAGE_KINDS.transform)
    expect(transformTraces).toHaveLength(1)
    // The Transformer record's space IS the target's re-entry stamp —
    // Direction/R: it follows the source event, so the root transformer's
    // output stays in the space it observed.
    expect(transformTraces[0]!.transformers[0]!.space).toBe('s1')
  })

  test('a root request bids only in root — a space-stamped selection does not grant a pending unstamped request', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      name: 'bidder',
      description: 'Test thread.',
      once: true,
      rules: [{ request: { type: 'pong' } }, { request: { type: 'done-bidder' } }],
    })
    program.trigger({ type: 'pong', space: 's1', detail: {} })
    const selections = traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    // The s1 ingress is selected first; it does NOT grant the bidder's pending
    // unstamped request (emissions are not observations) — the bidder's own
    // root bid is selected on its own merit afterwards. An omni grant would
    // yield [pong@s1, done-bidder@root] with no root pong selection.
    expect(selections.map((s) => [s.selected.type, s.selected.space ?? 'root'])).toEqual([
      ['pong', 's1'],
      ['pong', 'root'],
      ['done-bidder', 'root'],
    ])
  })
})
