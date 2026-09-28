import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { ACTUATOR_MESSAGE_KINDS } from '.././actuators.constants.ts'
import type { StoreOp } from '../actuators.types.ts'
import { STORE_DB_PATH_KEY } from '.././store.types.ts'
import { spawnFaculty } from './faculty-harness.ts'

/**
 * Store worker integration tests — exercised through the real worker boundary
 * speaking the behavioral event wire: `store_request` events in (dispatched
 * by `detail.op`), one `store_request_result` out.
 *
 * @remarks
 * Hermetic by default: `:memory:` backs every test via environment data
 * (the host-injected db path — the same seeding contract as the responses
 * endpoints). One test proves file-backed persistence across spawns.
 *
 * @packageDocumentation
 */

type WireResult = {
  id: string
  ok: boolean
  result?: unknown
  error?: Record<string, unknown>
  ctx?: unknown
  space?: string
}

/** Spawn the store faculty PROCESS and expose the same wire harness API. */
const spawnStoreWorker = (dbPath = ':memory:') => {
  const faculty = spawnFaculty({
    file: 'store.actuator.ts',
    requestType: ACTUATOR_MESSAGE_KINDS.store_request,
    resultType: ACTUATOR_MESSAGE_KINDS.store_request_result,
    // Env vars cross Bun.spawn boundaries; worker-thread env-data does not.
    env: { [STORE_DB_PATH_KEY]: dbPath },
  })
  const call = (id: string, op: StoreOp, input: unknown, space?: string, ctx?: JsonObject): void => {
    faculty.call({ id, op, input, ...(ctx === undefined ? {} : { ctx }) } as JsonObject, space)
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const raw = await faculty.resultFor(id)
    return { ...raw.detail, id: raw.id, space: raw.space } as WireResult
  }
  return { call, resultFor, terminate: (): void => faculty.terminate() }
}

describe('store worker — event wire', () => {
  test('a put returns ok', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'runs', key: 'r1', value: { hello: true } })
      const { id, ok } = await store.resultFor('s1')
      expect(id).toBe('s1')
      expect(ok).toBe(true)
    } finally {
      store.terminate()
    }
  })

  test('request ctx echoes on the result — the thread join lane', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'c', key: 'k', value: {} }, undefined, {
        echo: { leg: 'design', scale: 's3' },
      })
      const { ok, ctx } = await store.resultFor('s1')
      expect(ok).toBe(true)
      expect(ctx).toEqual({ echo: { leg: 'design', scale: 's3' } })
    } finally {
      store.terminate()
    }
  })

  test('request ctx echoes on the error branch too', async () => {
    const store = spawnStoreWorker()
    try {
      // get without a key — invalid input, the typed error result
      store.call('s1', 'get', { collection: 'c' }, undefined, { echo: { leg: 'design' } })
      const { ok, ctx } = await store.resultFor('s1')
      expect(ok).toBe(false)
      expect(ctx).toEqual({ echo: { leg: 'design' } })
    } finally {
      store.terminate()
    }
  })

  test('a request space is echoed on the result event', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'get', { collection: 'c', key: 'k' }, 's1')
      const { space } = await store.resultFor('s1')
      expect(space).toBe('s1')
    } finally {
      store.terminate()
    }
  })

  test('input failing the boundary schema is error data', async () => {
    const store = spawnStoreWorker()
    try {
      // put without a key
      store.call('s1', 'put', { collection: 'c', value: {} })
      const { ok, error } = await store.resultFor('s1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('invalid input')
    } finally {
      store.terminate()
    }
  })

  test('an op outside the enum is dropped at the trust boundary — no result', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'purge' as StoreOp, {})
      store.call('s2', 'get', { collection: 'c', key: 'k' })
      const { id } = await store.resultFor('s2')
      expect(id).toBe('s2')
    } finally {
      store.terminate()
    }
  })

  test('a space key inside op input is rejected — space comes from the envelope, never the input', async () => {
    const store = spawnStoreWorker()
    try {
      // additionalProperties: false — the isolation floor at the boundary.
      store.call('s1', 'put', { collection: 'c', key: 'k', value: {}, space: 'other-space' })
      const { ok, error } = await store.resultFor('s1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('invalid input')
    } finally {
      store.terminate()
    }
  })
})

describe('store worker — put/get', () => {
  test('get returns the stored value', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'runs', key: 'r1', value: { status: 'done' } })
      await store.resultFor('s1')
      store.call('s2', 'get', { collection: 'runs', key: 'r1' })
      const { result } = await store.resultFor('s2')
      expect((result as { value?: JsonObject }).value).toEqual({ status: 'done' })
    } finally {
      store.terminate()
    }
  })

  test('get of a missing key is null, not an error', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'get', { collection: 'runs', key: 'nope' })
      const { result } = await store.resultFor('s1')
      expect((result as { value?: JsonObject | null }).value).toBeNull()
    } finally {
      store.terminate()
    }
  })

  test('put upserts — the second put replaces the value', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'runs', key: 'r1', value: { a: 1 } })
      await store.resultFor('s1')
      store.call('s2', 'put', { collection: 'runs', key: 'r1', value: { b: 2 } })
      await store.resultFor('s2')
      store.call('s3', 'get', { collection: 'runs', key: 'r1' })
      const { result } = await store.resultFor('s3')
      expect((result as { value?: JsonObject }).value).toEqual({ b: 2 })
    } finally {
      store.terminate()
    }
  })
})

