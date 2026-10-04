import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { parseCli, parseCliRequest } from '../cli.ts'

// Absolute path to src/cli.ts for bun -e subprocess imports. Bun resolves
// relative imports in `bun -e` against a synthetic [eval] module URL, not
// the process cwd, so the eval code must import via an absolute path.
const cliPath = path.resolve(import.meta.dir, '../cli.ts')

const TestSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    value: { type: 'number' },
  },
  required: ['name', 'value'],
  additionalProperties: false,
} as unknown as JSONSchemaType<{ name: string; value: number }>

const EmptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as unknown as JSONSchemaType<unknown>

const testOpts = { name: 'test-tool', outputSchema: EmptySchema, help: 'test command' }

describe('Router-level flags (subprocess)', () => {
  test('--version prints the version and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: path.resolve(import.meta.dir, '../../..'),
    })
    expect(await proc.exited).toBe(0)
    const output = (await new Response(proc.stdout).text()).trim()
    const pkg = await Bun.file(path.resolve(import.meta.dir, '../../../package.json')).json()
    expect(output).toBe(pkg.version)
  })

  test('-v prints the version and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', '-v'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: path.resolve(import.meta.dir, '../../..'),
    })
    expect(await proc.exited).toBe(0)
    const pkg = await Bun.file(path.resolve(import.meta.dir, '../../../package.json')).json()
    const output = (await new Response(proc.stdout).text()).trim()
    expect(output).toBe(pkg.version)
  })

  test('--help exits 0 and includes command list with --version flag', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: path.resolve(import.meta.dir, '../../..'),
    })
    expect(await proc.exited).toBe(0)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('serve')
    expect(stderr).toContain('--version')
  })

  test('no args runs the attach-or-start default (a closed stdin detaches cleanly)', async () => {
    // RE-PIN (the systemOne deployment requirement, 2026-10-03): the home
    // carries the minimal valid deployment config — the requirement rejects
    // its absence at load.
    const home = path.join('/tmp', `behavioral-cli-default-${Date.now()}`)
    await Bun.write(
      path.join(home, 'config.ts'),
      "export default { systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' } }",
    )
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: path.resolve(import.meta.dir, '../../..'),
      env: { ...process.env, BEHAVIORAL_HOME: home },
    })
    // No running instance → the bare command starts a foreground instance; the
    // closed stdin (non-TTY) ends the TUI and detaches cleanly.
    const code = await proc.exited
    expect(code).toBe(0)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).not.toContain('Commands')
  })

  test('--schema lists all commands', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', '--schema'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: path.resolve(import.meta.dir, '../../..'),
    })
    expect(await proc.exited).toBe(0)
    const output = JSON.parse(await new Response(proc.stdout).text())
    expect(output.commands).toContain('serve')
    expect(output.commands).toContain('init')
  })
})

describe('parseCli', () => {
  test('parses valid JSON positional arg', async () => {
    const result = await parseCli(['{"name":"test","value":42}'], TestSchema, testOpts)
    expect(result).toEqual({ name: 'test', value: 42 })
  })

  test('parses JSON with extra whitespace', async () => {
    const result = await parseCli(['  {"name":"hello","value":1}  '], TestSchema, testOpts)
    expect(result).toEqual({ name: 'hello', value: 1 })
  })
})

describe('parseCliRequest', () => {
  test('captures the dry-run flag alongside parsed input', async () => {
    const result = await parseCliRequest(['{"name":"test","value":42}', '--dry-run'], TestSchema, {
      name: 'test-tool',
      outputSchema: EmptySchema,
      help: 'test',
    })

    expect(result.input).toEqual({ name: 'test', value: 42 })
    expect(result.flags).toEqual({ dryRun: true })
  })
})

describe('CLI parsing (subprocess)', () => {
  test('--help exits with code 0', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli(['--help'], { type: 'object', properties: {}, additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: {}, additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
  })

  test('--schema input emits JSON Schema and exits 0', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli(['--schema', 'input'], { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: {}, additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
    const output = await new Response(proc.stdout).text()
    const schema = JSON.parse(output)
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('name')
  })

  test('--schema output emits output schema when provided', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli(['--schema', 'output'], { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'], additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
    const output = await new Response(proc.stdout).text()
    const schema = JSON.parse(output)
    expect(schema.properties).toHaveProperty('result')
  })

  test('exits 2 on invalid --schema target', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli(['--schema', 'bad'], { type: 'object', properties: {}, additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: {}, additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(2)
  })

  test('exits 2 on invalid JSON', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli(['not-json'], { type: 'object', properties: {}, additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: {}, additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(2)
  })

  test('exits 2 on AJV validation failure', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli(['{"bad":true}'], { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: {}, additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(2)
  })

  test('exits 2 when no input is provided', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { parseCli } from '${cliPath}'; await parseCli([], { type: 'object', properties: {}, additionalProperties: false } as any, { name: 'test', outputSchema: { type: 'object', properties: {}, additionalProperties: false } as any, help: 'test' })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(2)
  })
})

describe('makeCli', () => {
  test('runs the command with parsed input', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { makeCli } from '${cliPath}';
        const cli = makeCli({
          name: 'test',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } as any,
          outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false } as any,
          help: 'test command',
          run: async (input) => ({ echoed: input.value }),
        });
        await cli.test(['{"value":"hi"}'])`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
    const output = JSON.parse(await new Response(proc.stdout).text())
    expect(output).toEqual({ echoed: 'hi' })
  })

  test('shows request details for --dry-run without running the command', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { makeCli } from '${cliPath}';
        const cli = makeCli({
          name: 'test',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } as any,
          outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false } as any,
          help: 'test command',
          run: async () => { throw new Error('should not run') },
        });
        await cli.test(['{"value":"hi"}', '--dry-run'])`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
    const output = JSON.parse(await new Response(proc.stdout).text())
    expect(output).toEqual({
      command: 'test',
      input: { value: 'hi' },
      dryRun: true,
    })
  })

  test('--schema input emits the input schema', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { makeCli } from '${cliPath}';
        const cli = makeCli({
          name: 'test',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } as any,
          outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false } as any,
          help: 'test command',
          run: async (input) => input,
        });
        await cli.test(['--schema', 'input'])`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
    const output = JSON.parse(await new Response(proc.stdout).text())
    expect(output.properties).toHaveProperty('value')
  })

  test('--help prints the simple flag surface', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { makeCli } from '${cliPath}';
        const cli = makeCli({
          name: 'test',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } as any,
          outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false } as any,
          help: 'test command',
          run: async (input) => input,
        });
        await cli.test(['--help'])`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    expect(await proc.exited).toBe(0)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('--schema <input|output>')
    expect(stderr).toContain('--dry-run')
    expect(stderr).toContain('--help')
  })
})

describe('makeCliRouter — the default (no-subcommand) entry', () => {
  test('a bare invocation runs the default handler with the remaining args', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `import { makeCliRouter } from '${cliPath}';
        const router = makeCliRouter({
          name: 'behavioral',
          description: 'test',
          commands: { serve: async () => {} },
          default: async (args) => {
            process.stdout.write('default ran:' + JSON.stringify(args));
          },
        });
        await router(['behavioral']);`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await proc.exited).toBe(0)
    const output = await new Response(proc.stdout).text()
    expect(output).toContain('default ran:[]')
  })
})
