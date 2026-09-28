/**
 * `BunKeychainOAuthProvider` — the security faculty's credential store: an
 * issuer-binding OAuth provider that persists tokens and client information
 * to the OS keychain (via {@link BunKeychain}), SDK-free (plain types from
 * `security/types.ts` — the `@modelcontextprotocol/client` dependency is
 * retired).
 *
 * @remarks
 * One provider per server-url, reused across process restarts: the keychain
 * persists, the connection doesn't, but a reconnect reads tokens back via
 * {@link BunKeychainOAuthProvider.tokens | tokens()}.
 *
 * Backs the non-interactive `client_credentials` and `refresh_token` grants:
 * this provider supplies the grant parameters and credentials
 * ({@link BunKeychainOAuthProvider.prepareTokenRequest | prepareTokenRequest},
 * {@link BunKeychainOAuthProvider.addClientAuthentication | addClientAuthentication},
 * {@link BunKeychainOAuthProvider.clientInformation | clientInformation}) and
 * persists the issuer-stamped results. The HTTP exchange itself is the grant
 * orchestrator's (a later slice rides these hooks); MINIMAL: nothing here
 * calls the token endpoint yet.
 *
 * Issuer-binding: `clientInformation(ctx)` and `tokens(ctx)` key persisted
 * blobs by the stamped `issuer`; a blob whose `issuer` does not match the
 * resolved authorization server is treated as absent. When `ctx ===
 * undefined` (the pre-discovery per-request read), the most-recently-saved
 * blob for the server is returned.
 *
 * MINIMAL: `validateResourceURL` enforces origin (scheme+host+port) binding
 * between the MCP server URL and a requested `resource` (RFC 8707). Upgrade
 * path: full RFC 8707 + RFC 9207 `iss` validation rides the grant
 * orchestrator when it lands; this hook covers the resource-binding leg.
 *
 * @packageDocumentation
 */

