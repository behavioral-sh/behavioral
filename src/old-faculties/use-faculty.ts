import type { JSONSchemaType } from 'ajv'
import { ajv, type BPEvent, type JsonObject, type Thread } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from './faculties.constants.ts'
import { eventTypeOf } from './faculties.threads.ts'
import type { AddThreads } from './faculties.types.ts'

type WireMessage = {
  type: string
  detail: JsonObject & { id: string }
  space?: string
}

/**
 * The event-wire schemas a faculty wiring declares: the request and cancel
 * schemas own the outbound gate; the result schema owns the inbound lane.
 * `useFaculty` compiles them internally and returns them so the composition
 * can derive guard threads from the same one home.
 */
export type FacultyEventSchemas = {
  request: JSONSchemaType<WireMessage>
  cancel: JSONSchemaType<WireMessage>
  result: JSONSchemaType<WireMessage>
}

/**
 * The spawn-based faculty wiring primitive — the process-composition ruling:
 * capability faculties run as Bun.spawn PROCESSES speaking the unchanged
 * behavioral wire over stdio lines (one JSON event per line), one process
 * instance per wiring (per space), replacing the Worker model for the
 * shell/store/security and system-one/system-two faculties.
 *
 * @remarks
 * Why processes over Workers (the ruling's arithmetic): a shared Worker was
 * head-of-line blocking across spaces by construction; a process per space
 * isolates by OS construction, kills via the process tree, and tears down
 * without dead-port stragglers — killing a process closes its pipes.
 *
 * Curried like its Worker ancestor: the initial call captures the faculty's
 * command, wire name, threads, validators, and an optional `env` override
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
export const useFaculty = ({
  command,
  name,
  threads,
  env,
  requestSchema,
  cancelSchema,
  resultSchema,
}: {
  command: string[]
  name: string
  threads: Thread[]
  /** Extra environment for the spawned process, merged over `process.env`. */
  env?: Record<string, string>
  /** The outbound request/result/cancel schemas — the faculty's trust boundary, compiled here. */
  requestSchema: JSONSchemaType<WireMessage>
  cancelSchema: JSONSchemaType<WireMessage>
  /** The result schema — returned for the composition's guard derivation. */
  resultSchema: JSONSchemaType<WireMessage>
}) => {
  // The inbound lane's seal: only this faculty's RESULT events re-enter from
  // its process (the request/cancel types stay outbound-only — a process
  // cannot inject requests into its own or another faculty's lane).
  // eventTypeOf throws on a schema missing the const — a wiring defect this
  // fundamental fails at WIRING time (this, the outer call), never as a
  // silently-undefined seal that would drop every inbound result.
  const resultKind = eventTypeOf(resultSchema)

  return (addThreads: AddThreads, space?: string) => {
    const validateRequestEvent = ajv.compile(requestSchema)
    const validateEventCancel = ajv.compile(cancelSchema)

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
          label: `on_${message.type}_${message.detail.id}`,
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
        type: FACULTY_MESSAGE_KINDS.faculty_error,
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

    const invalidEventGate = (event: BPEvent): boolean => !validateRequestEvent(event) && !validateEventCancel(event)

    // Thread mount — stamped only when set (an explicit `space: undefined`
    // breaks the strict Thread schema; the reenter rule, applied to the mounted threads).
    addThreads(threads.map((thread) => (space === undefined ? thread : { ...thread, space })))

    return {
      name,
      send,
      invalidEventGate,
      /** The compiled-source schemas, returned so the composition derives guards from the one home. */
      schemas: { request: requestSchema, cancel: cancelSchema, result: resultSchema },
      /** Teardown: the composition (or host) kills the process it spawned. */
      terminate: (): void => {
        terminated = true
        proc?.kill()
      },
    }
  }
}
