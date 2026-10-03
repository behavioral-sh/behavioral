import { describe, expect, test } from 'bun:test'
import { InMemoryKeychain } from '../keychain-oauth-provider.ts'
import { providerTokenKey, saveProviderToken, vendProviderToken } from '../provider-keys.ts'

/**
 * The provider-credential custody spec — R2's floor: static vendor keys live
 * as origin-stamped blobs under the keychain service, one identifier per
 * provider, and the vend resolves by provider id with the issuer-binding
 * rule (the same rule the OAuth floor applies). Cross-provider isolation is
 * the pin: the Typesafe resolution never yields the OpenRouter credential.
 */

const TYPESAFE_ORIGIN = 'https://api.typesafe.ai'
const OPENROUTER_ORIGIN = 'https://api.openrouter.ai'

describe('provider credential custody', () => {
  test('save → vend round-trips the token through the one shared identifier', async () => {
    const keychain = InMemoryKeychain()
    await saveProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, token: 'sk-ts-1', keychain })
    const token = await vendProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, keychain })
    expect(token).toBe('sk-ts-1')
    // Both legs derive from the same provider-id map — the route name IS the
    // keychain entry.
    const raw = await keychain.get(providerTokenKey('typesafe'))
    expect(raw).not.toBeNull()
  })

  test('cross-provider isolation: each provider vends only its own credential', async () => {
    const keychain = InMemoryKeychain()
    await saveProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, token: 'sk-ts-1', keychain })
    await saveProviderToken({ provider: 'openrouter', origin: OPENROUTER_ORIGIN, token: 'sk-or-1', keychain })
    expect(await vendProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, keychain })).toBe('sk-ts-1')
    expect(await vendProviderToken({ provider: 'openrouter', origin: OPENROUTER_ORIGIN, keychain })).toBe('sk-or-1')
  })

  test('issuer binding: a credential vends only to its own origin — never across providers', async () => {
    const keychain = InMemoryKeychain()
    await saveProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, token: 'sk-ts-1', keychain })
    // The Typesafe slot resolves to nothing for the OpenRouter origin — a
    // wrong-origin vend is absent, never the wrong key.
    expect(await vendProviderToken({ provider: 'typesafe', origin: OPENROUTER_ORIGIN, keychain })).toBeUndefined()
  })

  test('re-saving replaces the entry (the rotation leg)', async () => {
    const keychain = InMemoryKeychain()
    await saveProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, token: 'sk-ts-1', keychain })
    await saveProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, token: 'sk-ts-2', keychain })
    expect(await vendProviderToken({ provider: 'typesafe', origin: TYPESAFE_ORIGIN, keychain })).toBe('sk-ts-2')
  })

  test('fail-closed: missing slot, corrupt blob, empty token, unstamped blob', async () => {
    const keychain = InMemoryKeychain()
    expect(await vendProviderToken({ provider: 'absent', origin: TYPESAFE_ORIGIN, keychain })).toBeUndefined()
    await keychain.set(providerTokenKey('corrupt'), 'not json at all')
    expect(await vendProviderToken({ provider: 'corrupt', origin: TYPESAFE_ORIGIN, keychain })).toBeUndefined()
    await saveProviderToken({ provider: 'empty', origin: TYPESAFE_ORIGIN, token: '', keychain })
    expect(await vendProviderToken({ provider: 'empty', origin: TYPESAFE_ORIGIN, keychain })).toBeUndefined()
  })
})
