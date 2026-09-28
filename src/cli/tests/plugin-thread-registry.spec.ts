/**
 * The plugin-thread admission registry — host-local under `<home>` (the
 * config.ts/traces pattern, never the space-scoped store), keyed
 * (plugin, file, content hash, space). `admitted` entries carry the
 * validated thread snapshot (threads are pure data — a boot mounts from
 * the snapshot and never re-imports the plugin file); `rejected` entries
 * carry the reason and stay out. Hash keying makes a plugin update re-arm
 * the proposal — new thread code is never silently admitted.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '../../behavioral/behavioral.types.ts'
import { behavioralHome } from '../../old-faculties/behavioral-home.ts'
import {
  PLUGIN_THREAD_REGISTRY_FILE,
  pluginThreadRegistryKey,
  pluginThreadRegistryPath,
  readPluginThreadRegistry,
  writePluginThreadRegistry,
} from '../plugin-thread-registry.ts'

describe('plugin-thread registry — the key', () => {
  test('root and a named space hold independent entries for the same thread', () => {
    const root = pluginThreadRegistryKey({ plugin: '/p', file: 't.ts', hash: 'h' })
    const named = pluginThreadRegistryKey({ plugin: '/p', file: 't.ts', hash: 'h', space: 's1' })
    expect(root).not.toBe(named)
    // the key is stable per (plugin, file, hash, space)
    expect(pluginThreadRegistryKey({ plugin: '/p', file: 't.ts', hash: 'h' })).toBe(root)
  })

  test('a changed hash is a different key — a plugin update re-arms the proposal', () => {
    expect(pluginThreadRegistryKey({ plugin: '/p', file: 't.ts', hash: 'h1' })).not.toBe(
      pluginThreadRegistryKey({ plugin: '/p', file: 't.ts', hash: 'h2' }),
    )
  })

  test('a new file is a different key', () => {
    expect(pluginThreadRegistryKey({ plugin: '/p', file: 'a.ts', hash: 'h' })).not.toBe(
      pluginThreadRegistryKey({ plugin: '/p', file: 'b.ts', hash: 'h' }),
    )
  })
})

describe('plugin-thread registry — read/write (host-local, `<home>`)', () => {
  const greeter: Thread = { label: 'greeter', once: true, rules: [{ request: { type: 'hello' } }] }

  test('the registry file lives under behavioralHome — the config.ts/traces pattern', () => {
    expect(pluginThreadRegistryPath('/home/x').endsWith(PLUGIN_THREAD_REGISTRY_FILE)).toBe(true)
    expect(pluginThreadRegistryPath('/home/x')).toBe(join('/home/x', PLUGIN_THREAD_REGISTRY_FILE))
    expect(behavioralHome({ BEHAVIORAL_HOME: '/iso' })).toBe('/iso')
  })

  test('a missing registry reads as empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'pt-registry-'))
    try {
      expect(readPluginThreadRegistry(home)).toEqual({})
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('write persists and read round-trips both entry kinds', () => {
    const home = mkdtempSync(join(tmpdir(), 'pt-registry-'))
    try {
      const admittedKey = pluginThreadRegistryKey({ plugin: '/p', file: 't.ts', hash: 'h' })
      const rejectedKey = pluginThreadRegistryKey({ plugin: '/p', file: 'b.ts', hash: 'h2' })
      writePluginThreadRegistry(home, {
        [admittedKey]: { status: 'admitted', thread: greeter },
        [rejectedKey]: { status: 'rejected', reason: 'structural verdict: failed (livelock)' },
      })
      const read = readPluginThreadRegistry(home)
      expect(read[admittedKey]).toEqual({ status: 'admitted', thread: greeter })
      expect(read[rejectedKey]).toEqual({ status: 'rejected', reason: 'structural verdict: failed (livelock)' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a malformed registry file fails fast with the path — never silently ignored', () => {
    const home = mkdtempSync(join(tmpdir(), 'pt-registry-'))
    try {
      writeFileSync(pluginThreadRegistryPath(home), '{not json')
      expect(() => readPluginThreadRegistry(home)).toThrow(PLUGIN_THREAD_REGISTRY_FILE)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an entry whose thread fails the engine ThreadSchema fails fast with the path', () => {
    const home = mkdtempSync(join(tmpdir(), 'pt-registry-'))
    try {
      writeFileSync(
        pluginThreadRegistryPath(home),
        JSON.stringify({ k: { status: 'admitted', thread: { label: 'no-rules' } } }),
      )
      expect(() => readPluginThreadRegistry(home)).toThrow(PLUGIN_THREAD_REGISTRY_FILE)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('write rejects an invalid entry at the boundary', () => {
    const home = mkdtempSync(join(tmpdir(), 'pt-registry-'))
    try {
      expect(() =>
        writePluginThreadRegistry(home, {
          k: { status: 'admitted', thread: { label: 'no-rules' } as unknown as Thread },
        }),
      ).toThrow()
      expect(readPluginThreadRegistry(home)).toEqual({})
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
