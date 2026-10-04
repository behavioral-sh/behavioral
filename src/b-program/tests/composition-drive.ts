import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { bProgram } from '../b-program.ts'

/**
 * The composition-drive harness — the thread-pack specs' ride through the
 * REAL composition (the transform-faculty ruling's migration path): the
 * engine no longer evaluates transforms, so a pack's transform listeners
 * complete only through the fixed fourth faculty. The harness boots the
 * composition (the four fixed faculty workers mount by construction; no
 * actuator lanes — the specs inject faculty results as ingress triggers),
 * subscribes FIRST, starts, and exposes polling for the async wire.
 *
 * The old bare-engine harness (`behavioral()` + producer once-threads +
 * double pumps) rode the in-engine synchronous evaluation; under the mint
 * semantics the evaluation is async — ingress triggers replace the producer
 * threads (the packs' listeners carry no `ingressMatch`, so the ingress
 * channel matches identically) and assertions poll via `waitUntil`.
 */
export type CompositionDrive = {
  /** All traces, in emission order — subscribe-first, so boot traces land. */
  traces: Trace[]
  /** The selections so far — the simplified shape the pack specs assert on. */
  selected: Array<{ type: string; detail: Record<string, unknown> | undefined }>
  /** Admit one ingress event (the packs' listeners match the ingress channel). */
  trigger: (event: BPEvent) => void
  /** Poll until the predicate holds over the selections (or throw with what was seen). */
  waitUntil: (
    until: (selected: Array<{ type: string; detail: Record<string, unknown> | undefined }>) => boolean,
    timeoutMs?: number,
  ) => Promise<void>
  /**
   * Wait for quiescence: no NEW selections for `quiesceMs` (the async wire's
   * settle — transform chains take a few tens of ms per hop). Throws on timeout.
   */
  settle: (quiesceMs?: number, timeoutMs?: number) => Promise<void>
  /** Terminate the composition's faculty workers. */
  terminate: () => void
}

export const driveComposition = ({
  threads,
  models,
}: {
  threads: Thread[]
  /** The faculties' init-frame payloads — the judged pins point systemOne at a fixture endpoint. */
  models?: Parameters<typeof bProgram>[0]['models']
}): CompositionDrive => {
  const traces: Trace[] = []
  const runtime = bProgram({ threads, ...(models === undefined ? {} : { models }) })
  runtime.useTrace((trace: Trace) => {
    traces.push(trace)
  })
  runtime.start()
  const selected = (): Array<{ type: string; detail: Record<string, unknown> | undefined }> =>
    traces
      .filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
      .map((t) => ({
        type: t.selected.type,
        detail: t.selected.detail as Record<string, unknown> | undefined,
      }))
  const waitUntil = async (
    until: (selected: Array<{ type: string; detail: Record<string, unknown> | undefined }>) => boolean,
    timeoutMs = 15_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!until(selected())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting; saw: ${JSON.stringify(selected().map((s) => s.type))}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const settle = async (quiesceMs = 150, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    let count = selected().length
    let lastChange = Date.now()
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const now = selected().length
      if (now !== count) {
        count = now
        lastChange = Date.now()
      }
      if (Date.now() - lastChange >= quiesceMs) return
      if (Date.now() > deadline) {
        throw new Error(`composition did not settle; saw: ${JSON.stringify(selected().map((s) => s.type))}`)
      }
    }
  }
  return {
    traces,
    get selected() {
      return selected()
    },
    trigger: (event: BPEvent): void => {
      runtime.trigger(event)
    },
    waitUntil,
    settle,
    terminate: (): void => {
      runtime.terminate()
    },
  }
}
