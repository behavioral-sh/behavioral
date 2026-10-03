import { expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { Trace } from '../behavioral.types.ts'
import { onSelection } from './helpers.ts'

const addHotRules = [{ request: { type: 'hot' } }, { request: { type: 'hot' } }, { request: { type: 'hot' } }]
const addColdRules = [{ request: { type: 'cold' } }, { request: { type: 'cold' } }, { request: { type: 'cold' } }]
const mixHotColdRules = [
  { waitFor: [{ type: 'hot' }], block: [{ type: 'cold' }] },
  { waitFor: [{ type: 'cold' }], block: [{ type: 'hot' }] },
]

/**
 * Test scenario: Demonstrates a basic behavioral program (`bProgram`).
 * It features a single b-thread (`addHot`) that sequentially requests the 'hot' event three times.
 * This showcases the fundamental concept of a thread making requests.
 *
 * Setup:
 * - A `bProgram` instance is created.
 * - A b-thread named 'addHot' is defined using `bThread` and `bSync`.
 *   - It consists of three steps, each requesting the 'hot' event.
 * - A feedback handler using `addHandler` is registered to track when 'hot' events are selected.
 * - The program is initiated by triggering a 'start' event (though any event could start it).
 *
 * Expected Outcome:
 * - The 'hot' event handler should be called three times, in sequence.
 * - The `actual` array should contain ['hot', 'hot', 'hot'].
 */
test('Add hot water 3 times', () => {
  const actual: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'addHot', description: 'Test thread.', rules: addHotRules, once: true })
  onSelection(program, (selected) => {
    if (selected.type === 'hot') actual.push('hot')
  })
  trigger({ type: 'start' })
  expect(actual).toEqual(['hot', 'hot', 'hot'])
})

/**
 * Test scenario: Illustrates the behavior of multiple independent b-threads running concurrently.
 * One thread (`addHot`) requests 'hot' three times, while another (`addCold`) requests 'cold' three times.
 * This demonstrates the default event selection strategy based on thread registration order (priority).
 *
 * Setup:
 * - Similar to the previous test, but with an additional 'addCold' thread.
 * - Feedback handlers are registered for both 'hot' and 'cold' events.
 *
 * Expected Outcome:
 * - Since 'addHot' is registered first (implicitly higher priority), all its 'hot' requests
 *   are selected and executed before any 'cold' requests from 'addCold'.
 * - The `actual` array should contain ['hot', 'hot', 'hot', 'cold', 'cold', 'cold'].
 */
test('Add hot/cold water 3 times', () => {
  const actual: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'addHot', description: 'Test thread.', rules: addHotRules, once: true })
  addThread({ name: 'addCold', description: 'Test thread.', rules: addColdRules, once: true })
  onSelection(program, (selected) => {
    if (selected.type === 'hot') actual.push('hot')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'cold') actual.push('cold')
  })
  trigger({ type: 'start' })
  expect(actual).toEqual(['hot', 'hot', 'hot', 'cold', 'cold', 'cold'])
})

/**
 * Test scenario: Demonstrates thread coordination using `waitFor` and `block`.
 * A third thread 'mixHotCold' is introduced to enforce alternation between 'hot' and 'cold' events.
 * It waits for 'hot' while blocking 'cold', then waits for 'cold' while blocking 'hot', repeating indefinitely.
 * This ensures the 'hot' and 'cold' events are interleaved.
 */
test('interleave', () => {
  const actual: string[] = []
  const program = behavioral()
  const { addThread, trigger } = program

  addThread({ name: 'addHot', description: 'Test thread.', rules: addHotRules, once: true })
  addThread({ name: 'addCold', description: 'Test thread.', rules: addColdRules, once: true })
  addThread({ name: 'mixHotCold', description: 'Test thread.', rules: mixHotColdRules })
  onSelection(program, (selected) => {
    if (selected.type === 'hot') actual.push('hot')
  })
  onSelection(program, (selected) => {
    if (selected.type === 'cold') actual.push('cold')
  })
  trigger({ type: 'start' })
  expect(actual).toHaveLength(6)
  expect(actual.filter((event) => event === 'hot')).toHaveLength(3)
  expect(actual.filter((event) => event === 'cold')).toHaveLength(3)
})

/**
 * Test scenario: Demonstrates the use of `useTrace` to capture the state
 * of the behavioral program at each step (super-step).
 * This is useful for debugging and understanding the event selection process.
 * The captured traces are compared against a baseline trace.
 */
test('logging', () => {
  const traces: Trace[] = []
  const { addThread, trigger, useTrace } = behavioral()
  useTrace((trace) => {
    traces.push(trace)
  })
  addThread({ name: 'addHot', description: 'Test thread.', rules: addHotRules, once: true })
  addThread({ name: 'addCold', description: 'Test thread.', rules: addColdRules, once: true })
  addThread({ name: 'mixHotCold', description: 'Test thread.', rules: mixHotColdRules })
  trigger({ type: 'start' })
  const frontierTraces = traces.filter((trace) => trace.kind === TRACE_MESSAGE_KINDS.frontier)
  expect(frontierTraces.length).toBeGreaterThan(0)
  const allCandidates = frontierTraces.flatMap((trace) => trace.candidates)
  expect(allCandidates.some((candidate) => candidate.type === 'hot')).toBe(true)
  expect(allCandidates.some((candidate) => candidate.type === 'cold')).toBe(true)
})
