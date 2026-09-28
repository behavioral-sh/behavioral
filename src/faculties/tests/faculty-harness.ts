import { type Serializable, setEnvironmentData } from 'node:worker_threads'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'

/**
 * The faculty spec harness — every faculty spec's spawn shape: the faculty
 * runs as a REAL Bun web Worker running the TS entry directly (no bundling
 * needed to prove the lane), speaking the unchanged wire over postMessage,
 * exactly as the composition wires it. The worker construction stays a
 * bundler-visible literal at the CALL SITE (the spec's `new URL(...)`), per
 * the useWorker factory ruling.
 *
 * `env` carries the faculty's env-data — worker-threads environment data,
 * seeded BEFORE the worker boots (the entry reads it once at module
 * evaluation).
 */

export type FacultyResult = {
  id: string
  detail: Record<string, unknown>
  space?: string
}

/** The worker-shape harness type. */
export type FacultyWorker = {
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
  env,
}: {
  /** The worker entry URL — `new URL('<relative entry>', import.meta.url)` at the call site. */
  url: URL
  requestType: string
  resultType: string
  /** Worker-threads environment data, seeded before the worker boots (`undefined` resets the key). */
  env?: Record<string, Serializable | undefined>
}): FacultyWorker => {
  for (const [key, value] of Object.entries(env ?? {})) setEnvironmentData(key, value)
  const worker = new Worker(url)
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
