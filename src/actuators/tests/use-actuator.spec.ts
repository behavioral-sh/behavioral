import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { ACTUATOR_MESSAGE_KINDS } from '../actuators.constants.ts'
import {
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  validateShellCancelEvent,
  validateShellRequestEvent,
} from '../actuators.schemas.ts'
import { eventGuardEntries, guardThreads } from '../actuators.threads.ts'
import { useActuator } from '../use-actuator.ts'

/**
 * useActuator — the slimmed spawn-based actuator primitive — against a real
 * process on the real wire (the engine runs in-process via behavioral(); the
 * spec plays the composition's pump role: selected request events forward to
 * the actuator's send, exactly as bProgram does). Pinned contract:
 *
 * - spawn: a request line goes out; the result line re-enters as an event
 * - wire: the outbound gate is the wire home's ONCE-COMPILED validators —
 *   no schema compilation happens here
 * - crash: a crashed process (exit mid-request) synthesizes ONE
 *   faculty_error (exit-code crash synthesis)
 * - respawn: the faculty RESPAWNS on demand — the next request completes on
 *   a fresh process
 * - terminate: kills the process; later sends are no-ops
 *
 * Guard derivation is composition-side from the wire home (faculties.types.ts
 * compiles the schemas once; the guard test below derives from the same one
 * home). The fixture: `probe.proc.ts` — long-running line protocol; the `die`
 * op exits 3 mid-stream; everything else answers the ok envelope.
 */

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

/**
 * The in-process re-entry law (the engine transport's trailing step, now the
 * composition's): addThread alone is inert — every satellite-result re-entry
 * must pump one super-step for it to select.
 */
const addThreadsWithStep =
  (program: ReturnType<typeof behavioral>) =>
  (threads: Thread[]): void => {
    for (const thread of threads) program.addThread(thread)
    program.step()
  }

const spawnProbe = (env?: Record<string, string>) => {
  const program = behavioral()
  const traces: Trace[] = []
  const actuator = useActuator({
    command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
    name: 'probe',
    ...(env === undefined ? {} : { env }),
    // The wire home's once-compiled validators — useActuator compiles nothing.
    validateRequest: validateShellRequestEvent,
    validateCancel: validateShellCancelEvent,
    resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
  })(addThreadsWithStep(program))
  // The composition's pump role: forward selected faculty requests outbound
  // (the wire-projected event — the selected candidate carries non-wire
  // fields like priority that the boundary schemas reject).
  program.useTrace((trace: Trace) => {
    traces.push(trace)
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = (trace as SelectionTrace).selected
    const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
    if (event.type === ACTUATOR_MESSAGE_KINDS.shell_request && validateShellRequestEvent(event)) {
      actuator.send(event)
    }
  })
  return { program, traces, actuator }
}

const awaitSelection = async (
  traces: Trace[],
  match: (t: SelectionTrace) => boolean,
  label: string,
): Promise<SelectionTrace> => {
  const deadline = Date.now() + 8_000
  for (;;) {
    const found = selectionsOf(traces).find(match)
    if (found !== undefined) return found
    if (Date.now() > deadline)
      throw new Error(`${label}; saw: ${JSON.stringify(selectionsOf(traces).map((t) => t.selected.type))}`)
    await Bun.sleep(10)
  }
}

const request = (id: string, op: string): BPEvent => ({
  type: ACTUATOR_MESSAGE_KINDS.shell_request,
  detail: { id, label: 'probe', input: { op } },
})

