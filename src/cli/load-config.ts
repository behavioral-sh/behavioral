import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { behavioralHome } from '../old-faculties/behavioral-home.ts'
import type { bProgram } from './b-program.ts'

/**
 * The host config shape — the {@link bProgram} options a `config.ts` may
 * set. A config file default-exports a value of this shape.
 *
 * @public
 */
export type BehavioralConfig = Parameters<typeof bProgram>[0]

/** The selectable actuators a config may enable (mirrors the `Actuator` union — the trio only). */
const KNOWN_ACTUATORS: readonly string[] = ['shell', 'store', 'security']

const invalid = (configPath: string, detail: string): never => {
  throw new Error(`invalid config at ${configPath}: ${detail}`)
}

/** Validate the trusted config's shape — fail fast with the path and a fix hint. */
const validate = (value: unknown, configPath: string): BehavioralConfig => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(configPath, 'expected a default-exported object like `export default { actuators: [...] }`')
  }
  const config = value as Record<string, unknown>
  if (config.actuators !== undefined) {
    const actuators = config.actuators
    if (!Array.isArray(actuators) || actuators.some((name) => typeof name !== 'string')) {
      invalid(configPath, '"actuators" must be an array of actuator names')
    }
    const unknown = (actuators as string[]).filter((name) => !KNOWN_ACTUATORS.includes(name))
    if (unknown.length > 0) {
      invalid(
        configPath,
        `unknown actuator ${unknown.map((name) => `"${name}"`).join(', ')} — expected one of: ${KNOWN_ACTUATORS.join(', ')}`,
      )
    }
  }
  for (const key of ['shell', 'store', 'systemOne', 'systemTwo'] as const) {
    const override = config[key]
    if (override !== undefined && typeof override !== 'function') {
      const got = override === null ? 'null' : typeof override
      invalid(configPath, `"${key}" must be a useFaculty(...) override (a curried function), got ${got}`)
    }
  }
  return config as BehavioralConfig
}

/**
 * Load the harness config from `configPath`, defaulting to `<BEHAVIORAL_HOME>/config.ts`.
 *
 * @remarks
 * The file is **executable config** — trusted, user-owned machine state,
 * dynamically imported so it can carry live values (the `actuators` array and
 * `useFaculty(...)` overrides). A missing file yields the empty config, so the
 * composition defaults apply; an unloadable file or an invalid shape throws
 * with the path and a fix hint.
 *
 * @public
 */
export const loadConfig = async (
  configPath: string = join(behavioralHome(), 'config.ts'),
): Promise<BehavioralConfig> => {
  if (!(await Bun.file(configPath).exists())) return {}
  let module: { default?: unknown }
  try {
    module = (await import(pathToFileURL(configPath).href)) as { default?: unknown }
  } catch (error) {
    throw new Error(`invalid config at ${configPath}: failed to load — ${(error as Error).message}`)
  }
  if (module.default === undefined) invalid(configPath, 'no default export — add `export default { ... }`')
  return validate(module.default, configPath)
}
