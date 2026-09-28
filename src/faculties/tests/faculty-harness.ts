import type { JsonObject } from '../../behavioral/behavioral.types.ts'

/**
 * The faculty-process spec harness — every faculty spec's spawn shape: the
 * faculty runs as a Bun.spawn PROCESS speaking the unchanged wire over stdio
 * lines (one JSON event per line), exactly as the composition spawns it.
 *
 * - `call(id, detail)` writes a request line (the request's `type` rides the
 *   caller's event shape — pass the full detail; the request type is the
 *   faculty's)
 * - `resultFor(id)` polls the stdout line stream for the correlated result
 * - `post(event)` writes any wire event (cancels)
 * - `terminate()` kills the process (the spec owns the lifecycle)
 *
 * `env` carries the faculty's env-data (the bridge: env vars, not
 * setEnvironmentData — spawned processes inherit env vars only).
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
