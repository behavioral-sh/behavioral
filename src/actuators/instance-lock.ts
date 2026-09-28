import { join } from 'node:path'

/**
 * The instance pidfile — `<home>/instance.pid`, the single-instance lock.
 *
 * @remarks
 * The running instance owns `<home>/instance.pid` for its whole lifetime; the
 * launcher (attach-or-start) reads it to detect a live instance and attaches
 * instead of starting a second one. A pidfile whose pid is no longer alive is
 * stale: acquisition reaps it and takes the lock. The pidfile is deleted on
 * release (SIGINT/SIGTERM terminate path).
 *
 * @public
 */
export const instancePidfilePath = (home: string): string => join(home, 'instance.pid')

/** True when a process with this pid exists (signal 0 probes liveness). */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not signalable by us — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Delete the pidfile if present (Bun file IO; missing file is a no-op). */
const removePidfile = async (path: string): Promise<void> => {
  // ENOENT means already gone — force semantics.
  await Bun.file(path)
    .delete()
    .catch(() => {})
}

/**
 * The acquired instance lock — `release()` removes the pidfile.
 *
 * @public
 */
export type InstanceLock = { acquired: true; release: () => Promise<void> }

/**
 * The lock is held: a live instance owns the home; `pid` is its pid.
 *
 * @public
 */
export type InstanceLockHeld = { acquired: false; pid: number }

/**
 * Acquire the single-instance lock under `home`: write `instance.pid` if the
 * home is free (no pidfile, or a stale one whose pid is dead — reaped first).
 *
 * @param home - The harness home (the single `<home>` root).
 * @param pid - The pid to record; defaults to the current process.
 * @returns The lock (with its `release`) when acquired, or the live pid that
 *          holds it.
 *
 * @public
 */
export const acquireInstanceLock = async ({
  home,
  pid = process.pid,
}: {
  home: string
  pid?: number
}): Promise<InstanceLock | InstanceLockHeld> => {
  const path = instancePidfilePath(home)
  if (await Bun.file(path).exists()) {
    let holder: number | undefined
    try {
      const parsed: unknown = await Bun.file(path).json()
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { pid?: unknown }).pid === 'number') {
        holder = (parsed as { pid: number }).pid
      }
    } catch {
      // Unreadable pidfile: treat as stale, reaped below.
    }
    if (holder !== undefined && pidAlive(holder)) return { acquired: false, pid: holder }
    await removePidfile(path)
  }
  await Bun.write(path, JSON.stringify({ pid }))
  return { acquired: true, release: () => removePidfile(path) }
}
