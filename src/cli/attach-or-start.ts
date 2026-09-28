import { acquireInstanceLock } from '../actuators/instance-lock.ts'
import { behavioralHome } from '../old-faculties/behavioral-home.ts'
import { attachTui } from './attach.ts'
import type { HostRuntime } from './serve.ts'
import { createSocketHost, instanceSocketPath } from './socket-host.ts'

/**
 * The composition default: the runtime graph from `<home>/config.ts`. Loaded
 * lazily — an attaching process never pays for the composition graph.
 */
const defaultCreateRuntime = async (): Promise<HostRuntime> => {
  const { bProgram } = await import('./b-program.ts')
  const { loadConfig } = await import('./load-config.ts')
  return bProgram(await loadConfig())
}

export type AttachOrStartOptions = {
  /** The single `<home>` root; defaults to `behavioralHome()`. */
  home?: string
  /**
   * Start-time only: serve the controller GUI with per-request rebundling.
   * An attaching process cannot flip a running instance — the flag reaches
   * the instance the caller starts, never one it attaches to.
   */
  dev?: boolean
  /** The TUI's line source; defaults to stdin. */
  input?: NodeJS.ReadableStream
  /** The TUI's terminal writer; defaults to stdout. */
  write?: (text: string) => void
  /** The runtime factory; defaults to `bProgram(await loadConfig())`. */
  createRuntime?: () => HostRuntime | Promise<HostRuntime>
}

export type AttachOrStartResult = {
  attached: boolean
  instanceId?: string
}

/**
 * The bare `behavioral` entry — attach-or-start, never second-instance.
 *
 * @remarks
 * A live instance (pidfile held) is attached to over `<home>/instance.sock`
 * with the notice `attached to running instance <id>`; a free or stale home is
 * started fresh: engine + unix-socket host + TUI in one foreground process.
 * The instance's own TUI rides the socket like every other client. In the
 * start mode, SIGINT/SIGTERM terminate the engine and clean up the pidfile and
 * socket — the daemon-door discipline.
 *
 * @public
 */
export const attachOrStart = async ({
  home = behavioralHome(),
  input = process.stdin,
  write = (text: string): void => {
    process.stdout.write(text)
  },
  createRuntime = defaultCreateRuntime,
  dev = false,
}: AttachOrStartOptions = {}): Promise<AttachOrStartResult> => {
  const lock = await acquireInstanceLock({ home })
  if (!lock.acquired) {
    // Attach: the TUI is a second client on the local lane.
    const result = await attachTui({
      socketPath: instanceSocketPath(home),
      input,
      write,
      onAttach: (id) => write(`attached to running instance ${id}\n`),
    })
    return { attached: true, instanceId: result.instanceId }
  }

  // Start: foreground engine + socket host + TUI (a socket client like every
  // other client — no in-process fast path).
  const runtime = await createRuntime()
  const host = await createSocketHost({ runtime, home, dev })
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await host.close()
    runtime.terminate()
    await lock.release()
  }
  const onSignal = (): void => {
    void cleanup().then(() => process.exit(0))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  runtime.start()
  const result = await attachTui({ socketPath: host.path, input, write })
  await cleanup()
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  return { attached: false, instanceId: result.instanceId }
}
