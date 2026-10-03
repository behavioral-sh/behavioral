/**
 * The provider-credential keychain naming — R2's "the route name and the
 * keychain entry are THE SAME identifier": the inference proxy's provider id
 * IS the keychain slot name, derived through this one map. The proxy route
 * for `<provider>` can only ever reach this provider's entry.
 *
 * @remarks
 * Static vendor keys live as issuer-stamped token blobs under the security
 * actuator's keychain service (the same `BunKeychain` the OAuth grant flows
 * persist into); the daemon's serving side resolves them through
 * {@link vendProviderToken} — the key never crosses into a browser context.
 *
 * @packageDocumentation
 */

import { issuerMatches, type Keychain } from './keychain-oauth-provider.ts'

/** The keychain name for one provider's credential slot. */
export const providerTokenKey = (provider: string): string => `provider:${provider}:token`

/**
 * Persist one provider's credential as an origin-stamped blob — the write
 * leg of the custody floor (also the rotation leg: re-saving replaces). The
 * stamp binds the credential to the provider's allow-listed origin: a vend
 * for a different origin is refused (the issuer-binding rule the OAuth
 * floor applies, applied to static keys).
 */
export const saveProviderToken = async ({
  provider,
  origin,
  token,
  keychain,
}: {
  provider: string
  /** The allow-listed origin the credential is bound to. */
  origin: string
  token: string
  keychain: Keychain
}): Promise<void> => {
  await keychain.set(providerTokenKey(provider), JSON.stringify({ access_token: token, issuer: origin }))
}

/**
 * The custody floor's read leg — resolve one provider's credential by
 * provider id, fail-closed: a missing slot, a corrupt blob, an empty token,
 * or a blob bound to a different origin is an absent credential — never a
 * throw. The proxy's vend path resolves through this function.
 */
export const vendProviderToken = async ({
  provider,
  origin,
  keychain,
}: {
  provider: string
  /** The caller's resolved origin — binds the read. */
  origin: string
  keychain: Keychain
}): Promise<string | undefined> => {
  try {
    const raw = await keychain.get(providerTokenKey(provider))
    if (raw === null) return undefined
    const blob = JSON.parse(raw) as { access_token?: unknown; issuer?: unknown }
    const accessToken =
      typeof blob.access_token === 'string' && blob.access_token !== '' ? blob.access_token : undefined
    if (accessToken === undefined) return undefined
    const stamped = typeof blob.issuer === 'string' && blob.issuer !== '' ? blob.issuer : undefined
    if (!issuerMatches(stamped, origin)) return undefined
    return accessToken
  } catch {
    return undefined
  }
}
