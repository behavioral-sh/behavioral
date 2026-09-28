import type { BehavioralConfig } from './load-config.ts'

export type { BehavioralConfig } from './load-config.ts'

/**
 * Type a `config.ts` default export — an identity helper that gives editor
 * autocomplete for the `actuators` array and the `useFaculty(...)` overrides,
 * mirroring vite/drizzle config helpers.
 *
 * @public
 */
export const defineConfig = (config: BehavioralConfig): BehavioralConfig => config
