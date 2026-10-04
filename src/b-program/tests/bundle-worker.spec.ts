import { describe, expect, test } from 'bun:test'
import { B_PROGRAM_WORKER_PATH } from '../../controller/worker-transport.ts'
import { bundleBProgramWorker, connectSrcPolicy } from '../bundle-worker.ts'

/**
 * The serving seam — the host's bundle for the conventional worker route
 * (Bun-only level). Pinned: the route is the controller's conventional spawn
 * path, the artifact is the SELF-BOOTING wrapper (the entry's boot seam is
 * invoked at the bundle's top level), the compile-time thread packs ride as
 * data, prod ships gzipped with a javascript content-type, and the CSP
 * `connect-src` allow-list is the serving side's config shape.
 */
describe('bundleBProgramWorker — the serving seam', () => {
  test('the route is the controller\u2019s conventional spawn path', async () => {
    const routes = await bundleBProgramWorker()
    expect(Object.keys(routes)).toEqual([B_PROGRAM_WORKER_PATH])
  })

  test('the artifact is the self-booting wrapper over the composition entry', async () => {
    const routes = await bundleBProgramWorker()
    const response = routes[B_PROGRAM_WORKER_PATH]!
    expect(response.headers.get('content-type')?.startsWith('text/javascript')).toBe(true)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    const body = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())))
    // The wire markers survive minification: the port protocol and the
    // composition's faculty-worker literals (the bundler-visible `new
    // Worker` factories). The boot seam's NAME is pinned in dev (the next
    // test) — minification renames it in prod.
    expect(body).toContain('attach')
    expect(body).toContain('system-one.faculty.ts')
    expect(body).toContain('system-two.faculty.ts')
  })

  test('the dev artifact names the boot seam — the wrapper invokes it at the top level', async () => {
    const routes = await bundleBProgramWorker({ dev: true })
    const body = new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await routes[B_PROGRAM_WORKER_PATH]!.arrayBuffer())),
    )
    expect(body).toContain('runCompositionWorker()')
  })

  test('compile-time thread packs ride the wrapper as data (dev names the call)', async () => {
    const pack = [{ name: 'p', description: 'Test thread.', rules: [{ request: { type: 'x' } }] }]
    const routes = await bundleBProgramWorker({ dev: true, threads: pack })
    const body = new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await routes[B_PROGRAM_WORKER_PATH]!.arrayBuffer())),
    )
    expect(body).toContain('runCompositionWorker({ threads:')
    // Bun's dev build reformats the inlined object literal — pin the pack's
    // own values, not the serialized shape.
    expect(body).toContain('"p"')
    expect(body).toContain('"x"')
  })

  test('dev mode builds unminified (rebundle-per-request callers)', async () => {
    const prod = new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await (await bundleBProgramWorker())[B_PROGRAM_WORKER_PATH]!.arrayBuffer())),
    )
    const dev = new TextDecoder().decode(
      Bun.gunzipSync(
        new Uint8Array(await (await bundleBProgramWorker({ dev: true }))[B_PROGRAM_WORKER_PATH]!.arrayBuffer()),
      ),
    )
    expect(dev.length).toBeGreaterThan(prod.length)
  })

  test('connectSrcPolicy — the allow-list is config, self always included', () => {
    expect(connectSrcPolicy()).toBe("connect-src 'self'")
    expect(connectSrcPolicy(['https://openrouter.ai', 'wss://daemon.example'])).toBe(
      "connect-src 'self' https://openrouter.ai wss://daemon.example",
    )
  })
})
