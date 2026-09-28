/**
 * UI entry point for the behavioral framework.
 * Exports primitives for server-rendered UI, controller islands, and CSS generation.
 *
 * @remarks
 * This module provides access to:
 * - **Controller runtime**: {@link Controller} serves the browser controller bootstrap.
 * - **Wire contracts**: controller schemas validate server commands and browser-to-server messages.
 * - **Projection journal**: UI projection events materialize page-scoped reconnect state.
 * - **Styling**: style, token, keyframe, host style, root style, and join helpers.
 *
 * @public
 */

export * from './controller/controller.ts'
export * from './controller/controller.types.ts'
export * from './controller/websocket-transport.ts'
export * from './controller/worker-transport.ts'
