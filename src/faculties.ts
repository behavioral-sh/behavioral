/**
 * The faculties public surface — the faculty wire home and what a host or
 * a `config.ts` composes with.
 *
 * @remarks
 * Exports the wire types + once-compiled validators (`faculties.types.ts` —
 * the event schemas every lane's gate compiles from), the wire kinds
 * (`faculties.constants.ts`), the model identifier types riding the INIT
 * FRAME (`SystemOneEndpointConfig`, `SystemTwoEndpoints`), the `Actuator`
 * trio, and `useWorker` — the composition-side worker wiring. The faculty
 * worker entries and the root guard threads (`faculties.threads.ts`) are
 * internal — the composition always mounts the guards and constructs the
 * workers itself. The runtime composition (`bProgram`) and the host-minted
 * policy packs live in `src/b-program.ts` / `src/b-program/`.
 *
 * @packageDocumentation
 */

/** The selectable actuators (the daemon config's allow-list — the trio only). */
export type Actuator = 'shell' | 'store' | 'security'

export { useWorker } from './b-program/use-worker.ts'
export * from './faculties/faculties.constants.ts'
export * from './faculties/faculties.types.ts'
export * from './faculties/system-one.types.ts'
export * from './faculties/system-two.types.ts'
