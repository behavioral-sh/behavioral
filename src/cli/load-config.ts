import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { behavioralHome } from '../actuators/behavioral-home.ts'
import type { SystemOneEndpointConfig } from '../faculties/system-one.types.ts'
import type { SystemTwoEndpoints } from '../faculties/system-two.types.ts'
import type { Actuator } from '../faculties.ts'

/**
 * The host config shape — the daemon's config (`<home>/config.ts`) under the
 * ruled two-hosts-two-configs shape: the `actuators` allow-list (which of the
 * trio the daemon spawns) plus the composition's model identifiers (the init-
 * frame payloads: `systemOne` endpoint config, `systemTwo` endpoints map, the
 * `ui` generation target). A config file default-exports a value of this
 * shape; api keys ride as resolved env values (the generated template's
 * `env()` helper fails fast on an unset variable — never literals).
 *
 * @public
 */
export type BehavioralConfig = {
  /** The actuator allow-list — absent means the whole trio is on. */
  actuators?: Actuator[]
  /** The SystemOne endpoint config riding the init frame; `null` omits it. */
  systemOne?: SystemOneEndpointConfig | null
  /** The SystemTwo endpoints map riding the init frame; `null` omits it. */
  systemTwo?: SystemTwoEndpoints | null
  /** The ui generation target within the systemTwo map. */
  ui?: { provider?: string; modelId?: string }
  /**
   * The inference providers (the transport ruling): provider id →
   * allow-listed forward base. The daemon proxy routes
   * `/v1/inference/<id>` resolve here (R5 — the egress allow-list), the
   * keychain entries key by the same id (R2), and the CSP `connect-src`
   * list carries these origins (R6). Product-path destinations are
   * SELF-HOSTED inference servers; vendor-cloud entries are dev/eval
   * tooling only (the sovereignty ruling).
   */
  inference?: { providers?: Record<string, string> }
}

/** The selectable actuators a config may enable (the trio only). */
const KNOWN_ACTUATORS: readonly string[] = ['shell', 'store', 'security']
/** The systemTwo endpoint transports (the faculty's rest | webgpu toggle). */
const KNOWN_TRANSPORTS: readonly string[] = ['rest', 'webgpu']

