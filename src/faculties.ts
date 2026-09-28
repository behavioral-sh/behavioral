/**
 * The faculties public surface — what a `config.ts` override composes with.
 *
 * @remarks
 * Exposes the override threads (`shellThreads`, `mcpThreads`), their
 * schemas and types, the `Actuator` union, `useFaculty`, and the System Two
 * config surface (`configSystemTwo` for a provider entry; `useSystemTwo` for
 * the host). The default root threads (`facultiesThreads`) is internal — the
 * composition always mounts it — and is intentionally NOT exported. The runtime
 * composition itself (`bProgram`) lives in `src/cli/b-program.ts`.
 *
 * @packageDocumentation
 */

/** The selectable capability actuators (the `bProgram` allow-list). */
export type Actuator = 'shell' | 'store' | 'security'

export * from './faculties/faculties.types.ts'
export * from './faculties/security/types.ts'
export * from './faculties/shell/remote-mcp.threads.ts'
export * from './faculties/shell/rpc-auth.threads.ts'
export * from './faculties/shell/threads.ts'
export * from './faculties/shell/types.ts'
export * from './faculties/store/threads.ts'
export * from './faculties/store/types.ts'
export * from './faculties/system-one/config.ts'
export * from './faculties/system-one/types.ts'
export * from './faculties/system-two/config.ts'
export * from './faculties/system-two/types.ts'
export * from './faculties/use-faculty.ts'
