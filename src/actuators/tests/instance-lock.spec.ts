import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock, type InstanceLock, instancePidfilePath } from '../instance-lock.ts'

const tempHome = (): string => mkdtempSync(join(tmpdir(), 'behavioral-instance-lock-'))

/** Assert acquisition succeeded, returning the narrowed lock. */
const acquired = (lock: InstanceLock | { acquired: false; pid: number }): InstanceLock => {
  expect(lock.acquired).toBe(true)
  if (!lock.acquired) throw new Error(`expected acquisition, blocked by pid ${lock.pid}`)
  return lock
}

describe('acquireInstanceLock', () => {
  test('acquiring a free home writes the pidfile with the given pid', async () => {
    const home = tempHome()
    try {
      const lock = acquired(await acquireInstanceLock({ home, pid: 4242 }))
      const path = instancePidfilePath(home)
      expect(await Bun.file(path).exists()).toBe(true)
      expect(await Bun.file(path).json()).toEqual({ pid: 4242 })
      await lock.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a pidfile held by a live pid blocks acquisition and reports the pid', async () => {
    const home = tempHome()
    try {
      await acquireInstanceLock({ home, pid: process.pid })
      const second = await acquireInstanceLock({ home, pid: 1 })
      expect(second.acquired).toBe(false)
      if (!second.acquired) expect(second.pid).toBe(process.pid)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a stale pidfile (pid no longer alive) is reaped and acquisition succeeds', async () => {
    const home = tempHome()
    const path = instancePidfilePath(home)
    // A pid that cannot exist: high fixed value, no process holds it. EPERM
    // would mean "alive but unkillable", so assert the kill probe fails first.
    const deadPid = 999_999_999
    // Guard the assumption: the pid does not exist (ESRCH), so it is stale.
    try {
      process.kill(deadPid, 0)
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH')
    }
    await Bun.write(path, JSON.stringify({ pid: deadPid }))
    const lock = acquired(await acquireInstanceLock({ home, pid: process.pid }))
    expect(await Bun.file(path).json()).toEqual({ pid: process.pid })
    await lock.release()
  })

  test('release removes the pidfile', async () => {
    const home = tempHome()
    try {
      const lock = acquired(await acquireInstanceLock({ home, pid: process.pid }))
      await lock.release()
      expect(await Bun.file(instancePidfilePath(home)).exists()).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
