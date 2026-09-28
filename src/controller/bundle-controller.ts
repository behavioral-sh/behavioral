/**
 * Bundles the controller runtime into a gzipped module served at the connect
 * route. The bundled module reads `modules` query params, loads any extension
 * modules, constructs a {@link Controller}, and connects.
 */

/** HTTP route where the bundled controller JS is served. */
export const CONNECT_BEHAVIORAL_ROUTE = '/.behavioral/connect.js'

/**
 * The carrier the bundled connect entry constructs the Controller with.
 *
 * - `'worker'` (the controller's default): the composition boots in the
 *   bProgram worker, spawned from the conventional `B_PROGRAM_WORKER_PATH`
 *   serving path — the host must serve the bundled worker at that route.
 * - `'websocket'`: the thin-GUI-client carrier — the page talks to a remote
 *   serve.ts/socket-host over the WebSocket transport, deriving the WS URL
 *   from the page location (the pre-worker default).
 */
export type ControllerBundleCarrier = 'worker' | 'websocket'

/**
 * Virtual entrypoint path for Bun.build. Must match a key in the `files` map.
 * Bun transpiles the `.ts` extension natively, and virtual files from the `files`
 * option take priority over disk — no actual file needs to exist at this path.
 */
const VIRTUAL_ENTRY = '/.behavioral/connect.ts'

/**
 * Bundles the controller runtime into a gzipped module served at the connect
 * route. The bundled module reads `modules` query params, loads any extension
 * modules, constructs a {@link Controller}, and connects.
 *
 * With `dev: true` the bundle is built unminified per call — the caller
 * rebundles on every request instead of caching the production artifact.
 *
 * `carrier` selects the transport the bundled entry constructs the
 * Controller with (default `'worker'`); the websocket carrier additionally
 * bundles the WebSocket transport module.
 */
export const bundleController = async ({
  dev = false,
  carrier = 'worker',
}: {
  dev?: boolean
  carrier?: ControllerBundleCarrier
} = {}) => {
  const controllerEntry = Bun.resolveSync('../controller.ts', import.meta.dir)
  const websocketEntry = Bun.resolveSync('./websocket-transport.ts', import.meta.dir)
  const carrierImport =
    carrier === 'websocket' ? `\nimport { WebSocketTransport } from ${JSON.stringify(websocketEntry)}` : ''
  const carrierOption =
    carrier === 'websocket' ? `,\n  transport: new WebSocketTransport(self.location.href.replace(/^http/, 'ws'))` : ''
  const entrySource = `
import { Controller } from ${JSON.stringify(controllerEntry)}${carrierImport}

const params = new URL(import.meta.url).searchParams

// Load optional extension modules specified as comma-separated paths.
// Each module must export:
//   - key: the b-trigger pair string this extension handles (e.g. "click:my_action")
//   - default: a ControllerExtension function
const modulePaths = (params.get('modules') ?? '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
const extEntries = await Promise.all(
  modulePaths.map(async function (path) {
    const mod = await import(path)
    if (typeof mod.key !== 'string') {
      throw new Error(
        'Extension module "' + path + '" is missing a string key export. ' +
        'Each extension module must export a key string (e.g. "click:my_action").',
      )
    }
    if (typeof mod.default !== 'function') {
      throw new Error(
        'Extension module "' + path + '" has invalid default export. Expected a function, got ' + typeof mod.default + '.',
      )
    }
    return [mod.key, mod.default]
  }),
)
const extensions = new Map(extEntries)

const controller = new Controller({ extensions${carrierOption} })
controller.connect()
`
  const { outputs, logs, success } = await Bun.build({
    entrypoints: [VIRTUAL_ENTRY],
    files: {
      [VIRTUAL_ENTRY]: entrySource,
    },
    minify: !dev,
    target: 'browser',
  })
  if (!success) {
    throw new AggregateError(logs, 'Failed to build behavioral controller runtime')
  }
  const artifact = outputs[0]!
  const content = await artifact.text()
  const compressed = Bun.gzipSync(content)
  return {
    [CONNECT_BEHAVIORAL_ROUTE]: new Response(compressed as BodyInit, {
      headers: new Headers({
        'content-type': artifact.type,
        'content-encoding': 'gzip',
      }),
    }),
  }
}
