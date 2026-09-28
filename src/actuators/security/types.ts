/**
 * Types shared by the security faculty process (`security/faculty.ts`) and
 * its event-wire consumers.
 *
 * @remarks
 * The plain OAuth type set — the SDK-free equivalents of the shapes the
 * former `@modelcontextprotocol/client` dependency defined, kept to what the
 * security faculty's credential path touches (the issuer-stamping storage
 * pattern, the client-auth method selection inputs, and the persisted
 * discovery blob). Types are structural, not schema-derived: these values
 * live inside JSON keychain blobs and JS objects, never on the wire raw.
 *
 * The wire itself is the behavioral event vocabulary (`credential_request` /
 * `credential_cancel` in, one `credential_result` out) defined in
 * `src/faculties/faculties.types.ts` — only the `detail.input` payload shape
 * and the env-data keys live here.
 *
 * Also the one home for the broker env-data keys (the Pattern-2 binding the
 * vend checks before the keychain floor); the mcp faculty re-exports them
 * until its deprecation.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject } from '../../behavioral/behavioral.types.ts'

// ---------------------------------------------------------------------------
// Env-data — the vend's broker binding (the injection law one level down)
// ---------------------------------------------------------------------------

/** Env-data key holding the taskbar broker's base URL (the Pattern-2 binding). */
export const MCP_BROKER_URL_KEY = 'MCP_BROKER_URL'

/** Env-data key holding the per-boot broker secret (never tool input). */
export const MCP_BROKER_BOOT_SECRET_KEY = 'MCP_BROKER_BOOT_SECRET'

// ---------------------------------------------------------------------------
// Plain OAuth types — the SDK-free storage/flow contract
// ---------------------------------------------------------------------------

/** RFC 6749 §5.1 token response (the fields the grant flows consume). */
export type OAuthTokens = {
  access_token: string
  id_token?: string
  token_type: string
  /** Seconds until expiry, as sent by the AS (coerced-number semantics). */
  expires_in?: number
  scope?: string
  refresh_token?: string
}

/**
 * {@linkcode OAuthTokens} as persisted — with the SDK-stamped
 * authorization-server `issuer` so stored tokens are bound to the AS that
 * issued them. The `issuer` is NOT part of the RFC 6749 wire response; the
 * grant flow stamps it before `saveTokens` (SEP-2352 issuer-binding).
 */
export type StoredOAuthTokens = OAuthTokens & { issuer?: string }

/** RFC 6749 §2.2 client identity — client identifiers are unique per AS. */
export type OAuthClientInformation = {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
}

/**
 * {@linkcode OAuthClientInformation} as persisted — the same issuer-stamp
 * pattern as {@linkcode StoredOAuthTokens}.
 *
 * MINIMAL: RFC 7591 DCR responses carrying the full registration metadata
 * (redirect_uris, grant_types, …) survive storage verbatim as JSON blobs but
 * are typed narrow here — no in-repo consumer reads those fields yet.
 * Upgrade path: a full `OAuthClientInformationFull` variant when one does.
 */
export type StoredOAuthClientInformation = OAuthClientInformation & { issuer?: string }

/** The client metadata a grant flow presents to the AS (RFC 7591 subset). */
export type OAuthClientMetadata = {
  redirect_uris: string[]
  token_endpoint_auth_method?: string
  grant_types?: string[]
  response_types?: string[]
  application_type?: string
  client_name?: string
  scope?: string
}

/**
 * Context passed to the issuer-keyed credential reads/writes — carries the
 * resolved authorization-server `issuer` (from its validated metadata) as
 * the binding key. Omitted on the pre-discovery per-request read, which
 * returns the most-recently-saved blob.
 */
export type OAuthClientInformationContext = { issuer: string }

/** A persisted authorization-server selection — blob-read, never re-derived. */
export type OAuthDiscoveryState = {
  authorizationServerUrl: string
  resourceMetadataUrl?: string
  resourceMetadata?: JsonObject
  authorizationServerMetadata?: JsonObject
}

/** Client-auth methods a token request can ride. */
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none'

// ---------------------------------------------------------------------------
// The credential op input boundary — the trust boundary for anything
// crossing into the security faculty process; strict.
// ---------------------------------------------------------------------------

/** The `credential_request` event's `detail.input` — vend a token for a server. */
export type CredentialRequestInput = {
  /** The remote server URL the credential is for — keys the keychain slots. */
  serverUrl: string
}

export const CredentialRequestInputSchema: JSONSchemaType<CredentialRequestInput> = {
  type: 'object',
  properties: {
    serverUrl: { type: 'string', minLength: 1, description: 'the remote server URL the credential is for' },
  },
  required: ['serverUrl'],
  additionalProperties: false,
}

export const validateCredentialRequestInput = ajv.compile(CredentialRequestInputSchema)

/**
 * The `credential_request` event's optional `detail.ctx` — the host-supplied
 * override lane (the you.com MCP pattern: host-only parameters ride out-of-band
 * beside `input`, never as model-facing arguments). Carries the issuer-binding
 * context the credential read is keyed by.
 */
export type SecurityRequestContext = {
  /** The resolved authorization-server `issuer` — binds the keychain read. */
  issuer?: string
  /**
   * The caller's out-of-band join payload (e.g. the original request for the
   * replaying thread) — echoed verbatim on the vended `credential_result`.
   * Never model-facing; never interpreted by this faculty.
   */
  echo?: JsonObject
}

export const SecurityRequestContextSchema: JSONSchemaType<SecurityRequestContext> = {
  type: 'object',
  properties: {
    issuer: {
      type: 'string',
      minLength: 1,
      nullable: true,
      description: 'the resolved authorization-server issuer binding',
    },
    echo: { type: 'object', required: [], additionalProperties: true, nullable: true },
  },
  required: [],
  additionalProperties: false,
}

export const validateSecurityRequestContext = ajv.compile(SecurityRequestContextSchema)
