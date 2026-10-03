import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ajv } from '../../behavioral/behavioral.types.ts'
import { type Ask, collectInitInput, InitInputSchema, init } from '../init.ts'
import { loadConfig } from '../load-config.ts'
import { createRuntime } from '../serve.ts'

/**
 * `behavioral init` — the config generator — through its real CLI handler
 * (makeCli: JSON positional in, validated JSON out), against a temp
 * BEHAVIORAL_HOME. The locked contract:
 *
 * - the generated config is the ruled two-key shape: the `actuators`
 *   allow-list plus the model identifiers (`systemOne`/`systemTwo`) as DATA
 *   riding the faculties' init frame — no factory overrides;
 * - absent faculties default on (TypeSafe/OpenAI urls, env-NAME secrets);
 *   `null` omits a faculty; objects customize over the defaults;
 * - no literal secrets: api keys ride as `env('<NAME>')` references that fail
 *   fast when the variable is unset;
 * - an existing config is never clobbered without `force`.
 */

/** Scripted ask seam: answers pop in order; an exhausted tour keeps returning empty. */
const scriptedAsk = (answers: string[]): Ask => {
  const queue = [...answers]
  return async () => queue.shift() ?? ''
}

describe('behavioral init — the runner', () => {
  let home: string
  let logs: string[]
  let originalLog: typeof console.log

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'behavioral-init-'))
    process.env.BEHAVIORAL_HOME = home
    logs = []
    originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '))
    }
  })

  afterEach(() => {
    console.log = originalLog
    delete process.env.BEHAVIORAL_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const configPath = (): string => join(home, 'config.ts')
  const readConfig = (): string => readFileSync(configPath(), 'utf8')
  const runInit = async (json: string): Promise<{ home: string; configPath: string; files: string[] }> => {
    await init([json])
    return JSON.parse(logs.join('\n')) as { home: string; configPath: string; files: string[] }
  }

  test('an empty input generates the default config — the trio, both faculties, env-name secrets', async () => {
    const output = await runInit('{}')
    expect(output.configPath).toBe(configPath())
    expect(output.files).toContain('config.ts')
    const content = readConfig()
    expect(content).toContain("import { defineConfig } from '@behavioral/sh'")
    expect(content).toContain("actuators: ['shell', 'store', 'security']")
    expect(content).toContain('https://api.typesafe.ai/v1/systemone')
    expect(content).toContain("'jev-latest'")
    expect(content).toContain("apiKey: env('TYPESAFE_API_KEY')")
    expect(content).toContain('https://api.openai.com/v1')
    expect(content).toContain("apiKey: env('OPENAI_API_KEY')")
    // No factory overrides and no literal secrets anywhere.
    expect(content).not.toMatch(/useSystemOne|useSystemTwo|configSystem/)
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]/)
  })

  // The load-test: the generated config must not merely look right — it must
  // LOAD (module resolution from the home) and COMPOSE through the new shape.
  test('init links the package into the home — the generated config loads and composes', async () => {
    const previousTypesafe = process.env.TYPESAFE_API_KEY
    const previousOpenai = process.env.OPENAI_API_KEY
    process.env.TYPESAFE_API_KEY = 'test'
    process.env.OPENAI_API_KEY = 'test'
    try {
      const output = await runInit('{}')
      // The home is self-resolving: the running package is linked under
      // <home>/node_modules, so serve's dynamic import of the config resolves.
      expect(output.files).toContain('node_modules/@behavioral/sh')
      expect(existsSync(join(home, 'node_modules/@behavioral/sh/package.json'))).toBe(true)
      // The full loop: loadConfig (dynamic import from the home) + compose.
      const config = await loadConfig(configPath())
      expect(config.systemOne).toEqual({
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest',
        apiKey: 'test',
      })
      expect(config.systemTwo).toEqual({ openai: { url: 'https://api.openai.com/v1', apiKey: 'test' } })
      // The model identifiers are the init-frame payloads — the composition
      // reads them as data.
      const runtime = createRuntime(config)
      runtime.terminate()
    } finally {
      // Restore, never delete: the env is the caller's, not this spec's — a
      // leaked deletion poisons later specs in the same process (the live
      // TypeSafe integration reads the real key at load).
      if (previousTypesafe === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = previousTypesafe
      if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenai
    }
  })

  test('a null faculty is omitted; a custom spec overrides the defaults', async () => {
    await runInit(
      JSON.stringify({
        systemOne: { url: 'http://localhost:9999/systemone', model: 'my-model', apiKeyEnv: 'MY_KEY' },
        systemTwo: null,
      }),
    )
    const content = readConfig()
    expect(content).toContain('http://localhost:9999/systemone')
    expect(content).toContain("'my-model'")
    expect(content).toContain("apiKey: env('MY_KEY')")
    expect(content).not.toContain('systemTwo')
    expect(content).not.toContain('TYPESAFE_API_KEY')
  })

  test('a webgpu systemOne spec renders the transport toggle and NO apiKey leg', async () => {
    await runInit(JSON.stringify({ systemOne: { transport: 'webgpu', model: 'clef-flash-ternary' }, systemTwo: null }))
    const content = readConfig()
    expect(content).toContain("transport: 'webgpu'")
    expect(content).toContain("model: 'clef-flash-ternary'")
    // The local model carries no credential — no env reference, no url.
    expect(content).not.toContain('apiKey')
    expect(content).not.toContain('url:')
  })

  test('an existing config fails fast with the path; force overwrites', async () => {
    await runInit('{}')
    await expect(init(['{}'])).rejects.toThrow(/already exists.*config\.ts.*force/s)
    logs.length = 0
    await runInit('{"force": true}')
    expect(readConfig()).toContain('defineConfig')
  })

  // The review's follow-up 6: control characters in URL/header values must
  // not emit a broken string literal — init exits 0 and the config dies at
  // load. The escape funnel (ts) covers every emitted value.
  test('control characters in a url escape into a loadable string literal', async () => {
    await runInit(
      JSON.stringify({
        systemOne: { url: 'http://localhost:9\n99/systemone' },
        systemTwo: null,
      }),
    )
    const content = readConfig()
    // The newline rides ESCAPED inside the single-quoted literal — no raw
    // control character is ever written into the config.
    expect(content).toContain("'http://localhost:9\\n99/systemone'")
    expect(content).not.toContain('http://localhost:9\n99/systemone')
  })

  test('the input schema is closed over the two-key shape', () => {
    const validate = ajv.compile(InitInputSchema)
    expect(validate({ systemOne: null, systemTwo: null })).toBe(true)
    expect(validate({ providers: [{ faculty: 'systemOne', file: 'x.ts' }] })).toBe(false)
  })
})

