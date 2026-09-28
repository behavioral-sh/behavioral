import { describe, expect, test } from 'bun:test'
import {
  BunKeychainOAuthProvider,
  InMemoryKeychain,
  IssuerMismatchError,
  selectClientAuthMethod,
  tokensKey,
  vendKeychainToken,
} from '../keychain-oauth-provider.ts'

const SERVER_URL = 'https://mcp.example.com/mcp'
const baseOptions = (keychain: ReturnType<typeof InMemoryKeychain>) => ({
  serverUrl: SERVER_URL,
  grantType: 'client_credentials' as const,
  clientId: 'client-1',
  clientSecret: 'secret-1',
  scope: 'read',
  keychain,
})

describe('BunKeychainOAuthProvider — token round-trip across a reconnect', () => {
  test('saveTokens persists to the keychain; a new provider instance reads them back', async () => {
    const keychain = InMemoryKeychain()

    // First process: the grant exchange saves issuer-stamped tokens.
    const first = new BunKeychainOAuthProvider(baseOptions(keychain))
    await first.saveTokens(
      {
        access_token: 'atk-1',
        token_type: 'Bearer',
        refresh_token: 'rtk-1',
        expires_in: 3600,
        issuer: 'https://as.example.com',
      },
      { issuer: 'https://as.example.com' },
    )

    // Simulate a process restart: a brand-new provider with the SAME keychain
    // (keychain persists; the connection does not). tokens() reads back.
    const second = new BunKeychainOAuthProvider(baseOptions(keychain))
    const recovered = await second.tokens({ issuer: 'https://as.example.com' })
    expect(recovered).toBeDefined()
    expect(recovered!.access_token).toBe('atk-1')
    expect(recovered!.refresh_token).toBe('rtk-1')
    expect(recovered!.issuer).toBe('https://as.example.com')
  })

  test('ctx === undefined returns the most-recently-saved token set (resource-server read)', async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk-2', token_type: 'Bearer', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    // No ctx — the per-request bearer read happens pre-discovery.
    const tokens = await provider.tokens()
    expect(tokens?.access_token).toBe('atk-2')
  })

  test('refresh_token grant uses the persisted refresh token after a reconnect', async () => {
    const keychain = InMemoryKeychain()
    const first = new BunKeychainOAuthProvider({
      ...baseOptions(keychain),
      grantType: 'refresh_token',
      initialRefreshToken: 'initial-rt',
    })
    // The grant exchange refreshes and saves a rotated refresh token.
    await first.saveTokens(
      { access_token: 'atk-3', token_type: 'Bearer', refresh_token: 'rotated-rt', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )

    // Reconnect: prepareTokenRequest must use the rotated refresh token, not
    // the initial one.
    const second = new BunKeychainOAuthProvider({
      ...baseOptions(keychain),
      grantType: 'refresh_token',
      initialRefreshToken: 'initial-rt',
    })
    // Warm the token cache (tokens() loads from keychain).
    await second.tokens({ issuer: 'https://as.example.com' })
    const params = second.prepareTokenRequest()
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('rotated-rt')
  })
})

describe('BunKeychainOAuthProvider — issuer binding', () => {
  test('tokens treats a blob stamped with a different issuer as absent', async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk-a', token_type: 'Bearer', issuer: 'https://as-a.example.com' },
      { issuer: 'https://as-a.example.com' },
    )
    // The resolved authorization server is B — the A-stamped blob is not
    // B's credential and must not be vended (issuer-binding, SEP-2352).
    expect(await provider.tokens({ issuer: 'https://as-b.example.com' })).toBeUndefined()
    // Same issuer → returned.
    expect((await provider.tokens({ issuer: 'https://as-a.example.com' }))?.access_token).toBe('atk-a')
  })

  test('tokens treats an unstamped blob as bound to whatever AS asks', async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk-legacy', token_type: 'Bearer' },
      { issuer: 'https://as.example.com' },
    )
    expect((await provider.tokens({ issuer: 'https://other.example.com' }))?.access_token).toBe('atk-legacy')
  })

  test('clientInformation returns issuer-bound persisted info only when the issuer matches', async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))

    // The grant flow stamps issuer A and saves client info.
    await provider.saveClientInformation(
      { client_id: 'client-1', client_secret: 'secret-1', issuer: 'https://as-a.example.com' },
      { issuer: 'https://as-a.example.com' },
    )

    // Same issuer → bound info returned.
    const bound = await provider.clientInformation({ issuer: 'https://as-a.example.com' })
    expect(bound?.issuer).toBe('https://as-a.example.com')

    // Different issuer → persisted info is NOT returned; falls back to the
    // statically-configured (unstamped) credentials.
    const mismatched = await provider.clientInformation({ issuer: 'https://as-b.example.com' })
    expect(mismatched?.issuer).toBeUndefined()
    expect(mismatched?.client_id).toBe('client-1')
  })

  test('validateResourceURL rejects a resource on a different origin', async () => {
    const provider = new BunKeychainOAuthProvider(baseOptions(InMemoryKeychain()))
    await expect(provider.validateResourceURL(SERVER_URL, 'https://evil.example.com/resource')).rejects.toBeInstanceOf(
      IssuerMismatchError,
    )
  })

  test('validateResourceURL accepts a resource on the same origin', async () => {
    const provider = new BunKeychainOAuthProvider(baseOptions(InMemoryKeychain()))
    const resolved = await provider.validateResourceURL(SERVER_URL, 'https://mcp.example.com/other')
    expect(resolved?.origin).toBe('https://mcp.example.com')
  })

  test('validateResourceURL returns undefined when no resource is requested', async () => {
    const provider = new BunKeychainOAuthProvider(baseOptions(InMemoryKeychain()))
    expect(await provider.validateResourceURL(SERVER_URL, undefined)).toBeUndefined()
  })
})

