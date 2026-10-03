/**
 * `behavioral init` — generate the harness config under the behavioral home.
 *
 * @remarks
 * Two surfaces over one runner:
 *
 * - **agents** — the framework-native JSON command: `behavioral init '{...}'`
 *   with `--schema input|output`, `--dry-run`, `--help`. Absent faculties
 *   default on (TypeSafe/OpenAI urls); `null` omits a faculty; api keys ride as
 *   env-var-NAME references that fail fast when unset — never literals.
 * - **humans** — with no input and a TTY, a prompt tour collects the same
 *   {@link InitInput} through an injectable `ask` seam and hands it to the
 *   same runner.
 *
 * The generated config is the ruled two-key shape: the daemon's `actuators`
 * allow-list plus the composition's model identifiers — `systemOne` endpoint
 * config and `systemTwo` endpoints map as DATA (they ride the init frame;
 * the `useSystemOne`/`useSystemTwo` factory overrides are gone).
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { JSONSchemaType } from 'ajv'
import { behavioralHome } from '../actuators/behavioral-home.ts'
import { makeCli } from './cli.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A System One endpoint spec — every field has a default; `apiKeyEnv` is an env var NAME, never a key. */
export type SystemOneEndpointInit = {
  url?: string
  model?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

/** A System Two endpoint spec (one per provider label) — `url` is required; `apiKeyEnv` is an env var NAME. */
export type SystemTwoEndpointInit = {
  url: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

export type InitInput = {
  /** Absent → the default TypeSafe endpoint; `null` → the faculty is omitted. */
  systemOne?: SystemOneEndpointInit | null
  /** Absent → the default OpenAI endpoint; `null` → the faculty is omitted. */
  systemTwo?: { endpoints?: Record<string, SystemTwoEndpointInit> } | null
  /** Overwrite an existing config. */
  force?: boolean
}

export type InitOutput = {
  home: string
  configPath: string
  files: string[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SYSTEM_ONE_DEFAULTS: Required<Omit<SystemOneEndpointInit, 'headers'>> = {
  url: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  apiKeyEnv: 'TYPESAFE_API_KEY',
}

const SYSTEM_TWO_DEFAULT_LABEL = 'openai'
const SYSTEM_TWO_DEFAULTS = {
  url: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
}

/** The default actuator allow-list — the trio, all on. */
const ACTUATOR_DEFAULTS: readonly string[] = ['shell', 'store', 'security']

// ---------------------------------------------------------------------------
// Schemas (the CLI trust boundary — `--schema input|output` reflects these)
// ---------------------------------------------------------------------------

const systemOneEndpointSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    model: { type: 'string' },
    apiKeyEnv: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: false,
} as const

const systemTwoEndpointSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    apiKeyEnv: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['url'],
  additionalProperties: false,
} as const

export const InitInputSchema = {
  type: 'object',
  properties: {
    systemOne: { oneOf: [systemOneEndpointSchema, { type: 'null' }] },
    systemTwo: {
      oneOf: [
        {
          type: 'object',
          properties: { endpoints: { type: 'object', additionalProperties: systemTwoEndpointSchema } },
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
} as unknown as JSONSchemaType<InitInput>

const InitOutputSchema = {
  type: 'object',
  properties: {
    home: { type: 'string' },
    configPath: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['home', 'configPath', 'files'],
  additionalProperties: false,
} as unknown as JSONSchemaType<InitOutput>

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const envHelper = (): string =>
  [
    '// Fails fast with the variable name when a referenced secret is unset.',
    'const env = (name: string): string => {',
    '  const value = process.env[name]',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted into the generated config, not interpolated here
    '  if (value === undefined) throw new Error(`missing required environment variable ${name}`)',
    '  return value',
    '}',
    '',
  ].join('\n')

const CONTROL_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

/**
 * A single-quoted TS string literal — the generated file follows repo style.
 * Escapes backslashes, quotes, AND control characters: a raw newline in a
 * URL/header would otherwise emit an unterminated literal (init exits 0,
 * the config dies at load).
 */
const ts = (value: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control-char class IS the point — escaping them
  `'${value.replace(/[\\\x00-\x1f\x7f]/g, (ch) => {
    if (ch === "'") return "\\'"
    if (ch === '\\') return '\\\\'
    return CONTROL_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  })}'`

/** A single-line TS object literal over string values. */
const tsObject = (record: Record<string, string>): string =>
  `{ ${Object.entries(record)
    .map(([key, value]) => `${ts(key)}: ${ts(value)}`)
    .join(', ')} }`

const renderConfig = ({
  systemOne,
  systemTwo,
}: {
  systemOne?: Required<Omit<SystemOneEndpointInit, 'headers'>> & { headers?: Record<string, string> }
  systemTwo?: { endpoints: Record<string, SystemTwoEndpointInit> }
}): string => {
  const usesEnv =
    (systemOne !== undefined && systemOne.apiKeyEnv !== undefined) ||
    (systemTwo !== undefined && Object.values(systemTwo.endpoints).some((spec) => spec.apiKeyEnv !== undefined))

  const lines: string[] = [
    '// Generated by `behavioral init` — executable config; edit freely.',
    '// The daemon reads `actuators`; the composition reads the model',
    '// identifiers as data (they ride the faculties init frame).',
    "import { defineConfig } from '@behavioral/sh'",
    '',
    ...(usesEnv ? [envHelper()] : []),
    'export default defineConfig({',
    `  actuators: [${ACTUATOR_DEFAULTS.map((name) => ts(name)).join(', ')}],`,
  ]

  if (systemOne !== undefined) {
    lines.push('  systemOne: {')
    lines.push(`    url: ${ts(systemOne.url)},`)
    lines.push(`    model: ${ts(systemOne.model)},`)
    if (systemOne.apiKeyEnv !== undefined) lines.push(`    apiKey: env(${ts(systemOne.apiKeyEnv)}),`)
    if (systemOne.headers !== undefined) lines.push(`    headers: ${tsObject(systemOne.headers)},`)
    lines.push('  },')
  }

  if (systemTwo !== undefined) {
    lines.push('  systemTwo: {')
    for (const [label, spec] of Object.entries(systemTwo.endpoints)) {
      lines.push(`    ${ts(label)}: {`)
      lines.push(`      url: ${ts(spec.url)},`)
      if (spec.apiKeyEnv !== undefined) lines.push(`      apiKey: env(${ts(spec.apiKeyEnv)}),`)
      if (spec.headers !== undefined) lines.push(`      headers: ${tsObject(spec.headers)},`)
      lines.push('    },')
    }
    lines.push('  },')
  }

  lines.push('})', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The runner (shared by the JSON command and the interactive tour)
// ---------------------------------------------------------------------------

export const runInit = async (input: InitInput): Promise<InitOutput> => {
  const home = behavioralHome()
  const files: string[] = []

  const configPath = join(home, 'config.ts')
  if ((await Bun.file(configPath).exists()) && input.force !== true) {
    throw new Error(`config already exists at ${configPath} — rerun with {"force": true} to overwrite`)
  }

  const systemOne = input.systemOne === null ? undefined : { ...SYSTEM_ONE_DEFAULTS, ...(input.systemOne ?? {}) }
  const systemTwo =
    input.systemTwo === null
      ? undefined
      : input.systemTwo?.endpoints === undefined
        ? { endpoints: { [SYSTEM_TWO_DEFAULT_LABEL]: SYSTEM_TWO_DEFAULTS } }
        : { endpoints: input.systemTwo.endpoints }

  await Bun.write(configPath, renderConfig({ systemOne, systemTwo }))
  files.unshift('config.ts')

  // The home must be self-resolving: the generated config imports
  // `@behavioral/sh`, and a host process (serve) resolves that from the
  // CONFIG FILE'S directory — a bare home has no node_modules on that walk,
  // and Bun's global fallback covers only entry execution, not dynamic
  // imports. Link the running package under <home>/node_modules so the
  // config loads from any host. Idempotent: an existing link/install wins.
  // MINIMAL: symlinkSync — POSIX/Bun environments; on Windows without
  // symlink privileges init degrades to the documented `bun add -g` story.
  const linkDir = join(home, 'node_modules', '@behavioral')
  const linkPath = join(linkDir, 'sh')
  if (!existsSync(linkPath)) {
    mkdirSync(linkDir, { recursive: true })
    symlinkSync(resolve(import.meta.dir, '..', '..'), linkPath)
    files.push('node_modules/@behavioral/sh')
  }

  return { home, configPath, files }
}

// ---------------------------------------------------------------------------
// The interactive tour (injectable ask — scripted in tests, readline at the bin)
// ---------------------------------------------------------------------------

/** One prompt: a question with an optional default (empty answer keeps it). */
export type Ask = (question: string, defaultValue?: string) => Promise<string>

const answered = (value: string, fallback: boolean): boolean => {
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? fallback : trimmed === 'y' || trimmed === 'yes'
}

/** The ask contract: an empty answer means the prompt's default. */
const withDefault = (value: string, defaultValue: string): string => {
  const trimmed = value.trim()
  return trimmed === '' ? defaultValue : trimmed
}

/** Collect an {@link InitInput} through the given `ask` seam — a confirmation tour, defaults pre-filled. */
export const collectInitInput = async (ask: Ask): Promise<InitInput> => {
  const input: InitInput = {}

  if (answered(await ask('Enable System One (TypeSafe Decisions)? [Y/n]', 'y'), true)) {
    const url = withDefault(await ask('System One URL', SYSTEM_ONE_DEFAULTS.url), SYSTEM_ONE_DEFAULTS.url)
    const model = withDefault(await ask('System One model', SYSTEM_ONE_DEFAULTS.model), SYSTEM_ONE_DEFAULTS.model)
    const apiKeyEnv = withDefault(
      await ask('System One API key env var', SYSTEM_ONE_DEFAULTS.apiKeyEnv),
      SYSTEM_ONE_DEFAULTS.apiKeyEnv,
    )
    input.systemOne = { url, model, apiKeyEnv }
  } else {
    input.systemOne = null
  }

  if (answered(await ask('Enable System Two (Open Responses)? [Y/n]', 'y'), true)) {
    const url = withDefault(await ask('System Two URL', SYSTEM_TWO_DEFAULTS.url), SYSTEM_TWO_DEFAULTS.url)
    const apiKeyEnv = withDefault(
      await ask('System Two API key env var', SYSTEM_TWO_DEFAULTS.apiKeyEnv),
      SYSTEM_TWO_DEFAULTS.apiKeyEnv,
    )
    input.systemTwo = { endpoints: { [SYSTEM_TWO_DEFAULT_LABEL]: { url, apiKeyEnv } } }
  } else {
    input.systemTwo = null
  }

  return input
}

// ---------------------------------------------------------------------------
// The command: interactive when empty+TTY (or forced); JSON otherwise
// ---------------------------------------------------------------------------

const INIT_HELP = `Generate <BEHAVIORAL_HOME>/config.ts — the actuator allow-list plus the model identifiers.

Run with no input at a terminal for the interactive tour; piped stdin or a JSON
positional is the agent path. Input fields (all optional):
  systemOne  {"url", "model", "apiKeyEnv", "headers"} | null   null omits the faculty
  systemTwo  {"endpoints": {"<label>": {"url", "apiKeyEnv", "headers"}}} | null
  force      Overwrite an existing config

Absent faculties default on (TypeSafe + OpenAI urls, env-var-name api keys);
the actuator allow-list defaults to the whole trio (shell, store, security).`

const command = makeCli({
  name: 'init',
  inputSchema: InitInputSchema,
  outputSchema: InitOutputSchema,
  help: INIT_HELP,
  run: runInit,
})

/**
 * The `init` entry: the interactive tour when there is no input and stdin is a
 * TTY; the framework JSON command otherwise (piped stdin is the agent path).
 */
export const init = async (args: string[]): Promise<void> => {
  const hasPositional = args.some((arg) => !arg.startsWith('-'))
  if (!hasPositional && process.stdin.isTTY) {
    // MINIMAL: the readline ask is the one untested sliver — the collector it
    // feeds is scripted in the specs, and the PTY e2e drives the real prompts;
    // upgrade path: none needed unless prompt rendering itself regresses.
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const ask: Ask = (question, defaultValue) =>
        new Promise((resolve) => {
          const suffix = defaultValue === undefined ? '' : ` [${defaultValue}]`
          rl.question(`${question}${suffix}: `, (answer) => resolve(answer))
        })
      const input = await collectInitInput(ask)
      console.log(JSON.stringify(await runInit(input), null, 2))
    } finally {
      rl.close()
    }
    return
  }
  await command.init(args)
}