import type {
  ClientAuthMethod,
  OAuthClientInformation,
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from './types.ts'

// ---------------------------------------------------------------------------
// Plain client-auth selection (the SDK-free replacement for the SDK helper)
// ---------------------------------------------------------------------------

/**
 * Selects the client-auth method for a token request: basic, then post, when
 * a client secret is available and supported; `none` otherwise (public
 * clients, or an AS that only offers `none`). Documented SDK priority order,
 * reimplemented against plain types.
 */
export const selectClientAuthMethod = (
  clientInformation: OAuthClientInformation,
  supportedMethods: string[],
): ClientAuthMethod => {
  if (clientInformation.client_secret !== undefined) {
    if (supportedMethods.includes('client_secret_basic')) return 'client_secret_basic'
    if (supportedMethods.includes('client_secret_post')) return 'client_secret_post'
  }
  return 'none'
}

/**
 * Thrown when an authorization-server issuer identifier fails validation —
 * the mix-up-attack guard (RFC 8414 §3.3 metadata echo / RFC 9207 `iss`).
 * Fatal for a grant flow, never retryable-by-credential-invalidation.
 */
export class IssuerMismatchError extends Error {
  /** Which check failed — metadata echo or authorization-response `iss`. */
  readonly kind: 'metadata' | 'authorization_response'
  /** The issuer the client expected (from validated metadata / discovery input). */
  readonly expected: string | undefined
  /** The issuer value that was received. Attacker-controllable on the response path. */
  readonly received: string | undefined

  constructor(kind: 'metadata' | 'authorization_response', expected: string | undefined, received: string | undefined) {
    // The values are JSON-encoded to neutralize log-injection.
    super(
      `issuer mismatch (${kind}): expected ${JSON.stringify(expected ?? null)}, received ${JSON.stringify(received ?? null)}`,
    )
    this.name = 'IssuerMismatchError'
    this.kind = kind
    this.expected = expected
    this.received = received
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type OAuthGrantType = 'client_credentials' | 'refresh_token'

export type KeychainOAuthProviderOptions = {
  /** The remote MCP server URL — keys the keychain slots (one per server). */
  serverUrl: string
  /** The OAuth grant to use. */
  grantType: OAuthGrantType
  /** Resolved client_id (from the auth config's env-var secret). */
  clientId: string
  /** Resolved client_secret, if any (public clients omit it). */
  clientSecret?: string
  /** Space-separated scopes to request. */
  scope?: string
  /** RFC 8707 resource indicator to request. */
  resource?: string
  /** Authorization-server `audience` to request (some ASes use this). */
  audience?: string
  /** Initial refresh token for the `refresh_token` grant (from env). */
  initialRefreshToken?: string
  /** Client-auth method preference; defaults to basic/post/none selection. */
  clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | 'none'
  /**
   * The authorization server's `issuer` these credentials are registered with.
   * Stamped onto stored client information for issuer-binding. May be
   * omitted when the issuer is only known after discovery.
   */
  expectedIssuer?: string
  /** Keychain to persist to. Defaults to the OS keychain via BunKeychain. */
  keychain?: Keychain
}

// ---------------------------------------------------------------------------
// Key naming
// ---------------------------------------------------------------------------

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// The keychain names within the service — exported so the keychain-floor
// reader (the security faculty) derives the same keys as the writer (this
// provider) from one source.
export const tokensKey = (serverUrl: string): string => `${hostOf(serverUrl)}:tokens`
const clientInfoKey = (serverUrl: string): string => `${hostOf(serverUrl)}:clientinfo`
const discoveryKey = (serverUrl: string): string => `${hostOf(serverUrl)}:discovery`

/**
 * The issuer-binding rule, shared by the provider reads and the keychain
 * floor: a blob stamped for a different authorization server is not this
 * AS's credential — absent, never vended to the wrong server. An unstamped
 * (legacy) blob binds to whatever AS asks; no ctx issuer (the pre-discovery
 * read) accepts the most-recently-saved blob.
 */
export const issuerMatches = (stored: string | undefined, requested: string | undefined): boolean => {
  if (requested === undefined) return true
  if (stored === undefined) return true
  return stored === requested
}

// ---------------------------------------------------------------------------
// The keychain floor — credential vending's last leg
// ---------------------------------------------------------------------------

/**
 * The keychain floor of credential vending: read the token slot for a server
 * and vend its `access_token`, fail-closed. A missing slot, a corrupt blob,
 * an empty access token, or a blob bound to a different authorization server
 * (`issuer`, when the caller supplies one from its resolved discovery) is an
 * absent credential — never a throw.
 *
 * MINIMAL: token expiry is not detected (no `expires_in` bookkeeping, no
 * refresh) — an expired token vends until the remote server rejects it.
 * Upgrade path: expiry-aware reads + a refresh leg riding the provider's
 * grant hooks when the grant orchestrator lands.
 */
export const vendKeychainToken = async ({
  serverUrl,
  keychain,
  issuer,
}: {
  serverUrl: string
  keychain: Keychain
  /** The caller's resolved AS issuer — binds the read (undefined = most-recently-saved). */
  issuer?: string
}): Promise<string | undefined> => {
  try {
    const raw = await keychain.get(tokensKey(serverUrl))
    if (raw === null) return undefined
    const tokens = JSON.parse(raw) as { access_token?: unknown; issuer?: unknown }
    const accessToken =
      typeof tokens.access_token === 'string' && tokens.access_token !== '' ? tokens.access_token : undefined
    if (accessToken === undefined) return undefined
    const stamped = typeof tokens.issuer === 'string' && tokens.issuer !== '' ? tokens.issuer : undefined
    // Issuer-binding: a blob bound to another AS must not be vended — the
    // caller's resolved issuer is the only accepted binding.
    if (!issuerMatches(stamped, issuer)) return undefined
    return accessToken
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class BunKeychainOAuthProvider {
  readonly #serverUrl: string
  readonly #grantType: OAuthGrantType
  readonly #clientId: string
  readonly #clientSecret?: string
  readonly #scope?: string
  readonly #resource?: string
  readonly #audience?: string
  readonly #initialRefreshToken?: string
  readonly #clientAuthentication?: 'client_secret_basic' | 'client_secret_post' | 'none'
  readonly #expectedIssuer?: string
  readonly #keychain: Keychain
  // In-process cache so repeated tokens()/clientInformation() calls in one
  // process don't round-trip the keychain on every request.
  #cachedTokens?: StoredOAuthTokens
  #cachedClientInfo?: StoredOAuthClientInformation
  #cachedDiscovery?: OAuthDiscoveryState

  constructor(options: KeychainOAuthProviderOptions) {
    this.#serverUrl = options.serverUrl
    this.#grantType = options.grantType
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#scope = options.scope
    this.#resource = options.resource
    this.#audience = options.audience
    this.#initialRefreshToken = options.initialRefreshToken
    this.#clientAuthentication = options.clientAuthentication
    this.#expectedIssuer = options.expectedIssuer
    this.#keychain = options.keychain ?? BunKeychain()
  }

  // -- grant-flow basics ----------------------------------------------------

  get redirectUrl(): undefined {
    return undefined
  }

  get clientMetadata(): OAuthClientMetadata {
    const grant = this.#grantType
    const method = this.#resolvedAuthMethod()
    return {
      redirect_uris: [],
      grant_types: [grant],
      token_endpoint_auth_method: method === 'none' ? undefined : method,
      client_name: 'behavioral remote mcp',
      scope: this.#scope,
    }
  }

  // -- state / code verifier (interactive flow only; stubbed) -------------

  state(): string {
    return crypto.randomUUID()
  }

  redirectToAuthorization(): void {
    throw new Error('Interactive OAuth authorization not supported by BunKeychainOAuthProvider')
  }

  saveCodeVerifier(): void {
    // No-op: PKCE is for the interactive authorization-code flow, which this
    // non-interactive provider never enters.
  }

  codeVerifier(): string {
    return ''
  }

  // -- client information (issuer-keyed) ----------------------------------

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const cached = this.#cachedClientInfo ?? (await this.#loadClientInfo())
    // Issuer-binding: a persisted blob bound to a different AS is treated as
    // absent — the grant flow re-stamps from the resolved issuer (or falls
    // back to the statically-configured credentials below).
    if (cached && this.#issuerMatches(cached.issuer, ctx?.issuer)) {
      return cached
    }
    // No usable persisted info — return the statically-configured credentials
    // (unstamped); the grant flow stamps + saves them on first auth.
    if (this.#clientId) {
      return {
        client_id: this.#clientId,
        ...(this.#clientSecret ? { client_secret: this.#clientSecret } : {}),
        ...(this.#expectedIssuer ? { issuer: this.#expectedIssuer } : {}),
      }
    }
    return undefined
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    this.#cachedClientInfo = clientInformation
    await this.#keychain.set(clientInfoKey(this.#serverUrl), JSON.stringify(clientInformation))
  }

  // -- tokens (issuer-keyed; most-recently-saved when ctx undefined) ------

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const tokens = this.#cachedTokens ?? (await this.#loadTokens())
    // Issuer-binding: a blob stamped with a different AS is not this AS's
    // credential — absent, never vended to the wrong server.
    if (tokens === undefined || !this.#issuerMatches(tokens.issuer, ctx?.issuer)) return undefined
    this.#cachedTokens = tokens
    return tokens
  }

  async saveTokens(tokens: StoredOAuthTokens, _ctx?: OAuthClientInformationContext): Promise<void> {
    this.#cachedTokens = tokens
    await this.#keychain.set(tokensKey(this.#serverUrl), JSON.stringify(tokens))
  }

  // -- discovery state (keyed by server; pre-issuer) ----------------------

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.#cachedDiscovery) return this.#cachedDiscovery
    const raw = await this.#keychain.get(discoveryKey(this.#serverUrl))
    if (!raw) return undefined
    try {
      this.#cachedDiscovery = JSON.parse(raw) as OAuthDiscoveryState
      return this.#cachedDiscovery
    } catch {
      return undefined
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.#cachedDiscovery = state
    await this.#keychain.set(discoveryKey(this.#serverUrl), JSON.stringify(state))
  }

  // -- token request ------------------------------------------------------

  /**
   * Builds the grant-specific token-request body — the grant orchestrator
   * pairs this with {@link addClientAuthentication} for the exchange.
   */
  prepareTokenRequest(scope?: string): URLSearchParams {
    const params = new URLSearchParams()
    const effectiveScope = scope ?? this.#scope
    if (this.#grantType === 'refresh_token') {
      params.set('grant_type', 'refresh_token')
      const refreshToken = this.#currentRefreshToken()
      if (refreshToken) params.set('refresh_token', refreshToken)
    } else {
      params.set('grant_type', 'client_credentials')
    }
    if (effectiveScope) params.set('scope', effectiveScope)
    if (this.#audience) params.set('audience', this.#audience)
    if (this.#resource) params.set('resource', this.#resource)
    return params
  }

  /**
   * Adds client credentials to a token request per the configured method.
   * Mirrors {@link selectClientAuthMethod}'s default ordering when no method
   * is configured.
   */
  addClientAuthentication = (
    headers: Headers,
    params: URLSearchParams,
    _url?: string | URL,
    _metadata?: unknown,
  ): void => {
    const method = this.#resolvedAuthMethod()
    switch (method) {
      case 'client_secret_basic': {
        if (!this.#clientSecret) throw new Error('client_secret_basic requires a client secret')
        const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')
        headers.set('Authorization', `Basic ${basic}`)
        break
      }
      case 'client_secret_post':
        params.set('client_id', this.#clientId)
        if (this.#clientSecret) params.set('client_secret', this.#clientSecret)
        break
      case 'none':
        params.set('client_id', this.#clientId)
        break
    }
  }

  // -- RFC 8707 resource binding ------------------------------------------

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined
    let resourceUrl: URL
    try {
      resourceUrl = new URL(resource)
    } catch {
      return undefined
    }
    const server = new URL(serverUrl)
    // Origin binding: the resource indicator MUST be the MCP server itself
    // (RFC 8707 + MCP spec). A resource on a different origin is an issuer/
    // resource mismatch — reject rather than silently sending a token minted
    // for another server.
    if (resourceUrl.origin !== server.origin) {
      throw new IssuerMismatchError('authorization_response', server.origin, resourceUrl.origin)
    }
    return resourceUrl
  }

  // -- credential invalidation -------------------------------------------

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    switch (scope) {
      case 'tokens':
        this.#cachedTokens = undefined
        await this.#keychain.delete(tokensKey(this.#serverUrl))
        break
      case 'client':
        this.#cachedClientInfo = undefined
        await this.#keychain.delete(clientInfoKey(this.#serverUrl))
        break
      case 'discovery':
        this.#cachedDiscovery = undefined
        await this.#keychain.delete(discoveryKey(this.#serverUrl))
        break
      case 'verifier':
        // No PKCE state held — nothing to clear.
        break
      case 'all':
        this.#cachedTokens = undefined
        this.#cachedClientInfo = undefined
        this.#cachedDiscovery = undefined
        await Promise.all([
          this.#keychain.delete(tokensKey(this.#serverUrl)),
          this.#keychain.delete(clientInfoKey(this.#serverUrl)),
          this.#keychain.delete(discoveryKey(this.#serverUrl)),
        ])
        break
    }
  }

  // -- private helpers ----------------------------------------------------

  #resolvedAuthMethod(): 'client_secret_basic' | 'client_secret_post' | 'none' {
    if (this.#clientAuthentication) return this.#clientAuthentication
    // Default selection matches selectClientAuthMethod's priority.
    return selectClientAuthMethod(
      {
        client_id: this.#clientId,
        ...(this.#clientSecret ? { client_secret: this.#clientSecret } : {}),
      },
      ['client_secret_basic', 'client_secret_post', 'none'],
    )
  }

  #currentRefreshToken(): string | undefined {
    return this.#cachedTokens?.refresh_token ?? this.#initialRefreshToken
  }

  #issuerMatches(stored: string | undefined, requested: string | undefined): boolean {
    return issuerMatches(stored, requested)
  }

  async #loadTokens(): Promise<StoredOAuthTokens | undefined> {
    const raw = await this.#keychain.get(tokensKey(this.#serverUrl))
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as StoredOAuthTokens
    } catch {
      return undefined
    }
  }

  async #loadClientInfo(): Promise<StoredOAuthClientInformation | undefined> {
    const raw = await this.#keychain.get(clientInfoKey(this.#serverUrl))
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as StoredOAuthClientInformation
    } catch {
      return undefined
    }
  }
}

/**
 * OS-keychain abstraction for the security faculty's credential store.
 *
 * @remarks
 * `BunKeychain` wraps {@link Bun.secrets} (macOS Keychain / libsecret /
 * Windows Credential Manager) so OAuth refresh tokens and client information
 * persist across process restarts without a plaintext file under
 * `~/.behavioral/mcp/tokens/`. `InMemoryKeychain` is the test double — the only
 * keychain boundary that gets mocked, per the slice's testing contract.
 *
 * All values are JSON strings; the provider serializes `StoredOAuthTokens` /
 * `StoredOAuthClientInformation` / `OAuthDiscoveryState` blobs before storing.
 */

/** A name/value secret store keyed by `name` within a fixed `service`. */
export type Keychain = {
  /** Returns the stored value, or `null` if absent. */
  get(name: string): Promise<string | null>
  /** Stores (replacing) or, with an empty value, deletes the entry. */
  set(name: string, value: string): Promise<void>
  /** Deletes the entry; returns whether one was present. */
  delete(name: string): Promise<boolean>
}

/**
 * The fixed keychain service label — historical: named for the mcp faculty
 * the store originated in. Retained so previously-stored credentials remain
 * readable across the move.
 */
export const KEYCHAIN_SERVICE = 'behavioral.mcp'

/**
 * Default keychain backed by {@link Bun.secrets}.
 *
 * `Bun.secrets` is `{ service, name, value }`-keyed; an empty `value` deletes
 * the entry, mirroring `delete()`.
 */
export const BunKeychain = (service: string = KEYCHAIN_SERVICE): Keychain => ({
  get: (name) => Bun.secrets.get({ service, name }),
  set: (name, value) => Bun.secrets.set({ service, name, value }),
  delete: (name) => Bun.secrets.delete({ service, name }),
})

/**
 * In-memory keychain for tests — the only keychain boundary that is mocked.
 * Not for production: holds values in a `Map`, never touching the OS keychain.
 */
export const InMemoryKeychain = (): Keychain => {
  const store = new Map<string, string>()
  return {
    get: async (name) => store.get(name) ?? null,
    set: async (name, value) => {
      if (value === '') store.delete(name)
      else store.set(name, value)
    },
    delete: async (name) => store.delete(name),
  }
}