describe('store worker — delete', () => {
  test('delete of an existing key reports deleted true, then get is null', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'c', key: 'k', value: {} })
      await store.resultFor('s1')
      store.call('s2', 'delete', { collection: 'c', key: 'k' })
      const { result } = await store.resultFor('s2')
      expect((result as { deleted?: boolean }).deleted).toBe(true)
      store.call('s3', 'get', { collection: 'c', key: 'k' })
      const after = await store.resultFor('s3')
      expect((after.result as { value?: JsonObject | null }).value).toBeNull()
    } finally {
      store.terminate()
    }
  })

  test('delete of a missing key reports deleted false', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'delete', { collection: 'c', key: 'nope' })
      const { result } = await store.resultFor('s1')
      expect((result as { deleted?: boolean }).deleted).toBe(false)
    } finally {
      store.terminate()
    }
  })
})

describe('store worker — query', () => {
  test('an empty filter enumerates the whole collection', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'catalog', key: 'a', value: { kind: 'skill' } })
      await store.resultFor('s1')
      store.call('s2', 'put', { collection: 'catalog', key: 'b', value: { kind: 'tool' } })
      await store.resultFor('s2')
      store.call('s3', 'put', { collection: 'other', key: 'c', value: { kind: 'skill' } })
      await store.resultFor('s3')
      store.call('s4', 'query', { collection: 'catalog' })
      const { result } = await store.resultFor('s4')
      const rows = (result as { rows?: Array<{ key: string }> }).rows!
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.key).sort()).toEqual(['a', 'b'])
    } finally {
      store.terminate()
    }
  })

  test('a filter matches shallow value fields', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'catalog', key: 'a', value: { kind: 'skill', name: 'git' } })
      await store.resultFor('s1')
      store.call('s2', 'put', { collection: 'catalog', key: 'b', value: { kind: 'tool' } })
      await store.resultFor('s2')
      store.call('s3', 'query', { collection: 'catalog', filter: { kind: 'skill' } })
      const { result } = await store.resultFor('s3')
      const rows = (result as { rows?: Array<{ key: string }> }).rows!
      expect(rows).toHaveLength(1)
      expect(rows[0]!.key).toBe('a')
    } finally {
      store.terminate()
    }
  })

  test('a non-matching filter returns an empty row set, not an error', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'catalog', key: 'a', value: { kind: 'skill' } })
      await store.resultFor('s1')
      store.call('s2', 'query', { collection: 'catalog', filter: { kind: 'nope' } })
      const { result } = await store.resultFor('s2')
      expect((result as { rows?: unknown[] }).rows).toEqual([])
    } finally {
      store.terminate()
    }
  })
})

describe('store worker — space scoping', () => {
  test('rows are scoped to the request space; the root default sees only root rows', async () => {
    const store = spawnStoreWorker()
    try {
      store.call('s1', 'put', { collection: 'ledger', key: 'k', value: { n: 1 } }, 'space-1')
      await store.resultFor('s1')
      // A root request cannot see space-1's row.
      store.call('s2', 'get', { collection: 'ledger', key: 'k' })
      const rootGet = await store.resultFor('s2')
      expect((rootGet.result as { value?: JsonObject | null }).value).toBeNull()
      // The spaced request can.
      store.call('s3', 'get', { collection: 'ledger', key: 'k' }, 'space-1')
      const spacedGet = await store.resultFor('s3')
      expect((spacedGet.result as { value?: JsonObject }).value).toEqual({ n: 1 })
      // Queries are scoped too.
      store.call('s4', 'query', { collection: 'ledger' }, 'space-1')
      const spacedQuery = await store.resultFor('s4')
      expect((spacedQuery.result as { rows?: unknown[] }).rows).toHaveLength(1)
      store.call('s5', 'query', { collection: 'ledger' })
      const rootQuery = await store.resultFor('s5')
      expect((rootQuery.result as { rows?: unknown[] }).rows).toEqual([])
    } finally {
      store.terminate()
    }
  })
})

describe('store worker — persistence', () => {
  test('data survives worker termination and respawn on a file-backed db', async () => {
    const dbFile = join(tmpdir(), `store-spec-${crypto.randomUUID()}.sqlite`)
    const first = spawnStoreWorker(dbFile)
    try {
      first.call('s1', 'put', { collection: 'runs', key: 'r1', value: { turn: 42 } })
      await first.resultFor('s1')
    } finally {
      first.terminate()
    }
    const second = spawnStoreWorker(dbFile)
    try {
      second.call('s2', 'get', { collection: 'runs', key: 'r1' })
      const { result } = await second.resultFor('s2')
      expect((result as { value?: JsonObject }).value).toEqual({ turn: 42 })
    } finally {
      second.terminate()
      await Bun.$`rm -f ${dbFile}*`.nothrow().quiet()
    }
  })

  test('defaults the db path to $BEHAVIORAL_HOME/db.sqlite when no key is seeded', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-home-'))
    // No STORE_DB_PATH_KEY: BEHAVIORAL_HOME alone must drive the db path.
    const faculty = spawnFaculty({
      file: 'store.actuator.ts',
      requestType: ACTUATOR_MESSAGE_KINDS.store_request,
      resultType: ACTUATOR_MESSAGE_KINDS.store_request_result,
      env: { BEHAVIORAL_HOME: home },
    })
    try {
      faculty.call({ id: 'h1', op: 'put', input: { collection: 'runs', key: 'r', value: { turn: 1 } } })
      const { detail } = await faculty.resultFor('h1')
      expect(detail.ok).toBe(true)
      expect(await Bun.file(join(home, 'db.sqlite')).exists()).toBe(true)
    } finally {
      faculty.terminate()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
