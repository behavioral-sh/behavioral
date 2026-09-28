import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { useSystemOne } from '../config.ts'

/**
 * `configSystemOne`'s `entry` resolution — the custom-provider seam:
 *
 * - a RELATIVE entry resolves against BEHAVIORAL_HOME (where `init` scaffolds
 *   user provider entries), not the package's spawn cwd;
 * - an ABSOLUTE entry is used verbatim;
 * - absent entry keeps the bundled Decisions provider (the faculty spec).
 *
 * Each case runs a real provider entry process (a custom `respond` returning a
 * marker answer) through the real host helper — the wire contract is unchanged.
 */

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const addThreadsWithStep =
  (program: ReturnType<typeof behavioral>) =>
  (threads: Thread[]): void => {
    for (const thread of threads) program.addThread(thread)
    program.step()
  }

const KIND = FACULTY_MESSAGE_KINDS.system_one_request
const INPUT = { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } }

/** Write a custom provider entry returning a marker answer; returns its home-relative path. */
const writeCustomEntry = (home: string, file: string, respondLine: string): string => {
  mkdirSync(join(home, 'providers'), { recursive: true })
  // The import spec is an absolute file URL — robust in any environment (no
  // global-link assumption in the test runner).
  const target = resolve(import.meta.dir, '..', 'config.ts')
  writeFileSync(
    join(home, 'providers', file),
    [
      `import { configSystemOne } from '${pathToFileURL(target).href}'`,
      `const respond = async () => (${respondLine})`,
      `if (import.meta.main) configSystemOne(respond)`,
      '',
    ].join('\n'),
  )
  return `providers/${file}`
}

/** Wire the faculty through the real host helper, send one request, await its result. */
const spawnAndCall = async (
  entry: string,
): Promise<{ ok?: boolean; result?: { model?: string }; error?: { message?: string } }> => {
  const program = behavioral()
  const traces: Trace[] = []
  const handle = useSystemOne({ endpoint: { url: 'http://unused.local', model: 'm' }, entry })(
    addThreadsWithStep(program),
  )
  try {
    program.useTrace((trace: Trace) => {
      traces.push(trace)
      if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
      const selected = (trace as SelectionTrace).selected
      const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
      if (event.type === KIND) handle.send(event)
    })
    const id = 'entry-check'
    program.addThread({
      label: 'caller',
      once: true,
      rules: [{ request: { type: KIND, detail: { id, input: INPUT as JsonObject } } }],
    })
    program.trigger({ type: 'entry_check_pump', detail: {} })

    const deadline = Date.now() + 8_000
    for (;;) {
      const found = selectionsOf(traces).find((t) => {
        const detail = t.selected.detail as { id?: string } | undefined
        return (
          (t.selected.type === `${KIND}_result` && detail?.id === id) ||
          t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error
        )
      })
      if (found !== undefined)
        return found.selected.detail as { ok?: boolean; result?: { model?: string }; error?: { message?: string } }
      if (Date.now() > deadline)
        throw new Error(`no result; saw: ${JSON.stringify(selectionsOf(traces).map((t) => t.selected.type))}`)
      await Bun.sleep(10)
    }
  } finally {
    handle.terminate()
  }
}

describe('configSystemOne — custom provider entry resolution', () => {
  let home: string
  const previousHome = process.env.BEHAVIORAL_HOME

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'behavioral-entry-'))
    process.env.BEHAVIORAL_HOME = home
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.BEHAVIORAL_HOME
    else process.env.BEHAVIORAL_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  test('a relative entry resolves against BEHAVIORAL_HOME', async () => {
    const entry = writeCustomEntry(
      home,
      'my-one.faculty.ts',
      "{ model: 'custom-one', answers: { marker: { type: 'noul', noul: 0.5 } } }",
    )
    const detail = await spawnAndCall(entry)
    expect(detail.ok).toBe(true)
    expect(detail.result?.model).toBe('custom-one')
  })

  test('an absolute entry is used verbatim', async () => {
    const entry = writeCustomEntry(
      home,
      'abs-one.faculty.ts',
      "{ model: 'abs-one', answers: { marker: { type: 'noul', noul: 0.5 } } }",
    )
    const detail = await spawnAndCall(resolve(home, entry))
    expect(detail.ok).toBe(true)
    expect(detail.result?.model).toBe('abs-one')
  })
})
