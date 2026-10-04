import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../load-config.ts'

const withConfig = async (source: string | undefined, run: (path: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'behavioral-config-'))
  const file = join(dir, 'config.ts')
  try {
    if (source !== undefined) await Bun.write(file, source)
    await run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The deployment requirement's shared fixture fragment (the 2026-10-03
// ruling): a deployment boots with a decision model or fails fast.
const ONE = "systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' }"

describe('loadConfig', () => {
  test('a missing config file fails fast — a deployment without a decision model never boots', async () => {
    // RE-PIN (the deployment requirement): the old empty-config default
    // applied the defaults; now the requirement rejects at the resolved path.
    await withConfig(undefined, async (file) => {
      const error = await loadConfig(file).catch((e: Error) => e)
      expect((error as Error).message).toMatch(/"systemOne" is REQUIRED/)
      expect((error as Error).message).toContain(file)
      expect((error as Error).message).toContain('regenerate via behavioral init')
    })
  })

  test('a present config file yields its default export', async () => {
    await withConfig(`export default { actuators: ['shell'], ${ONE} }`, async (file) => {
      const config = await loadConfig(file)
      expect(config).toEqual({
        actuators: ['shell'],
        systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
      })
    })
  })

  test('the model identifiers are DATA — the composition reads them into the init frame', async () => {
    await withConfig(
      `export default {
        systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', apiKey: 'k' },
        systemTwo: { openai: { url: 'https://api.openai.com/v1' } },
        ui: { provider: 'openai', modelId: 'gpt-x' },
      }`,
      async (file) => {
        const config = await loadConfig(file)
        expect(config.systemOne).toEqual({
          url: 'https://openrouter.ai/api/alpha/decisions',
          model: 'typesafe/jev-1.13',
          apiKey: 'k',
        })
        expect(config.systemTwo).toEqual({ openai: { url: 'https://api.openai.com/v1' } })
        expect(config.ui).toEqual({ provider: 'openai', modelId: 'gpt-x' })
      },
    )
  })

  test('systemTwo: null is valid — the faculty stays mounted but endpoint-less', async () => {
    // RE-PIN (the deployment requirement): the systemOne-null leg of the old
    // fixture now rejects (below); systemTwo's null stays valid.
    await withConfig(`export default { ${ONE}, systemTwo: null }`, async (file) => {
      const config = await loadConfig(file)
      expect(config.systemTwo).toBeNull()
    })
  })

  test('rejects a non-object default export', async () => {
    await withConfig(`export default 42`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/invalid config/)
    })
  })

  test('rejects an unknown actuator name with the allowed set', async () => {
    await withConfig(`export default { actuators: ['nope'] }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/unknown actuator "nope".*expected one of: shell, store, security/)
    })
  })

  test('the allow-list admits the trio only — browser faculties and retired names are unknown', async () => {
    await withConfig(`export default { actuators: ['systemOne'] }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/unknown actuator "systemOne"/)
    })
    await withConfig(`export default { actuators: ['mcp'] }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/unknown actuator "mcp"/)
    })
  })

  test('defaults to <BEHAVIORAL_HOME>/config.ts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-home-'))
    const previous = process.env.BEHAVIORAL_HOME
    process.env.BEHAVIORAL_HOME = home
    try {
      await Bun.write(join(home, 'config.ts'), `export default { actuators: ['store'], ${ONE} }`)
      const config = await loadConfig()
      expect(config).toEqual({
        actuators: ['store'],
        systemOne: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
      })
    } finally {
      if (previous === undefined) delete process.env.BEHAVIORAL_HOME
      else process.env.BEHAVIORAL_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an unloadable config fails fast with the path', async () => {
    await withConfig(`export default {`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/failed to load/)
    })
  })

  test('the legacy useFaculty override keys are rejected — regenerate via behavioral init', async () => {
    await withConfig(`const shell = () => 'wired'\nexport default { shell }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/unknown config key "shell".*behavioral init/s)
    })
  })

  test('systemOne without a url is rejected', async () => {
    await withConfig(`export default { systemOne: { model: 'typesafe/jev-1.13' } }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/"systemOne".*"url"/s)
    })
  })

  describe('systemOne transport (the rest ↔ webgpu toggle)', () => {
    test('a webgpu systemOne config loads — model, no url', async () => {
      await withConfig(
        `export default { systemOne: { transport: 'webgpu', model: 'clef-flash-ternary' } }`,
        async (file) => {
          const config = await loadConfig(file)
          expect(config.systemOne).toEqual({ transport: 'webgpu', model: 'clef-flash-ternary' })
        },
      )
    })

    test('an unknown transport value fails fast', async () => {
      await withConfig(`export default { systemOne: { transport: 'smoke', url: 'https://x' } }`, async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/"systemOne".*"transport"/s)
      })
    })

    test('a webgpu systemOne without a model is rejected — model required-for-webgpu', async () => {
      await withConfig(`export default { systemOne: { transport: 'webgpu' } }`, async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/"systemOne".*"model"/s)
      })
    })

    test('a rest systemOne without a url is still rejected (the default stays rest)', async () => {
      await withConfig(`export default { systemOne: { model: 'typesafe/jev-1.13' } }`, async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/"systemOne".*"url"/s)
      })
    })
  })

  test('a systemTwo endpoint transport must be rest or webgpu', async () => {
    await withConfig(
      `export default { systemTwo: { openai: { url: 'https://api.openai.com/v1', transport: 'smoke' } } }`,
      async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/transport/)
      },
    )
  })

  test('a ui generation target must carry string provider/modelId', async () => {
    await withConfig(`export default { ui: { provider: 42 } }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/"ui".*"provider"/s)
    })
  })

  describe('inference providers (the proxy allow-list + CSP list)', () => {
    test('a provider origin map loads as data', async () => {
      await withConfig(
        `export default { ${ONE}, inference: { providers: { typesafe: 'https://openrouter.ai' } } }`,
        async (file) => {
          const config = await loadConfig(file)
          expect(config.inference).toEqual({ providers: { typesafe: 'https://openrouter.ai' } })
        },
      )
    })

    test('a provider origin must be an http(s) URL — fail fast on anything else', async () => {
      await withConfig(`export default { inference: { providers: { bad: 'not a url' } } }`, async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/"inference".*"bad"/s)
      })
    })

    test('a provider origin must not be a non-http scheme — the SSRF floor', async () => {
      await withConfig(`export default { inference: { providers: { bad: 'file:///etc' } } }`, async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/"inference".*"bad"/s)
      })
    })
  })

  describe('the systemOne deployment requirement (the 2026-10-03 ruling)', () => {
    // The ruling: the deployed config REQUIRES a decision model — the
    // optionality was test convenience (bProgram's models stay optional; the
    // enforcement is ONE POINT, here). Fail fast with the config path and
    // the regenerate-via-init hint.
    test('a config without systemOne rejects, naming the path and the init hint', async () => {
      await withConfig(`export default { actuators: ['shell'] }`, async (file) => {
        const error = await loadConfig(file).catch((e: Error) => e)
        expect((error as Error).message).toMatch(/"systemOne" is REQUIRED/)
        // The path is named — fail fast points at the offending config.
        expect((error as Error).message).toContain(file)
        expect((error as Error).message).toContain('regenerate via behavioral init')
      })
    })

    test('a null systemOne rejects the same — null omits nothing anymore', async () => {
      await withConfig(`export default { systemOne: null, actuators: [] }`, async (file) => {
        await expect(loadConfig(file)).rejects.toThrow(/"systemOne" is REQUIRED.*behavioral init/s)
      })
    })

    test('a valid rest endpoint loads — and a webgpu one too', async () => {
      await withConfig(`export default { ${ONE} }`, async (file) => {
        const config = await loadConfig(file)
        expect(config.systemOne).toEqual({
          url: 'https://openrouter.ai/api/alpha/decisions',
          model: 'typesafe/jev-1.13',
        })
      })
      await withConfig(
        `export default { systemOne: { transport: 'webgpu', model: 'clef-flash-ternary' } }`,
        async (file) => {
          const config = await loadConfig(file)
          expect(config.systemOne).toEqual({ transport: 'webgpu', model: 'clef-flash-ternary' })
        },
      )
    })
  })
})
