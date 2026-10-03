/**
 * The faculty bridge — the daemon's thin faculty host: the `/faculty-wire`
 * WebSocket route that bridges the faculty wire between a browser
 * composition (the socket lane) and the actuator trio.
 *
 * @remarks
 * The three pins (pilot-ruled 2026-09-28), as built:
 *
 * 1. **One framing, one home.** The bridge speaks exactly the socket-lane
 *    client's landed framing — one JSON line per wire event
 *    (`FacultyWireFrame`, the shared home in `faculties.types.ts`). Routing
 *    derives from the wire registry's `ACTUATOR_ROUTE` (the same table the
 *    composition routes by) — no parallel framing, no mirrored table.
 * 2. **Crash-synthesis ownership.** An actuator death happens daemon-side,
 *    where no composition and no addThreads exist: the pre-built lanes'
 *    own synthesis (the useActuator precedent — exactly one
 *    `faculty_error { faculty }` per unsolicited death) re-enters through
 *    the bridge's addThreads, and the bridge forwards it as wire traffic.
 *    The socket lane's own crash handling covers only socket death;
 *    in-flight requests at an actuator death simply never answer (the
 *    composition's `waitFor [result, faculty_error]` pair covers them).
 * 3. **The capability gate at attach.** The first execution of R3's session
 *    scopes: the bridge grants the COMPOSITION capability (faculty wire +
 *    trace egress) to sessioned clients only — cookie or bearer, via the
 *    one session (`session.ts`). Fail-closed: an unauthenticated attach is
 *    rejected (401) and never reaches the lanes; driver clients ingress via
 *    the JSON-RPC attach lane, never the faculty wire.
 *
 * Per-connection lanes: every attached composition gets its OWN trio
 * instances (the per-space process isolation — one process per wiring per
 * space), built from the host's pre-built lane builders at open, terminated
 * at close. The re-entry law runs inverted: the lanes' once-threads pump to
 * THIS connection's socket.
 *
 * @packageDocumentation
 */

