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
 * HOLDING PATTERN: the faculties tree was renamed to `src/old-faculties/`
 * (in-flight restructuring); this boundary re-points at the renamed home so
 * the generated configs (`behavioral init`) keep loading. Nothing else changed.
 *
 * @packageDocumentation
 */

/** The selectable capability actuators (the `bProgram` allow-list). */
export type Actuator = 'shell' | 'store' | 'security'

export * from './old-faculties/faculties.types.ts'
export * from './old-faculties/security/types.ts'
export * from './old-faculties/shell/remote-mcp.threads.ts'
export * from './old-faculties/shell/rpc-auth.threads.ts'
export * from './old-faculties/shell/threads.ts'
export * from './old-faculties/shell/types.ts'
export * from './old-faculties/store/threads.ts'
export * from './old-faculties/store/types.ts'
export * from './old-faculties/system-one/config.ts'
export * from './old-faculties/system-one/types.ts'
export * from './old-faculties/system-two/config.ts'
export * from './old-faculties/system-two/types.ts'
export * from './old-faculties/use-faculty.ts'
