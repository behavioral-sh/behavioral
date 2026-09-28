import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ajv } from '../../behavioral/behavioral.types.ts'
import { bProgram } from '../b-program.ts'
import { type Ask, collectInitInput, type InitInput, InitInputSchema, init, runInit as runInitDirect } from '../init.ts'
import { loadConfig } from '../load-config.ts'

/**
 * `behavioral init` — the config generator — through its real CLI handler
 * (makeCli: JSON positional in, validated JSON out), against a temp
 * BEHAVIORAL_HOME. The locked contract:
 *
 * - absent faculties default on (TypeSafe/OpenAI urls, env-NAME secrets);
 *   `null` omits a faculty; objects customize over the defaults;
 * - no literal secrets: api keys ride as `env('<NAME>')` references that fail
 *   fast when the variable is unset;
 * - an existing config is never clobbered without `force`;
 * - provider scaffolding writes `<home>/providers/<file>` (import-safe bare
 *   specifiers, thanks to the global-install resolution) and points the
 *   faculty's `entry` at it.
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

  test('an empty input generates the default config — both faculties, env-name secrets', async () => {
    const output = await runInit('{}')
    expect(output.configPath).toBe(configPath())
    expect(output.files).toContain('config.ts')
    const content = readConfig()
    expect(content).toContain("import { defineConfig } from '@behavioral/sh'")
    expect(content).toContain("import { useSystemOne, useSystemTwo } from '@behavioral/sh/faculties'")
    expect(content).toContain('https://api.typesafe.ai/v1/systemone')
    expect(content).toContain("'jev-latest'")
    expect(content).toContain("apiKey: env('TYPESAFE_API_KEY')")
    expect(content).toContain('https://api.openai.com/v1')
    expect(content).toContain("apiKey: env('OPENAI_API_KEY')")
    // No literal secrets anywhere.
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]/)
  })

  // The review's missing load-test: the generated config must not merely look
  // right — it must LOAD (module resolution from the home) and COMPOSE.
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
      expect(typeof config.systemOne).toBe('function')
      expect(typeof config.systemTwo).toBe('function')
      const runtime = bProgram(config)
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

  test('an existing config fails fast with the path; force overwrites', async () => {
    await runInit('{}')
    await expect(init(['{}'])).rejects.toThrow(/already exists.*config\.ts.*force/s)
    logs.length = 0
    await runInit('{"force": true}')
    expect(readConfig()).toContain('defineConfig')
  })

  test('provider scaffolding writes the entry and points the faculty at it', async () => {
    const output = await runInit(
      JSON.stringify({
        providers: [{ faculty: 'systemOne', file: 'my-one.faculty.ts' }],
      }),
    )
    expect(output.files).toContain('providers/my-one.faculty.ts')
    const entry = readFileSync(join(home, 'providers', 'my-one.faculty.ts'), 'utf8')
    expect(entry).toContain('configSystemOne')
    expect(entry).toContain('SystemOneRespond')
    expect(readConfig()).toContain("entry: 'providers/my-one.faculty.ts'")
  })

  // The review's follow-up 3: the stub must match ITS faculty's contract —
  // systemOne's context is a single endpoint and the Decisions output
  // ({model, answers}); systemTwo's is the endpoint MAP and the Open
  // Responses output ({items, status}). A stub that fails its own
  // typecheck is a broken scaffold.
  test('the systemTwo provider stub matches the systemTwo contract', async () => {
    await runInit(
      JSON.stringify({
        providers: [{ faculty: 'systemTwo', file: 'my-two.faculty.ts' }],
      }),
    )
    const entry = readFileSync(join(home, 'providers', 'my-two.faculty.ts'), 'utf8')
    expect(entry).toContain('configSystemTwo')
    expect(entry).toContain('SystemTwoRespond')
    // systemTwo's respond context is the endpoint MAP, not a single endpoint.
    expect(entry).toContain('{ endpoints, signal }')
    // systemTwo's output is the Open Responses shape — items + status.
    expect(entry).toContain("{ items: [], status: 'completed' }")
    // Not the systemOne (Decisions) shape.
    expect(entry).not.toContain('answers')
    expect(entry).not.toContain('{ endpoint, signal }')
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

  test('the systemOne provider stub keeps the Decisions shape', async () => {
    await runInit(
      JSON.stringify({
        providers: [{ faculty: 'systemOne', file: 'my-one.faculty.ts' }],
      }),
    )
    const entry = readFileSync(join(home, 'providers', 'my-one.faculty.ts'), 'utf8')
    expect(entry).toContain('{ endpoint, signal }')
    expect(entry).toContain("{ model: 'custom', answers: {} }")
  })

  test('two providers for one faculty are rejected', async () => {
    const input = JSON.stringify({
      providers: [
        { faculty: 'systemOne', file: 'a.faculty.ts' },
        { faculty: 'systemOne', file: 'b.faculty.ts' },
      ],
    })
    await expect(init([input])).rejects.toThrow(/one provider per faculty/)
  })

  // The review's follow-up 7: the file-name pattern gates the JSON path via
  // the input schema, but the interactive collector's free text flows into
  // runInit raw — runInit is the one funnel both paths share, so the pattern
  // is enforced there.
  test('runInit rejects a traversal file name whatever path it arrives by', async () => {
    // runInit directly: the CLI's schema gate (process.exit on bad JSON)
    // already protects the JSON path — this proves the FUNNEL, which is what
    // the interactive collector's free text flows through.
    const bad: InitInput = { providers: [{ faculty: 'systemOne', file: '../../evil.ts' }] }
    await expect(runInitDirect(bad)).rejects.toThrow(/file name/)
    // The collector path: collected input reaches the same gate.
    const collected = await collectInitInput(
      // systemOne×4 defaults, systemTwo×3 defaults, then scaffold y → faculty → file.
      scriptedAsk(['', '', '', '', '', '', '', 'y', 'systemOne', '../../evil.ts']),
    )
    await expect(runInitDirect(collected)).rejects.toThrow(/file name/)
  })

  test('the input schema rejects path traversal in a provider file name', () => {
    const validate = ajv.compile(InitInputSchema)
    const bad: InitInput = { providers: [{ faculty: 'systemOne', file: '../evil.ts' }] }
    expect(validate(bad)).toBe(false)
    const ok: InitInput = { providers: [{ faculty: 'systemOne', file: 'my-one.faculty.ts' }] }
    expect(validate(ok)).toBe(true)
  })
})

describe('behavioral init — the interactive collector', () => {
  test('empty answers keep every default', async () => {
    const input = await collectInitInput(scriptedAsk(['', '', '', '', '', '', '', '']))
    expect(input.systemOne).toEqual({
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKeyEnv: 'TYPESAFE_API_KEY',
    })
    expect(input.systemTwo).toEqual({
      endpoints: { openai: { url: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' } },
    })
    expect(input.providers).toBeUndefined()
  })

  test("answering 'n' disables a faculty", async () => {
    const input = await collectInitInput(scriptedAsk(['n', 'y', '', '', 'n']))
    expect(input.systemOne).toBeNull()
    expect(input.systemTwo).not.toBeNull()
  })

  test('the scaffold tour collects the provider', async () => {
    const input = await collectInitInput(
      scriptedAsk(['', '', '', '', '', '', '', 'y', 'systemTwo', 'my-two.faculty.ts']),
    )
    expect(input.providers).toEqual([{ faculty: 'systemTwo', file: 'my-two.faculty.ts' }])
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
    await waitFor('Scaffold a custom provider entry')
    proc.terminal?.write('n\n')

    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(await readConfig()).toContain("apiKey: env('TYPESAFE_API_KEY')")
    expect(await readConfig()).toContain("apiKey: env('OPENAI_API_KEY')")
  }, 20_000)
})
