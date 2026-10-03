/**
 * The composition boundary — the runtime composition and its host-minted
 * policy packs.
 *
 * @remarks
 * `bProgram` is the ruled two-key-plus-lanes surface (`threads` + `models`
 * + `actuators`): every faculty is a web worker wired through `useWorker`,
 * the actuator lanes arrive pre-built, and every policy pack (shell,
 * rpc-auth, remote-mcp, plugin-threads, supervision, ui_*) is host-minted
 * and passed in the `threads` array. The root guard threads stay internal.
 *
 * @packageDocumentation
 */

export {
  bProgram,
  type FacultyLane,
  type LaneBuilder,
} from './b-program/b-program.ts'
export { PLUGIN_THREADS_EVENT_TYPES, pluginThreadsThreads } from './b-program/plugin-threads.threads.ts'
export { REMOTE_MCP_EVENT_TYPES, remoteMcpThreads } from './b-program/remote-mcp.threads.ts'
export { rpcAuthThreads } from './b-program/rpc-auth.threads.ts'
export { shellThreads } from './b-program/shell.threads.ts'
export { createUiCapture, type UiRun, uiCaptureFileSink, uiReplayRequest } from './b-program/ui-capture.ts'
export { UI_RENDER_TRIGGER_TYPE, uiThreads } from './b-program/ui-threads.ts'
export { useWorker } from './b-program/use-worker.ts'
