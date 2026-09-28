import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { FrontierTrace, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { TUI_COMMAND, TUI_SELECT } from '../../cli/tui.ts'
import { eventGuardEntries, facultiesThreads } from '../faculties.threads.ts'

const run = (detail: JsonObject) => runType('ui_render', detail)

const runType = (type: string, detail: JsonObject) => {
  const traces: Trace[] = []
  const { addThread, step, useTrace } = behavioral()
  useTrace((trace: Trace) => {
    traces.push(trace)
  })
  for (const thread of facultiesThreads) addThread(thread)
  addThread({ label: 'sender', once: true, rules: [{ request: { type, detail } }] })
  step()
  const selections = traces.filter((trace): trace is SelectionTrace => trace.kind === TRACE_MESSAGE_KINDS.selection)
  const frontiers = traces.filter((trace): trace is FrontierTrace => trace.kind === TRACE_MESSAGE_KINDS.frontier)
  return { selections, frontiers }
}

describe('facultiesThreads — the root guard threads', () => {
  test('blocks a malformed ui_render: candidate present, none enabled, no selection', () => {
    const { selections, frontiers } = run({ id: 'r1', target: 'main', swap: 'innerHTML' })
    expect(selections.some((s) => s.selected.type === 'ui_render')).toBe(false)
    const deadlock = frontiers.find((frontier) => frontier.status === 'deadlock')
    expect(deadlock?.candidates.map((c) => c.type)).toContain('ui_render')
    expect(deadlock?.enabled).toEqual([])
  })

  test('lets a well-formed ui_render select', () => {
    const { selections, frontiers } = run({ id: 'r1', target: 'main', html: '<p>x</p>', swap: 'innerHTML' })
    expect(selections.some((s) => s.selected.type === 'ui_render')).toBe(true)
    expect(frontiers.some((frontier) => frontier.status === 'ready')).toBe(true)
  })

  describe('the tui_* vocabulary is guarded at ingress', () => {
    test('blocks a malformed tui_command detail: candidate present, none enabled', () => {
      const { selections, frontiers } = runType(TUI_COMMAND, { line: 42 })
      expect(selections.some((s) => s.selected.type === TUI_COMMAND)).toBe(false)
      const deadlock = frontiers.find((frontier) => frontier.status === 'deadlock')
      expect(deadlock?.candidates.map((c) => c.type)).toContain(TUI_COMMAND)
      expect(deadlock?.enabled).toEqual([])
    })

    test('lets a well-formed tui_command select', () => {
      const { selections, frontiers } = runType(TUI_COMMAND, { line: '/space new docs' })
      expect(selections.some((s) => s.selected.type === TUI_COMMAND)).toBe(true)
      expect(frontiers.some((frontier) => frontier.status === 'ready')).toBe(true)
    })

    test('blocks a malformed tui_select detail and lets a well-formed one select', () => {
      const blocked = runType(TUI_SELECT, { option: 7 })
      expect(blocked.selections.some((s) => s.selected.type === TUI_SELECT)).toBe(false)
      const selected = runType(TUI_SELECT, { option: 'docs' })
      expect(selected.selections.some((s) => s.selected.type === TUI_SELECT)).toBe(true)
    })
  })

  // The review's follow-up 4: a schema without properties.type.const is a
  // wiring defect — the guard generator must throw, not produce a guard that
  // can never match.
  test('eventGuardEntries throws on a schema missing properties.type.const', () => {
    const schemas = {
      request: { type: 'object', properties: {} },
      cancel: { type: 'object', properties: {} },
      result: { type: 'object', properties: {} },
    }
    expect(() => eventGuardEntries(schemas)).toThrow(/missing properties\.type\.const/)
  })
})