import { DAEMON_BRIDGE_PATH } from '../b-program/b-program.worker.ts'
import type { BPEvent, JsonObject, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { ACTUATOR_ROUTE, FACULTY_MESSAGE_KINDS, TRACE_PUSH_KIND } from '../faculties/faculties.constants.ts'
import type { FacultyLane, FacultyWireFrame, LaneBuilder } from '../faculties/faculties.types.ts'
import { validSession } from './session.ts'

export { DAEMON_BRIDGE_PATH }

/** The bridge socket's data marker — the socket host dispatches on it. */
export const FACULTY_BRIDGE_SOCKET = 'faculty_bridge' as const

export type FacultyBridgeSocketData = {
  kind: typeof FACULTY_BRIDGE_SOCKET
  lanes: FacultyLane[]
  /** The kind → lane routing table, derived from ACTUATOR_ROUTE at open. */
  routes: Map<string, FacultyLane>
}

/** The bridge's socket view — structural over Bun's ServerWebSocket. */
type BridgeSocket = {
  send: (line: string) => void
  data: FacultyBridgeSocketData
}

export type FacultyBridge = {
  /**
   * The capability gate (pin 3) — fail closed. Returns the 401 response when
   * the client presents no valid session; otherwise performs the upgrade
   * through the given seam (the socket host's `server.upgrade`).
   */
  upgrade: (
    req: Request,
    upgrade: (req: Request, options: { data: FacultyBridgeSocketData }) => boolean,
  ) => Response | undefined
  /** Build this connection's lanes (per-space process isolation) and arm the pump. */
  open: (ws: BridgeSocket) => void
  /** Parse one line per the shared framing; route or fail visibly (the connection stays). */
  message: (ws: BridgeSocket, line: string) => void
  /** Tear the connection's lanes down (terminate — the death synthesis stays silent). */
  close: (ws: BridgeSocket) => void
}

/** One fail-visible `faculty_error` line to the client (the connection stays). */
const failVisible = (ws: BridgeSocket, faculty: string, message: string): void => {
  ws.send(
    JSON.stringify({
      type: FACULTY_MESSAGE_KINDS.faculty_error,
      detail: { faculty, message },
    } satisfies FacultyWireFrame),
  )
}

/**
 * The re-entry law, inverted: the lanes re-enter once-threads whose `request`
 * rule IS the wire event — the bridge unwraps and pumps it to this
 * connection's socket, space preserved (root stays root).
 */
const pumpFor =
  (send: (frame: FacultyWireFrame) => void) =>
  (threads: Thread[]): void => {
    for (const thread of threads) {
      const request = thread.rules[0]?.request
      if (request === undefined) continue
      send({
        type: request.type,
        detail: request.detail as JsonObject,
        ...(thread.space === undefined ? {} : { space: thread.space }),
      })
    }
  }

/**
 * The bridge factory — takes the host's PRE-BUILT lane builders (the entries
 * own construction) and the session gate; the socket host mounts it at
 * {@link DAEMON_BRIDGE_PATH}.
 *
 * @public
 */
export const createFacultyBridge = ({
  laneBuilders,
  session = (req: Request): boolean => validSession(req, ''),
  pushTrace,
}: {
  /** The actuator lane builders (the trio per the config allow-list). */
  laneBuilders: LaneBuilder[]
  /** The session gate (R3) — an unauthenticated attach never reaches the lanes. */
  session?: (req: Request) => boolean
  /**
   * The one-observability-stream fold: a pushed trace (the composition
   * worker's already-redacted stream) enters the daemon's stream here —
   * the JSONL persistence home + the scoped fan-out. Scoped by
   * construction: only sessioned composition connects reach this leg.
   */
  pushTrace?: (trace: Trace) => void
}): FacultyBridge => ({
  upgrade: (req, upgrade) => {
    // Pin 3, fail-closed: no session → no faculty-wire traffic, ever.
    if (!session(req)) {
      return new Response('behavioral faculty bridge — session authentication required\n', { status: 401 })
    }
    const upgraded = upgrade(req, {
      data: { kind: FACULTY_BRIDGE_SOCKET, lanes: [], routes: new Map<string, FacultyLane>() },
    })
    if (!upgraded) return new Response('behavioral faculty bridge — a WebSocket upgrade is required\n', { status: 426 })
    return undefined
  },
  open: (ws) => {
    // Per-connection lanes: this composition's own trio instances (the
    // per-space process isolation), pumping results back to THIS socket.
    const send = (frame: FacultyWireFrame): void => ws.send(JSON.stringify(frame))
    ws.data.lanes = laneBuilders.map((build) => build((threads: Thread[]) => pumpFor(send)(threads)))
    for (const lane of ws.data.lanes) {
      const kinds = ACTUATOR_ROUTE[lane.name]
      if (kinds === undefined) {
        // A lane the bridge cannot route is a construction bug — fail fast at
        // wiring, never as a silently-unrouted faculty.
        throw new Error(
          `unknown actuator lane name: "${lane.name}" — expected one of: ${Object.keys(ACTUATOR_ROUTE).join(', ')}`,
        )
      }
      for (const kind of kinds) ws.data.routes.set(kind, lane)
    }
  },
  message: (ws, line) => {
    let frame: FacultyWireFrame
    try {
      frame = JSON.parse(line) as FacultyWireFrame
    } catch (error) {
      // Fail-visible, connection stays (the client rewraps as its lane's error).
      failVisible(ws, 'bridge', `malformed frame: ${(error as Error).message}`)
      return
    }
    if (typeof frame?.type !== 'string' || typeof frame.detail !== 'object' || frame.detail === null) {
      failVisible(ws, 'bridge', `malformed frame: expected a wire event with a type and detail object`)
      return
    }
    // The trace leg (the one-observability-stream ruling): the worker's
    // already-redacted stream folds into the daemon's stream — never routed
    // to the lanes.
    if (frame.type === TRACE_PUSH_KIND) {
      pushTrace?.(frame.detail as unknown as Trace)
      return
    }
    const lane = ws.data.routes.get(frame.type)
    if (lane === undefined) {
      failVisible(ws, 'bridge', `unroutable kind "${frame.type}" — the bridge serves the actuator trio only`)
      return
    }
    const event = frame as unknown as BPEvent
    // The trust boundary: an event failing the lane's own validators never
    // reaches the actuator process — fail-visible instead.
    if (lane.invalidEventGate(event)) {
      failVisible(ws, lane.name, `event failed the ${lane.name} lane boundary (type ${frame.type})`)
      return
    }
    lane.send(event)
  },
  close: (ws) => {
    for (const lane of ws.data.lanes) lane.terminate()
    ws.data.lanes = []
    ws.data.routes.clear()
  },
})
