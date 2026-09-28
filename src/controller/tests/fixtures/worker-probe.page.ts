/**
 * The worker-probe page — the raw-worker leg of the `.ts`-URL probe plus the
 * transport-level status observation.
 *
 * Spawns a REAL dedicated module Worker at the conventional
 * {@link B_PROGRAM_WORKER_PATH} (the serving contract under test) and:
 *   - round-trips a raw `ping` → `pong` (the engine-acceptance probe: does the
 *     WebView engine accept a module Worker whose URL ends in `.ts`, given the
 *     response's Content-Type governs?) — recorded as `__workerProbe.pong`;
 *   - wraps the same worker in a real {@link WorkerTransport} and records its
 *     status events (hello → `open`; script-load failure → `error`) and any
 *     worker-level errors — `__workerProbe.status` / `__workerProbe.errors`.
 */
import { B_PROGRAM_WORKER_PATH, WorkerTransport } from '../../worker-transport.ts'

type ProbeState = { errors: string[]; status: string[]; pong: boolean }
const state: ProbeState = { errors: [], status: [], pong: false }
;(window as unknown as { __workerProbe: ProbeState }).__workerProbe = state

const worker = new Worker(B_PROGRAM_WORKER_PATH, { type: 'module' })
worker.addEventListener('error', (event) => {
  state.errors.push(event instanceof ErrorEvent ? event.message : 'worker error')
})
worker.addEventListener('message', (event: MessageEvent) => {
  const frame = event.data as { kind?: string }
  if (frame?.kind === 'pong') state.pong = true
})
const transport = new WorkerTransport({ worker })
transport.onStatus((event) => state.status.push(event.type))
worker.postMessage({ kind: 'ping' })
