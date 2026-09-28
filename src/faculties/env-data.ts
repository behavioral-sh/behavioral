import { getEnvironmentData } from 'node:worker_threads'

/**
 * The env-data bridge — the shelf's pattern, worker-shaped: worker-threads
 * environment data first (the host seeds it BEFORE constructing the Worker —
 * the entry reads it once at module evaluation), process env second
 * (JSON-stringified values parse back into objects).
 *
 * MINIMAL: the Bun-side bridge only. A browser classic bundle cannot carry
 * the node:worker_threads import — the browser path delivers the faculty's
 * config via the CONSTRUCTION MESSAGE at the rewire; the seam is
 * createWorker's `data` param, which is host-agnostic.
 */
export const envData = (key: string): unknown => {
  const fromThread = getEnvironmentData(key)
  if (fromThread !== undefined) return fromThread
  const fromEnv = process.env[key]
  if (fromEnv === undefined) return undefined
  try {
    return JSON.parse(fromEnv)
  } catch {
    return fromEnv
  }
}
