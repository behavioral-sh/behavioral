/**
 * The provider-credential keychain naming — R2's "the route name and the
 * keychain entry are THE SAME identifier": the inference proxy's provider id
 * IS the keychain slot name, derived through this one map. The proxy route
 * for `<provider>` can only ever reach this provider's entry.
 *
 * @remarks
 * Static vendor keys live under the security actuator's keychain service
 * (the same `BunKeychain` the OAuth grant flows persist into); the daemon's
 * serving side resolves them daemon-side — the key never crosses into a
 * browser context. MINIMAL: this file carries the shared naming only; the
 * issuer-bound custody legs (save/vend, cross-provider isolation) are the
 * custody slice.
 *
 * @packageDocumentation
 */

/** The keychain name for one provider's credential slot. */
export const providerTokenKey = (provider: string): string => `provider:${provider}:token`