const invalid = (configPath: string, detail: string): never => {
  throw new Error(`invalid config at ${configPath}: ${detail}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): boolean =>
  isRecord(value) && Object.values(value).every((v) => typeof v === 'string')

/** Validate the model-identifier keys — fail fast with the path and a fix hint. */
const validateModels = (config: Record<string, unknown>, configPath: string): void => {
  const { systemOne, systemTwo, ui, inference } = config
  // Each guard's happy path sits in an `else` block — the plain narrowing
  // (a never-returning call as a bare statement does not narrow).
  if (systemOne !== undefined && systemOne !== null) {
    if (isRecord(systemOne)) {
      // Property values are captured into locals before their typeof checks —
      // noUncheckedIndexedAccess makes property narrowing on the record itself
      // collapse the object to `{}`.
      const { url, apiKey, headers, transport, model } = systemOne
      if (transport !== undefined && (typeof transport !== 'string' || !KNOWN_TRANSPORTS.includes(transport))) {
        invalid(configPath, `"systemOne"."transport" must be one of: ${KNOWN_TRANSPORTS.join(', ')}`)
      }
      // The faculty's rule, mirrored from systemTwo: rest (the default) needs
      // the full request url; webgpu needs the local model id instead.
      if ((transport ?? 'rest') === 'rest' && typeof url !== 'string') {
        invalid(
          configPath,
          '"systemOne" must be an endpoint object with a "url" string (rest) or a "model" string (webgpu via "transport": "webgpu")',
        )
      }
      if ((transport ?? 'rest') === 'webgpu' && typeof model !== 'string') {
        invalid(configPath, '"systemOne" with "transport": "webgpu" needs a "model" string (the local model id)')
      }
      if (apiKey !== undefined && typeof apiKey !== 'string') {
        invalid(configPath, '"systemOne"."apiKey" must be a string (an env-resolved value, never a literal key file)')
      }
      if (headers !== undefined && !isStringRecord(headers)) {
        invalid(configPath, '"systemOne"."headers" must be a record of strings')
      }
    } else {
      invalid(
        configPath,
        '"systemOne" must be an endpoint object with a "url" string (rest) or a "model" string (webgpu via "transport": "webgpu")',
      )
    }
  }
  if (systemTwo !== undefined && systemTwo !== null) {
    if (isRecord(systemTwo)) {
      for (const [label, endpoint] of Object.entries(systemTwo)) {
        if (isRecord(endpoint)) {
          const { transport, url, model, apiKey, headers } = endpoint
          if (transport !== undefined && (typeof transport !== 'string' || !KNOWN_TRANSPORTS.includes(transport))) {
            invalid(configPath, `"systemTwo"."${label}"."transport" must be one of: ${KNOWN_TRANSPORTS.join(', ')}`)
          }
          // The faculty's rule: rest (the default) needs the full base url; webgpu
          // needs the local model id instead.
          if ((transport ?? 'rest') === 'rest' && typeof url !== 'string') {
            invalid(
              configPath,
              `"systemTwo"."${label}" needs a "url" string (rest) or a "model" string (webgpu) via "transport": "webgpu"`,
            )
          }
          if (model !== undefined && typeof model !== 'string') {
            invalid(configPath, `"systemTwo"."${label}"."model" must be a string (the local webgpu model id)`)
          }
          if (apiKey !== undefined && typeof apiKey !== 'string') {
            invalid(configPath, `"systemTwo"."${label}"."apiKey" must be a string`)
          }
          if (headers !== undefined && !isStringRecord(headers)) {
            invalid(configPath, `"systemTwo"."${label}"."headers" must be a record of strings`)
          }
        } else {
          invalid(configPath, `"systemTwo"."${label}" must be an endpoint object`)
        }
      }
    } else {
      invalid(configPath, '"systemTwo" must be a provider-label → endpoint map (or null)')
    }
  }
  if (inference !== undefined) {
    if (isRecord(inference)) {
      const { providers } = inference
      if (providers !== undefined) {
        if (!isStringRecord(providers)) {
          invalid(configPath, '"inference"."providers" must be a record of provider id → origin string')
        }
        for (const [id, base] of Object.entries(providers as Record<string, string>)) {
          const parsed: URL | null = (() => {
            try {
              return new URL(base)
            } catch {
              return null
            }
          })()
          if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
            invalid(configPath, `"inference"."providers"."${id}" must be an http(s) origin (got "${base}")`)
          }
        }
      }
    } else {
      invalid(configPath, '"inference" must be { providers?: Record<string, string> }')
    }
  }
  if (ui !== undefined) {
    if (isRecord(ui)) {
      const { provider, modelId } = ui
      if (provider !== undefined && typeof provider !== 'string') {
        invalid(configPath, '"ui"."provider" must be a string (a systemTwo provider label)')
      }
      if (modelId !== undefined && typeof modelId !== 'string') {
        invalid(configPath, '"ui"."modelId" must be a string (a model id within the provider)')
      }
    } else {
      invalid(configPath, '"ui" must be { provider?, modelId? }')
    }
  }
}

/** Validate the trusted config's shape — fail fast with the path and a fix hint. */
const validate = (value: unknown, configPath: string): BehavioralConfig => {
  if (!isRecord(value)) {
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
  validateModels(config, configPath)
  // The shape is closed — a legacy key (the retired factory overrides) is
  // a stale config, and a stale config must fail fast, never silently shrink.
  const known = new Set(['actuators', 'systemOne', 'systemTwo', 'ui', 'inference'])
  const stale = Object.keys(config).filter((key) => !known.has(key))
  if (stale.length > 0) {
    invalid(
      configPath,
      `unknown config key ${stale.map((key) => `"${key}"`).join(', ')} — the config is the actuator allow-list plus model identifiers; regenerate via behavioral init`,
    )
  }
  return config as BehavioralConfig
}

/**
 * Load the harness config from `configPath`, defaulting to `<BEHAVIORAL_HOME>/config.ts`.
 *
 * @remarks
 * The file is **executable config** — trusted, user-owned machine state,
 * dynamically imported so it can carry live values (the `actuators` allow-list
 * and the env-resolved model identifiers). A missing file yields the empty
 * config, so the defaults apply; an unloadable file or an invalid shape throws
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