describe('vendKeychainToken — the keychain floor of credential vending', () => {
  test('vends the access_token from a stored issuer-stamped blob', async () => {
    const keychain = InMemoryKeychain()
    await keychain.set(
      tokensKey(SERVER_URL),
      JSON.stringify({ access_token: 'atk-9', token_type: 'Bearer', issuer: 'https://as.example.com' }),
    )
    expect(await vendKeychainToken({ serverUrl: SERVER_URL, keychain })).toBe('atk-9')
  })

  test('a ctx issuer binds the floor: a blob stamped for another AS is treated as absent', async () => {
    const keychain = InMemoryKeychain()
    await keychain.set(
      tokensKey(SERVER_URL),
      JSON.stringify({ access_token: 'atk-9', token_type: 'Bearer', issuer: 'https://as-a.example.com' }),
    )
    // The resolved AS is B — the A-stamped blob is not B's credential.
    expect(
      await vendKeychainToken({ serverUrl: SERVER_URL, keychain, issuer: 'https://as-b.example.com' }),
    ).toBeUndefined()
    // Matching issuer → vended.
    expect(await vendKeychainToken({ serverUrl: SERVER_URL, keychain, issuer: 'https://as-a.example.com' })).toBe(
      'atk-9',
    )
    // No ctx issuer (pre-discovery read) → the most-recently-saved blob vends.
    expect(await vendKeychainToken({ serverUrl: SERVER_URL, keychain })).toBe('atk-9')
  })

  test('treats a missing slot, a corrupt blob, and an empty access_token as absent', async () => {
    const keychain = InMemoryKeychain()
    expect(await vendKeychainToken({ serverUrl: SERVER_URL, keychain })).toBeUndefined()
    await keychain.set(tokensKey(SERVER_URL), 'not-json')
    expect(await vendKeychainToken({ serverUrl: SERVER_URL, keychain })).toBeUndefined()
    await keychain.set(tokensKey(SERVER_URL), JSON.stringify({ access_token: '', token_type: 'Bearer' }))
    expect(await vendKeychainToken({ serverUrl: SERVER_URL, keychain })).toBeUndefined()
  })
})

describe('selectClientAuthMethod — the plain client-auth selection', () => {
  test('prefers basic, then post, when a client secret is available and supported', () => {
    const info = { client_id: 'c', client_secret: 's' }
    expect(selectClientAuthMethod(info, ['none', 'client_secret_post', 'client_secret_basic'])).toBe(
      'client_secret_basic',
    )
    expect(selectClientAuthMethod(info, ['none', 'client_secret_post'])).toBe('client_secret_post')
  })

  test('falls back to none for a public client or an unsupported AS', () => {
    expect(selectClientAuthMethod({ client_id: 'c' }, ['client_secret_basic', 'none'])).toBe('none')
    expect(selectClientAuthMethod({ client_id: 'c', client_secret: 's' }, ['none'])).toBe('none')
  })
})

describe('BunKeychainOAuthProvider — invalidateCredentials clears by scope', () => {
  test("invalidateCredentials('tokens') drops the token slot", async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk', token_type: 'Bearer', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    await provider.invalidateCredentials('tokens')
    expect(await provider.tokens()).toBeUndefined()
  })

  test("invalidateCredentials('all') drops every slot", async () => {
    const keychain = InMemoryKeychain()
    const provider = new BunKeychainOAuthProvider(baseOptions(keychain))
    await provider.saveTokens(
      { access_token: 'atk', token_type: 'Bearer', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    await provider.saveClientInformation(
      { client_id: 'client-1', issuer: 'https://as.example.com' },
      { issuer: 'https://as.example.com' },
    )
    await provider.saveDiscoveryState({ authorizationServerUrl: 'https://as.example.com' })
    await provider.invalidateCredentials('all')
    expect(await provider.tokens()).toBeUndefined()
    expect((await provider.clientInformation({ issuer: 'https://as.example.com' }))?.issuer).toBeUndefined()
    expect(await provider.discoveryState()).toBeUndefined()
  })
})
