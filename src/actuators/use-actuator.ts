import type { ValidateFunction } from 'ajv'
import type { BPEvent, JsonObject } from '../behavioral/behavioral.types.ts'
import { ACTUATOR_MESSAGE_KINDS } from './actuators.constants.ts'
import type { AddThreads } from './actuators.types.ts'

type WireMessage = {
  type: string
  detail: JsonObject & { id: string }
  space?: string
}

/**
 * The spawn-based actuator wiring primitive — the process-composition ruling:
 * capability actuators run as Bun.spawn PROCESSES speaking the unchanged
 * behavioral wire over stdio lines (one JSON event per line), one process
 * instance per wiring (per space).
 *
 * Slimmed contract (the actuators split): spawn + wire in/out + exit-code
 * crash synthesis + terminate. NO schema compilation happens here — the
 * wiring takes the wire home's once-compiled validators (`faculties.types.ts`
 * compiles the event schemas once; the composition's guard derivation
 * references the same one home) and a plain result-kind seal.
 *
 * @remarks
 * Why processes over Workers (the ruling's arithmetic): a shared Worker was
 * head-of-line blocking across spaces by construction; a process per space
 * isolates by OS construction, kills via the process tree, and tears down
 * without dead-port stragglers — killing a process closes its pipes.
 *
 * Curried like its Worker ancestor: the initial call captures the faculty's
 * command, wire name, validators, and an optional `env` override
 * (merged over the inherited environment); the returned function
 * — awaiting `(addThreads, space?)` — wires:
 *
 * - **the line pump** — stdout lines parsed and re-entered as once-threads
 *   with `message.space` PRESERVED. The pump discards only what cannot be
 *   this lane's event (non-JSON lines, non-object payloads, any type other
 *   than the faculty's result kind — the lane stays sealed); schema validity
 *   of the detail is the faculty guard's job — a parsed-but-invalid result
 *   re-enters and is blocked VISIBLY (frontier/pending_bids traces) instead
 *   of vanishing;
 * - **crash synthesis** — an unsolicited process death (any exit we did not
 *   cause) re-enters exactly ONE `faculty_error { faculty: name }` event;
 * - **respawn on demand** — the next outbound event spawns a fresh process
 *   after a death; one live process per faculty wiring at all times;
 * - **thread mounting** — stamped with the wiring space only when set.
 *
 * `send(event)` is the faculty's outbound port: JSON line to the process's
 * stdin (spawning if dead). `invalidEventGate` is the routing-side boundary
 * check (request + cancel schemas; type-const discrimination holds). The
 * engine's threads correlate results by id and `waitFor [result,
 * worker_error]` — the documented pattern — so no pending map exists;
 * in-flight requests at death simply never answer, which the waitFor pair
 * already covers.
 */
export const useActuator = ({
  command,
  name,
  env,
  validateRequest,
  validateCancel,
  resultKind,
}: {
  command: string[]
  name: string
  /** Extra environment for the spawned process, merged over `process.env`. */
  env?: Record<string, string>
  /** The outbound gate — the wire home's once-compiled request validator. */
  validateRequest: ValidateFunction
  /** The outbound gate — the wire home's once-compiled cancel validator. */
  /** The wire home's once-compiled cancel validator — absent for actuators with no cancel contract. */
  validateCancel?: ValidateFunction
  /** The inbound lane's seal: only this result kind re-enters. */
  resultKind: string
}) => {
  return (addThreads: AddThreads) => {
    let proc: Bun.Subprocess<'pipe', 'pipe', 'inherit'> | undefined
    let terminated = false
    let crashed = false
    let pumping = false
    let carry = ''

    /** Re-enter one event as a once-thread, space preserved (root stays root). */
    const reenter = (message: WireMessage): void => {
      addThreads([
        {
          ...(message.space === undefined ? {} : { space: message.space }),
          name: `on_${message.type}_${message.detail.id}`,
          description: `Faculty re-entry — once-thread re-emitting the ${message.type} wire event.`,
          once: true,
          rules: [{ request: { type: message.type, detail: message.detail } }],
        },
      ])
    }

    /** Crash synthesis — exactly ONE worker_error per unsolicited death. */
    const onDeath = (code: number | null): void => {
      if (terminated) return
      crashed = true
      reenter({
        type: ACTUATOR_MESSAGE_KINDS.faculty_error,
        detail: {
          id: `crash_${name}_${crypto.randomUUID()}`,
          faculty: name,
          message: `process exited (${code ?? 'signal'})`,
        },
      })
    }

    /** Spawn the faculty process (fresh on first send and after any death). */
    const spawn = (): Bun.Subprocess<'pipe', 'pipe', 'inherit'> => {
      const child = Bun.spawn(command, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
        cwd: import.meta.dir,
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      })
      // One crash synthesis per death — the listener itself is per-process,
      // so a respawn arms a fresh listener for the next death.
      void child.exited.then((code) => onDeath(code))
      return child
    }

    /** Pump stdout lines to the result lane; run once per process. */
    const pump = async (): Promise<void> => {
      if (pumping) return
      pumping = true
      try {
        const reader = proc!.stdout.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const current = proc
          if (current === undefined) break
          const { done, value } = await reader.read()
          if (done) break
          carry += decoder.decode(value, { stream: true })
          const lines = carry.split('\n')
          carry = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed === '') continue
            let message: WireMessage
            try {
              message = JSON.parse(trimmed) as WireMessage
            } catch {
              // Discard malformed, non-JSON output (the line protocol's rule).
              continue
            }
            // The pump discards only what cannot be THIS lane's event (non-JSON,
            // non-object payloads, any type other than the faculty's result kind).
            // Schema validity of the DETAIL is the faculty guard's job — a
            // parsed-but-invalid result re-enters and is blocked VISIBLY
            // (frontier/pending_bids traces) instead of vanishing.
            if (
              typeof message.type !== 'string' ||
              typeof message.detail !== 'object' ||
              message.detail === null ||
              message.type !== resultKind
            )
              continue
            reenter(message)
          }
        }
      } finally {
        pumping = false
      }
    }

    /** The faculty's outbound port: one JSON line to the process stdin. */
    const send = (event: BPEvent): void => {
      if (terminated) return
      if (proc === undefined || crashed) {
        crashed = false
        proc = spawn()
        void pump()
      }
      proc.stdin?.write(`${JSON.stringify(event)}\n`)
    }

    const invalidEventGate = (event: BPEvent): boolean =>
      !validateRequest(event) && (validateCancel === undefined || !validateCancel(event))

    return {
      name,
      send,
      invalidEventGate,
      /** Teardown: the composition (or host) kills the process it spawned. */
      terminate: (): void => {
        terminated = true
        proc?.kill()
      },
    }
  }
}
