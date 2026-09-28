/**
 * Fixture server for the worker-transport WebView probe — the serving
 * contract's proof (bProgram browser shape, Slice 0).
 *
 * The worker URL is a SERVING CONTRACT, not a bundler-detected entry: Bun
 * does not detect `new Worker(new URL(...))` for browser targets (open
 * enhancement oven-sh/bun#18601), so a serving side must emit the bundled
 * worker at the conventional {@link B_PROGRAM_WORKER_PATH}. This fixture is
 * the minimal serving side: it bundles the stub bProgram worker and mounts it
 * at the conventional path. SERVING-MECHANISM FINDING (probe-pinned):
 * `new Response(artifact)` sets an automatic ETag but does NOT set a
 * Content-Type (the artifact's `text/javascript` type is not propagated) —
 * and Chromium requires a javascript MIME type for module scripts — so the
 * serving side passes the artifact's own type as the response header.
 *
 * Serves two probe pages over real bundled entries:
 *   - `/worker-probe.html` — the raw `.ts`-URL worker probe + the transport's
 *     status observation (`window.__workerProbe`).
 *   - `/controller-default.html` — the controller booted with NO injected
 *     transport; the default must reach the stub worker and the DOM carries
 *     the echo markers (`window.__defaultProbe`).
 *
 * `withWorkerRoute: false` mounts everything EXCEPT the worker route — the
 * no-route leg (the default's failure is visible as a status event, never a
 * page throw).
 */
import { join } from 'node:path'
import { B_PROGRAM_WORKER_PATH } from '../../worker-transport.ts'

const FIXTURES_DIR = import.meta.dir

const buildPage = async (entry: string) => {
  const { outputs, logs, success } = await Bun.build({ entrypoints: [entry], target: 'browser', minify: false })
  if (!success) throw new AggregateError(logs, `Failed to build ${entry}`)
  return outputs[0]!
}

const workerPage = (script: string) =>
  `<!DOCTYPE html><html><head><script type="module" src="${script}"></script></head><body></body></html>`

const defaultPage = (script: string) =>
  `<!DOCTYPE html><html><head><script type="module" src="${script}"></script></head><body>
  <div b-target="main"><p id="initial">initial</p></div>
  <button id="default-btn" b-trigger="click:do_thing">Go</button>
</body></html>`

/** Handle to a running worker-probe fixture server. */
export type WorkerProbeServer = {
  port: number
  stop: () => Promise<void>
}

/** Start the worker-probe fixture server (`withWorkerRoute: false` omits the conventional worker route). */
export const startWorkerProbeServer = async ({
  port = 0,
  withWorkerRoute = true,
}: {
  port?: number
  withWorkerRoute?: boolean
} = {}): Promise<WorkerProbeServer> => {
  const workerArtifact = await buildPage(join(FIXTURES_DIR, 'stub-b-program.worker.ts'))
  const probeArtifact = await buildPage(join(FIXTURES_DIR, 'worker-probe.page.ts'))
  const defaultArtifact = await buildPage(join(FIXTURES_DIR, 'controller-default.page.ts'))

  const routes: Record<string, (request: Request) => Response> = {
    '/health': () => new Response('OK'),
    '/worker-probe.html': () =>
      new Response(workerPage('/dist/worker-probe.js'), {
        headers: { 'Content-Type': 'text/html' },
      }),
    '/controller-default.html': () =>
      new Response(defaultPage('/dist/controller-default.js'), {
        headers: { 'Content-Type': 'text/html' },
      }),
    // A Response body can be consumed once — serve lazily, per request.
    '/dist/worker-probe.js': () => new Response(probeArtifact, { headers: { 'Content-Type': probeArtifact.type } }),
    '/dist/controller-default.js': () =>
      new Response(defaultArtifact, {
        headers: { 'Content-Type': defaultArtifact.type },
      }),
  }
  if (withWorkerRoute) {
    routes[B_PROGRAM_WORKER_PATH] = () =>
      new Response(workerArtifact, {
        headers: { 'Content-Type': workerArtifact.type },
      })
  }

  const server = Bun.serve({
    port,
    routes,
    fetch() {
      return new Response('Not Found', { status: 404 })
    },
  })
  return {
    port: server.port!,
    stop: async () => {
      server.stop(true)
    },
  }
}
