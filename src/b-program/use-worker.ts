import type { ValidateFunction } from 'ajv'
import type { BPEvent, JsonObject } from '../behavioral/behavioral.types.ts'
import { INIT_FRAME_KIND, type InitFrame } from '../faculties/create-worker.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import type { AddThreads } from '../faculties/faculties.types.ts'

/**
 * The composition-side worker wiring — the successor of `useFaculty` (the
 * process-spawn primitive), for the faculties-first route: every faculty is
 * a web worker on every host, wired over `postMessage` instead of stdio.
 *
 * @remarks
 * MINIMAL: the composition itself still lives in `src/cli/` until the
 * rewire — this home (`src/b-program/`) is the composition-side wiring
 * destination, and the composition moves here wholesale at the rewire.
 *
 * The worker construction is a FACTORY at the call site —
 * `worker: () => new Worker(new URL(...))` — so the literal stays
 * bundler-visible in the caller (Bun respects literals it can see; hiding
 * construction behind a path string invites bundling trouble) AND the
 * wiring can respawn after a crash by re-invoking it.
 *
 * The wiring takes the wire home's once-compiled validators — no schema
 * compilation happens here. Its keys are the ruled four:
 *
 * - **`send`** — lazy-constructs via the factory on the first send AND
 *   after any death; posts the wire event to the worker;
 * - **`invalidEventGate`** — the routing-side boundary check (request +
 *   cancel validators; type-const discrimination holds);
 * - **`terminate`** — kills the worker; no respawn after;
 * - **`name`** — the faculty's wire name.
 *
 * Crash synthesis: an unsolicited worker death (the `error` event — Bun
 * surfaces worker deaths as `error` only; there is no `exit` event and no
 * `exitCode`) re-enters exactly ONE `faculty_error { faculty: name }`
 * once-thread via `addThreads`. In-flight requests at death simply never
 * answer — the engine's threads correlate results by id and
 * `waitFor [result, faculty_error]` (the documented pattern), so no pending
 * map exists here.
 */

type WireMessage = {
  type: string
  detail: JsonObject & { id: string }
  space?: string
}

export const useWorker = ({
  name,
  worker: spawnWorker,
  validateRequest,
  validateCancel,
  resultKind,
  initData,
}: {
  name: string
  /** The worker factory — a bundler-visible literal at the call site. */
  worker: () => Worker
  /** The wire home's once-compiled request validator. */
  validateRequest: ValidateFunction
  /** The wire home's once-compiled cancel validator. */
  validateCancel: ValidateFunction
  /** The inbound lane's seal: only this result kind re-enters. */
  resultKind: string
  /**
   * The faculty's config, delivered as the INIT FRAME — posted immediately
   * after the worker constructs (port FIFO + the worker message queue
   * guarantee it precedes the first request). Never a request message; never
   * eval-time reads. Re-init later (a fresh init frame) overwrites — the
   * forward-compatible channel for config updates.
   */
  initData?: JsonObject
}) => {
  return (addThreads: AddThreads) => {
    let worker: Worker | undefined
    let terminated = false
    let crashed = false

    /** Re-enter one event as a once-thread, space preserved (root stays root). */
    const reenter = (message: WireMessage): void => {
      addThreads([
        {
          ...(message.space === undefined ? {} : { space: message.space }),
          label: `on_${message.type}_${message.detail.id}`,
          once: true,
          rules: [{ request: { type: message.type, detail: message.detail } }],
        },
      ])
    }

    /** Construct the faculty worker (fresh on first send and after any death). */
    const spawn = (): Worker => {
      const next = spawnWorker()
      // The construction message: the faculty's config, always first. Port
      // FIFO + the worker message queue order it before any request.
      const init: InitFrame = { kind: INIT_FRAME_KIND, data: initData ?? {} }
      next.postMessage(init)
      // One crash synthesis per death — the listeners are per-instance, so a
      // respawn arms fresh ones for the next death.
      let synthesized = false
      next.addEventListener('message', (event: MessageEvent) => {
        const message = event.data as WireMessage | null
        if (
          message === null ||
          typeof message !== 'object' ||
          typeof message.type !== 'string' ||
          typeof message.detail !== 'object' ||
          message.detail === null ||
          message.type !== resultKind
        )
          return
        reenter(message)
      })
      next.addEventListener('error', (event: ErrorEvent) => {
        // Crash synthesis — exactly ONE faculty_error per unsolicited death.
        if (synthesized) return
        synthesized = true
        if (terminated) return
        crashed = true
        reenter({
          type: FACULTY_MESSAGE_KINDS.faculty_error,
          detail: {
            id: `crash_${name}_${crypto.randomUUID()}`,
            faculty: name,
            message: `worker crashed: ${event.message}`,
          },
        })
      })
      return next
    }

    /** The faculty's outbound port: one wire event to the worker. */
    const send = (event: BPEvent): void => {
      if (terminated) return
      if (worker === undefined || crashed) {
        crashed = false
        worker = spawn()
      }
      worker.postMessage(event)
    }

    const invalidEventGate = (event: BPEvent): boolean => !validateRequest(event) && !validateCancel(event)

    return {
      name,
      send,
      invalidEventGate,
      /** Teardown: the composition (or host) terminates the worker it spawned. */
      terminate: (): void => {
        terminated = true
        worker?.terminate()
      },
    }
  }
}
