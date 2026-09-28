import { type Serializable, setEnvironmentData } from 'node:worker_threads'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'

/**
 * The faculty spec harness — every faculty spec's spawn shapes, both lanes:
 *
 * - `spawnFaculty` — the faculty runs as a Bun.spawn PROCESS speaking the
 *   unchanged wire over stdio lines (one JSON event per line), exactly as the
 *   old composition spawns it.
 * - `spawnFacultyWorker` — the faculty runs as a REAL Bun web Worker running
 *   the TS entry directly (no bundling needed to prove the lane), speaking
 *   the unchanged wire over postMessage, exactly as the composition wires it.
 *   The worker construction stays a bundler-visible literal at the CALL SITE
 *   (the spec's `new URL(...)`), per the useWorker factory ruling.
 *
 * Both return the same call/resultFor/post/terminate contract.
 * `env` carries the faculty's env-data: process env vars for the process
 * shape; worker-threads environment data (set BEFORE the worker boots — the
 * entry reads it once at module evaluation) for the worker shape.
 */

export type FacultyResult = {
  id: string
  detail: Record<string, unknown>
  space?: string
}

export const spawnFaculty = ({
  file,
  requestType,
  resultType,
  env,
}: {
  file: string
  requestType: string
  resultType: string
  env?: Record<string, string>
}) => {
  const proc = Bun.spawn(['bun', 'run', file], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    cwd: `${import.meta.dir}/..`,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  const results: FacultyResult[] = []
  const pump = (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let carry = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const message = JSON.parse(trimmed) as { type: string; detail: { id: string } & JsonObject; space?: string }
          if (message.type === resultType) {
            results.push({
              id: message.detail.id,
              detail: message.detail as Record<string, unknown>,
              space: message.space,
            })
          }
        } catch {
          // Discard malformed.
        }
      }
    }
  })()
  void pump

  const write = (event: { type: string; detail: JsonObject; space?: string }): void => {
    proc.stdin.write(`${JSON.stringify(event)}\n`)
  }
  return {
    call: (detail: JsonObject, space?: string): void => {
      write({ type: requestType, detail, ...(space === undefined ? {} : { space }) })
    },
    post: write,
    resultFor: async (id: string): Promise<FacultyResult> => {
      const deadline = Date.now() + 10_000
      for (;;) {
        const found = results.find((r) => r.id === id)
        if (found !== undefined) return found
        if (Date.now() > deadline)
          throw new Error(`no result for ${id}; saw: ${JSON.stringify(results.map((r) => r.id))}`)
        await Bun.sleep(10)
      }
    },
    terminate: (): void => {
      proc.kill()
      void pump
    },
  }
}

/** The worker-shape harness result — same contract as the process shape. */
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