describe('useActuator — the slimmed spawn-based actuator primitive', () => {
  test('no schema compilation happens here — the wiring takes the wire home once-compiled validators and returns no schemas', () => {
    const { actuator } = spawnProbe()
    try {
      expect('schemas' in actuator).toBe(false)
      expect(Object.keys(actuator).sort()).toEqual(['invalidEventGate', 'name', 'send', 'terminate'])
    } finally {
      actuator.terminate()
    }
  })

  test('the outbound gate is the wire home compiled validators — a schema-invalid request or cancel does not pass', () => {
    const { actuator } = spawnProbe()
    try {
      // A wire-shaped request passes; a malformed one fails both gates.
      expect(
        actuator.invalidEventGate({
          type: ACTUATOR_MESSAGE_KINDS.shell_request,
          detail: { id: 'g', label: 'x', input: { op: 'echo' } },
        }),
      ).toBe(false)
      expect(actuator.invalidEventGate({ type: ACTUATOR_MESSAGE_KINDS.shell_request, detail: { nope: true } })).toBe(
        true,
      )
      expect(
        actuator.invalidEventGate({ type: ACTUATOR_MESSAGE_KINDS.shell_request_result, detail: { id: 'g' } }),
      ).toBe(true)
    } finally {
      actuator.terminate()
    }
  })

  test('a request round-trips through the process and its result re-enters', async () => {
    const { program, traces, actuator } = spawnProbe()
    try {
      program.addThread({
        name: 'caller',
        description: 'Test thread.',
        once: true,
        rules: [{ request: request('r1', 'echo') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'r1',
        'no result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
    } finally {
      actuator.terminate()
    }
  })

  test('env is merged over the inherited environment for the spawned process', async () => {
    const { program, traces, actuator } = spawnProbe({ PROBE_ENV: 'from-env-option' })
    try {
      program.addThread({
        name: 'env-caller',
        description: 'Test thread.',
        once: true,
        rules: [{ request: request('e1', 'env') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'e1',
        'no env result',
      )
      const detail = result.selected.detail as { result?: { env?: string } } | undefined
      expect(detail?.result?.env).toBe('from-env-option')
    } finally {
      actuator.terminate()
    }
  })

  test('without a guard, a schema-invalid result line re-enters and is observable — not silently discarded', async () => {
    const { program, traces, actuator } = spawnProbe()
    try {
      program.addThread({
        name: 'malformed-caller',
        description: 'Test thread.',
        once: true,
        rules: [{ request: request('m1', 'emit_malformed') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      // The VALID result (emitted after the malformed line) selects normally.
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'm1',
        'no ok result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
      // The MALFORMED result re-entered the engine (instead of vanishing): its
      // detail is observable in the traces — here as a selected event, since
      // this raw program mounts no guard to block it.
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { malformed?: boolean } | undefined)?.malformed === true,
        ),
      ).toBe(true)
    } finally {
      actuator.terminate()
    }
  })

  test('with the composition-side guard mounted, the malformed result is blocked — visible in the frontier, never selected', async () => {
    const program = behavioral()
    const traces: Trace[] = []
    const actuator = useActuator({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'probe',
      validateRequest: validateShellRequestEvent,
      validateCancel: validateShellCancelEvent,
      resultKind: ACTUATOR_MESSAGE_KINDS.shell_request_result,
    })(addThreadsWithStep(program))
    // The composition's own mount: the guard derived from the wire home's
    // schemas — exactly what bProgram derives (the actuator returns none).
    addThreadsWithStep(program)(
      guardThreads(
        'guard:probe-schema',
        'Blocks every shell wire message whose detail fails its event schema.',
        eventGuardEntries({
          request: ShellRequestEventSchema,
          cancel: ShellCancelEventSchema,
          result: ShellRequestResultEventSchema,
        }),
      ),
    )
    try {
      program.useTrace((trace: Trace) => {
        traces.push(trace)
        if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
        const selected = (trace as SelectionTrace).selected
        const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
        if (event.type === ACTUATOR_MESSAGE_KINDS.shell_request && validateShellRequestEvent(event)) {
          actuator.send(event)
        }
      })
      program.addThread({
        name: 'malformed-caller',
        description: 'Test thread.',
        once: true,
        rules: [{ request: request('m1', 'emit_malformed') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      // The valid result still selects.
      await awaitSelection(
        traces,
        (t) =>
          t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'm1',
        'no ok result',
      )
      // The malformed result never selects — the guard blocked it...
      await Bun.sleep(100)
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { malformed?: boolean } | undefined)?.malformed === true,
        ),
      ).toBe(false)
      // ...and the reject is visible: the blocked once-thread stays pending
      // with no bidders, and the frontier deadlocks naming it.
      expect(traces.some((trace) => JSON.stringify(trace).includes('"malformed":true'))).toBe(true)
      expect(traces.some((trace) => trace.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      actuator.terminate()
    }
  })

  test('a crashed process synthesizes ONE faculty_error, then the actuator respawns', async () => {
    const { program, traces, actuator } = spawnProbe()
    try {
      program.addThread({
        name: 'crash-watch',
        description: 'Test thread.',
        rules: [
          {
            waitFor: [
              {
                type: ACTUATOR_MESSAGE_KINDS.faculty_error,
                detailSchema: { type: 'object', properties: { faculty: { const: 'probe' } }, required: ['faculty'] },
              },
            ],
          },
        ],
      })
      // 1. The die op exits the process mid-request → crash synthesis.
      program.addThread({
        name: 'killer',
        description: 'Test thread.',
        once: true,
        rules: [{ request: request('d1', 'die') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      await awaitSelection(
        traces,
        (t) =>
          t.selected.type === ACTUATOR_MESSAGE_KINDS.faculty_error &&
          (t.selected.detail as { faculty?: string } | undefined)?.faculty === 'probe',
        'no faculty_error',
      )
      const crashes = selectionsOf(traces).filter(
        (t) => t.selected.type === ACTUATOR_MESSAGE_KINDS.faculty_error,
      ).length
      expect(crashes).toBe(1)

      // 2. Respawn on demand: the next request completes on a fresh process.
      program.addThread({
        name: 'after-crash',
        description: 'Test thread.',
        once: true,
        rules: [{ request: request('r2', 'echo') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === ACTUATOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'r2',
        'no respawn result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
      // Still exactly one crash — the respawn's listener is armed for the NEXT death only.
      expect(selectionsOf(traces).filter((t) => t.selected.type === ACTUATOR_MESSAGE_KINDS.faculty_error).length).toBe(
        1,
      )
    } finally {
      actuator.terminate()
    }
  })
})
