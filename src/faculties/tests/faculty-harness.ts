import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { INIT_FRAME_KIND, type InitFrame } from '../create-worker.ts'

/**
 * The faculty spec harness — every faculty spec's spawn shape: the faculty
 * runs as a REAL Bun web Worker running the TS entry directly (no bundling
 * needed to prove the lane), speaking the unchanged wire over postMessage,
 * exactly as the composition wires it. The worker construction stays a
 * bundler-visible literal at the CALL SITE (the spec's `new URL(...)`), per
 * the useWorker factory ruling.
 *
 * `initData` is the faculty's config, delivered as the INIT FRAME — posted
 * immediately after the worker constructs (port FIFO + the worker message
 * queue order it before any request), exactly as `useWorker` posts it.
 */

export type FacultyResult = {
  id: string
  detail: Record<string, unknown>
  space?: string
}

/** The worker-shape harness type. */
type FacultyWorker = {
  call: (detail: JsonObject, space?: string) => void
  post: (event: { type: string; detail: JsonObject; space?: string }) => void
  resultFor: (id: string, timeoutMs?: number) => Promise<FacultyResult>
  terminate: () => void
}

/** The worker-shape spawn: a REAL Bun web Worker on the TS entry. */
export const spawnFacultyWorker = ({
  url,
  requestType,
  resultType,
  initData,
}: {
  /** The worker entry URL — `new URL('<relative entry>', import.meta.url)` at the call site. */
  url: URL
  requestType: string
  resultType: string
  /** The faculty's config, delivered as the init frame posted at construction. */
  initData?: JsonObject
}): FacultyWorker => {
  const worker = new Worker(url)
  const init: InitFrame = { kind: INIT_FRAME_KIND, data: initData ?? {} }
  worker.postMessage(init)
  const results: FacultyResult[] = []
  worker.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as { type: string; detail: { id: string } & JsonObject; space?: string } | null
    if (message === null || typeof message !== 'object' || message.type !== resultType) return
    results.push({
      id: message.detail.id,
      detail: message.detail as Record<string, unknown>,
      space: message.space,
    })
  })
  return {
    call: (detail: JsonObject, space?: string): void => {
      worker.postMessage({ type: requestType, detail, ...(space === undefined ? {} : { space }) })
    },
    post: (event: { type: string; detail: JsonObject; space?: string }): void => {
      worker.postMessage(event)
    },
    resultFor: async (id: string, timeoutMs = 10_000): Promise<FacultyResult> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = results.find((r) => r.id === id)
        if (found !== undefined) return found
        if (Date.now() > deadline)
          throw new Error(`no result for ${id}; saw: ${JSON.stringify(results.map((r) => r.id))}`)
        await Bun.sleep(10)
      }
    },
    terminate: (): void => {
      worker.terminate()
    },
  }
}
