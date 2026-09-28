import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { eventGuardEntries, guardThreads } from '../faculties.threads.ts'
import {
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  validateShellRequestEvent,
} from '../faculties.types.ts'
import { useFaculty } from '../use-faculty.ts'

/**
 * useFaculty — the spawn-based faculty primitive — against a real process on
 * the real wire (the engine runs in-process via behavioral(); the spec plays
 * the composition's pump role: selected request events forward to the
 * faculty's send, exactly as bProgram does). Process-native faculties:
 *
 * - a request line goes out; the result line re-enters as an event
 * - a crashed process (exit mid-request) synthesizes ONE worker_error
 *   (exit-code crash synthesis)
 * - the faculty RESPAWNS on demand: the next request completes on a fresh
 *   process
 *
 * The fixture: `probe.proc.ts` — long-running line protocol; the `die` op
 * exits 3 mid-stream; everything else answers the ok envelope.
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
  const faculty = useFaculty({
    command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
    name: 'probe',
    threads: [],
    ...(env === undefined ? {} : { env }),
    requestSchema: ShellRequestEventSchema,
    cancelSchema: ShellCancelEventSchema,
    resultSchema: ShellRequestResultEventSchema,
  })(addThreadsWithStep(program))
  // The composition's pump role: forward selected faculty requests outbound
  // (the wire-projected event — the selected candidate carries non-wire
  // fields like priority that the boundary schemas reject).
  program.useTrace((trace: Trace) => {
    traces.push(trace)
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = (trace as SelectionTrace).selected
    const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
    if (event.type === FACULTY_MESSAGE_KINDS.shell_request && validateShellRequestEvent(event)) {
      faculty.send(event)
    }
  })
  return { program, traces, faculty }
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
  type: FACULTY_MESSAGE_KINDS.shell_request,
  detail: { id, label: 'probe', input: { op } },
})

describe('useFaculty — the spawn-based faculty primitive', () => {
  test('compiles the wiring schemas and returns them (bProgram derives guards from these)', () => {
    const { faculty } = spawnProbe()
    try {
      expect(faculty.schemas.request).toBe(ShellRequestEventSchema)
      expect(faculty.schemas.cancel).toBe(ShellCancelEventSchema)
      expect(faculty.schemas.result).toBe(ShellRequestResultEventSchema)
    } finally {
      faculty.terminate()
    }
  })

  test('a request round-trips through the process and its result re-enters', async () => {
    const { program, traces, faculty } = spawnProbe()
    try {
      program.addThread({
        label: 'caller',
        once: true,
        rules: [{ request: request('r1', 'echo') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'r1',
        'no result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
    } finally {
      faculty.terminate()
    }
  })

  test('env is merged over the inherited environment for the spawned process', async () => {
    const { program, traces, faculty } = spawnProbe({ PROBE_ENV: 'from-env-option' })
    try {
      program.addThread({ label: 'env-caller', once: true, rules: [{ request: request('e1', 'env') }] })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'e1',
        'no env result',
      )
      const detail = result.selected.detail as { result?: { env?: string } } | undefined
      expect(detail?.result?.env).toBe('from-env-option')
    } finally {
      faculty.terminate()
    }
  })

  test('without a guard, a schema-invalid result line re-enters and is observable — not silently discarded', async () => {
    const { program, traces, faculty } = spawnProbe()
    try {
      program.addThread({
        label: 'malformed-caller',
        once: true,
        rules: [{ request: request('m1', 'emit_malformed') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      // The VALID result (emitted after the malformed line) selects normally.
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
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
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { malformed?: boolean } | undefined)?.malformed === true,
        ),
      ).toBe(true)
    } finally {
      faculty.terminate()
    }
  })

  test('with the faculty guard mounted, the malformed result is blocked — visible in the frontier, never selected', async () => {
    const program = behavioral()
    const traces: Trace[] = []
    const faculty = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'probe',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })(addThreadsWithStep(program))
    // The composition's own mount: the guard derived from the schemas
    // useFaculty returned — exactly what bProgram does for a system faculty.
    addThreadsWithStep(program)(guardThreads('guard:probe-schema', eventGuardEntries(faculty.schemas)))
    try {
      program.useTrace((trace: Trace) => {
        traces.push(trace)
        if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
        const selected = (trace as SelectionTrace).selected
        const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
        if (event.type === FACULTY_MESSAGE_KINDS.shell_request && validateShellRequestEvent(event)) {
          faculty.send(event)
        }
      })
      program.addThread({
        label: 'malformed-caller',
        once: true,
        rules: [{ request: request('m1', 'emit_malformed') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      // The valid result still selects.
      await awaitSelection(
        traces,
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'm1',
        'no ok result',
      )
      // The malformed result never selects — the guard blocked it...
      await Bun.sleep(100)
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { malformed?: boolean } | undefined)?.malformed === true,
        ),
      ).toBe(false)
      // ...and the reject is visible: the blocked once-thread stays pending
      // with no bidders, and the frontier deadlocks naming it.
      expect(traces.some((trace) => JSON.stringify(trace).includes('"malformed":true'))).toBe(true)
      expect(traces.some((trace) => trace.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      faculty.terminate()
    }
  })

  test('a crashed process synthesizes ONE worker_error, then the faculty respawns', async () => {
    const { program, traces, faculty } = spawnProbe()
    try {
      program.addThread({
        label: 'crash-watch',
        rules: [
          {
            waitFor: [
              {
                type: FACULTY_MESSAGE_KINDS.faculty_error,
                detailSchema: { type: 'object', properties: { faculty: { const: 'probe' } }, required: ['faculty'] },
              },
            ],
          },
        ],
      })
      // 1. The die op exits the process mid-request → crash synthesis.
      program.addThread({
        label: 'killer',
        once: true,
        rules: [{ request: request('d1', 'die') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      await awaitSelection(
        traces,
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error &&
          (t.selected.detail as { faculty?: string } | undefined)?.faculty === 'probe',
        'no worker_error',
      )
      const crashes = selectionsOf(traces).filter((t) => t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error).length
      expect(crashes).toBe(1)

      // 2. Respawn on demand: the next request completes on a fresh process.
      program.addThread({
        label: 'after-crash',
        once: true,
        rules: [{ request: request('r2', 'echo') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'r2',
        'no respawn result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
      // Still exactly one crash — the respawn's listener is armed for the NEXT death only.
      expect(selectionsOf(traces).filter((t) => t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error).length).toBe(1)
    } finally {
      faculty.terminate()
    }
  })

  // The review's follow-up 4: the pump reads the result schema's type const
  // as its lane seal — a schema without it computed an undefined seal and
  // silently dropped EVERY inbound result. A wiring defect this fundamental
  // must fail at wiring time, same check and message as the guard generator.
  test('useFaculty fails fast on a result schema missing properties.type.const', () => {
    const schemas = {
      request: ShellRequestEventSchema,
      cancel: ShellCancelEventSchema,
      result: { type: 'object', properties: {} } as typeof ShellRequestResultEventSchema,
    }
    expect(() =>
      useFaculty({
        command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
        name: 'probe',
        threads: [],
        requestSchema: schemas.request,
        cancelSchema: schemas.cancel,
        resultSchema: schemas.result,
      }),
    ).toThrow(/missing properties\.type\.const/)
  })
})