describe('behavioral init — the interactive collector', () => {
  test('empty answers keep every default', async () => {
    const input = await collectInitInput(scriptedAsk(['', '', '', '', '', '', '']))
    expect(input.systemOne).toEqual({
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKeyEnv: 'TYPESAFE_API_KEY',
    })
    expect(input.systemTwo).toEqual({
      endpoints: { openai: { url: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' } },
    })
  })

  test("answering 'n' disables a faculty", async () => {
    const input = await collectInitInput(scriptedAsk(['n', 'y', '', '', 'n']))
    expect(input.systemOne).toBeNull()
    expect(input.systemTwo).not.toBeNull()
  })
})

describe('behavioral init — the real CLI boundary', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'behavioral-init-e2e-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const repoRoot = (): string => resolve(import.meta.dir, '..', '..', '..')

  const readConfig = async (): Promise<string | undefined> => {
    const configPath = join(home, 'config.ts')
    return (await Bun.file(configPath).exists()) ? await Bun.file(configPath).text() : undefined
  }

  test('the registered bin command generates the default config from JSON', async () => {
    const proc = Bun.spawn(['bun', 'run', 'bin/behavioral.ts', 'init', '{}'], {
      cwd: repoRoot(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BEHAVIORAL_HOME: home },
    })
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ configPath: join(home, 'config.ts') })
    expect(await readConfig()).toContain("apiKey: env('TYPESAFE_API_KEY')")
  })

  // The isTTY branch: behind a real PTY, no input means the prompt tour — the
  // default interactive mode. Each answer lands after its prompt renders.
  test('the default interactive tour runs behind a real PTY', async () => {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const proc = Bun.spawn(['bun', 'run', 'bin/behavioral.ts', 'init'], {
      cwd: repoRoot(),
      env: { ...process.env, BEHAVIORAL_HOME: home },
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, data) => {
          chunks.push(decoder.decode(data))
        },
      },
    })
    const seen = (): string => chunks.join('')
    const waitFor = async (text: string): Promise<void> => {
      const deadline = Date.now() + 10_000
      while (!seen().includes(text)) {
        if (Date.now() > deadline) throw new Error(`never saw '${text}'; saw: ${JSON.stringify(seen())}`)
        await Bun.sleep(20)
      }
    }

    await waitFor('Enable System One')
    proc.terminal?.write('\n')
    await waitFor('System One URL')
    proc.terminal?.write('\n')
    await waitFor('System One model')
    proc.terminal?.write('\n')
    await waitFor('System One API key env var')
    proc.terminal?.write('\n')
    await waitFor('Enable System Two')
    proc.terminal?.write('\n')
    await waitFor('System Two URL')
    proc.terminal?.write('\n')
    await waitFor('System Two API key env var')
    proc.terminal?.write('\n')

    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(await readConfig()).toContain("apiKey: env('TYPESAFE_API_KEY')")
    expect(await readConfig()).toContain("apiKey: env('OPENAI_API_KEY')")
  }, 20_000)
})
