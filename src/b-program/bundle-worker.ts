/**
 * The bProgram worker's serving seam — the bundle the host emits at the
 * conventional {@link B_PROGRAM_WORKER_PATH} (the controller's default
 * carrier spawns a dedicated module Worker there; the URL is a serving
 * contract, not a bundler-detected entry). Mirrors `bundleController`'s
 * shape: prod builds once and caches, dev rebuilds per request; the artifact
 * travels gzipped.
 *
 * The bundled entry is the SELF-BOOTING WRAPPER: the worker entry is a
 * library shape (`runCompositionWorker` is the boot seam), so the served
 * artifact imports it and calls it — the shelf's fixture-entry precedent.
 * The wrapper's options are the compile-time thread packs (data — JSON-
 * inlined); the actuator leg defaults to the socket-lane trio over the
 * daemon bridge.
 *
 * @packageDocumentation
 */

import { B_PROGRAM_WORKER_PATH } from '../controller/worker-transport.ts'
import type { CompositionWorkerOptions } from './b-program.worker.ts'

/** HTTP route where the bundled bProgram worker is served (the controller's conventional spawn path). */
export const B_PROGRAM_WORKER_ROUTE: string = B_PROGRAM_WORKER_PATH

/** The virtual entrypoint path for Bun.build — a key in the `files` map, no disk file. */
const VIRTUAL_ENTRY = '/.behavioral/b-program.worker.ts'

/**
 * Bundle the self-booting bProgram worker. `threads` rides the wrapper as
 * compile-time data (the host-minted policy packs); the actuator leg takes
 * the entry's default (the socket-lane trio over the daemon bridge).
 *
 * @public
 */
export const bundleBProgramWorker = async ({
  dev = false,
  threads,
}: {
  /** Rebundle per request instead of caching the production artifact. */
  dev?: boolean
  /** The host-minted policy packs, inlined as compile-time data. */
  threads?: CompositionWorkerOptions['threads']
} = {}) => {
  const entry = Bun.resolveSync('./b-program.worker.ts', import.meta.dir)
  const bootCall =
    threads === undefined ? 'runCompositionWorker()' : `runCompositionWorker({ threads: ${JSON.stringify(threads)} })`
  const entrySource = `
import { runCompositionWorker } from ${JSON.stringify(entry)}

${bootCall}
`
  const { outputs, logs, success } = await Bun.build({
    entrypoints: [VIRTUAL_ENTRY],
    files: { [VIRTUAL_ENTRY]: entrySource },
    minify: !dev,
    target: 'browser',
  })
  if (!success) throw new AggregateError(logs, 'Failed to build the bProgram worker bundle')
  const artifact = outputs[0]!
  const content = await artifact.text()
  const compressed = Bun.gzipSync(content)
  return {
    [B_PROGRAM_WORKER_ROUTE]: new Response(compressed as BodyInit, {
      headers: new Headers({
        'content-type': artifact.type,
        'content-encoding': 'gzip',
      }),
    }),
  }
}

/**
 * The page CSP's `connect-src` allow-list — the daemon origin + the proxied
 * provider origins (the inference-transport slice owns the provider list;
 * the SHAPE lands here, the list is the serving side's config). `'self'` is
 * always included: the composition worker, the connect bundle, and the
 * same-origin daemon bridge all ride the page's own origin.
 *
 * @public
 */
export const connectSrcPolicy = (connectSrc: string[] = []): string =>
  `connect-src 'self'${connectSrc.length > 0 ? ` ${connectSrc.join(' ')}` : ''}`
