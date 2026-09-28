/**
 * Security faculty — the cross-cutting credential/policy faculty: vends one
 * credential per `credential_request` event and returns a single terminal
 * `credential_result` event.
 *
 * @remarks
 * Spawned by URL (never imported) and speaks the behavioral event wire:
 * `credential_request` / `credential_cancel` in, `credential_result` out,
 * with any request `space` echoed on the result. `detail.input` is validated
 * against the credential boundary (`security/types.ts`); per-call credentials
 * never ride the wire — auth binds at this module's scope from env-data.
 *
 * The vend (fail-closed, errors-as-data — no throw crosses the wire):
 * - broker env-data (`MCP_BROKER_URL` + `MCP_BROKER_BOOT_SECRET`, seeded by
 *   the spawning composition root) → the broker's `request_access_token`
 *   endpoint. MINIMAL: the broker slice has not landed; its request contract
 *   is thin (POST + boot-secret bearer) and fail-closed on any failure. Pin
 *   it when the broker exists.
 * - No broker (or a down one) → the keychain floor: {@link vendKeychainToken}
 *   reads the issuer-stamped token blob the provider's grant flows persist —
 *   the reconnect-per-turn posture (credentials persist in the keyring, the
 *   connection does not).
 * - Neither yields a token → the result is error data (`code: 'error'`,
 *   message naming the server) — the consumer decides what an absent
 *   credential means for its call.
 *
 * `credential_cancel` stops an in-flight vend: the stop is recorded (first
 * writer wins) and the settling vend reports `code: 'canceled'` instead of
 * its outcome. `credential_result` is the lane's only inbound kind — the
 * pump re-enters results only; requests/cancels stay outbound-only.
 *
 * The supervisory policy threads (token-readiness blocks, secret masking)
 * are a follow-up slice — this skeleton vends credentials, nothing more.
 *
 * @packageDocumentation
 */

import type { ValidateFunction } from 'ajv'
import { ajv, type JsonObject } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import {
  type SecurityCancelEvent,
  type SecurityRequestEvent,
  validateSecurityCancelEvent,
  validateSecurityRequestEvent,
} from '../faculties/faculties.types.ts'
import { emit, envData, wireInbound } from '../faculties/process-lane.ts'
import {
  MCP_BROKER_BOOT_SECRET_KEY,
  MCP_BROKER_URL_KEY,
  validateCredentialRequestInput,
  validateSecurityRequestContext,
} from '../faculties/security/types.ts'
import { BunKeychain, vendKeychainToken } from './keychain-oauth-provider.ts'

// ---------------------------------------------------------------------------
// Auth binding — module scope, from boundary-legal data only
// ---------------------------------------------------------------------------

const brokerUrl = envData(MCP_BROKER_URL_KEY) as string | undefined
const brokerBootSecret = envData(MCP_BROKER_BOOT_SECRET_KEY) as string | undefined
const keychain = BunKeychain()

/** Fetch an access token from the taskbar broker (env-data binding). Fail-closed. */
const brokerToken = async (): Promise<string | undefined> => {
  if (typeof brokerUrl !== 'string' || typeof brokerBootSecret !== 'string') return undefined
  try {
    const response = await fetch(new URL('request_access_token', brokerUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${brokerBootSecret}` },
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { token?: string }
    return typeof data.token === 'string' && data.token !== '' ? data.token : undefined
  } catch {
    // A down broker must not break the floor — fall through to the keychain.
    return undefined
  }
}

/** The per-server vend: broker first, keychain floor second, absent last. */
const vendCredential = async (serverUrl: string, issuer?: string): Promise<string | undefined> =>
  (await brokerToken()) ??
  (await vendKeychainToken({ serverUrl, keychain, ...(issuer === undefined ? {} : { issuer }) }))

// ---------------------------------------------------------------------------
// In-flight vends — enough state to stop one by correlation id
// ---------------------------------------------------------------------------

type Vend = {
  /** First stop wins, so a late cancel cannot relabel a settled vend. */
  stopReason: 'canceled' | null
}

/** Vends in flight, keyed by correlation id. */
const active = new Map<string, Vend>()

/** Record the stop. First writer wins. */
const stopVend = ({ vend }: { vend: Vend }): void => {
  if (vend.stopReason !== null) return
  vend.stopReason = 'canceled'
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/** Post the single terminal result event (the uniform modified-B envelope). */
const postResult = ({
  id,
  token,
  echo,
  error,
  space,
  ctx,
}: {
  id: string
  token?: string
  /** The ctx echo — the caller's out-of-band join payload, round-tripped verbatim. */
  echo?: JsonObject
  error?: { code: string; message?: string }
  space?: string
  ctx?: JsonObject
}): void => {
  emit({
    type: FACULTY_MESSAGE_KINDS.credential_result,
    // The request's ctx echoes on BOTH branches — the caller's join lane
    // round-trips through failures too (the absent-credential surfacing).
    detail: (error === undefined
      ? {
          id,
          ok: true,
          result: { token, ...(echo === undefined ? {} : { echo }) },
          ...(ctx === undefined ? {} : { ctx }),
        }
      : {
          id,
          ok: false,
          error: error as JsonObject,
          ...(ctx === undefined ? {} : { ctx }),
        }) as unknown as JsonObject & {
      id: string
    },
    ...(space === undefined ? {} : { space }),
  })
}

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

/** Route one inbound event. */
const handleInbound = async (message: unknown): Promise<void> => {
  if (validateSecurityCancelEvent(message)) {
    // Cast: the TS7/ajv compiler defect means the type guard does not narrow.
    const cancel = message as SecurityCancelEvent
    const vend = active.get(cancel.detail.id)
    if (vend !== undefined) stopVend({ vend })
    return
  }
  // Events failing the shared schema have no correlation id to report to and
  // are dropped — the router only forwards schema-valid events, so this is
  // defense in depth at the process boundary.
  if (!validateSecurityRequestEvent(message)) return
  const event = message as SecurityRequestEvent
  const { id, input, ctx } = event.detail

  // Input that fails the boundary is error data, not a throw: the id is
  // valid, so the caller learns why nothing was vended.
  const validate = validateCredentialRequestInput as unknown as ValidateFunction<unknown>
  if (!validate(input)) {
    postResult({
      id,
      space: event.space,
      error: { code: 'error', message: `invalid input: ${ajv.errorsText(validate.errors)}` },
      ctx,
    })
    return
  }
  // The host-supplied binding lane — its own strict boundary, same
  // error-data rule (the strict shape is this faculty's, not the wire's).
  let issuer: string | undefined
  if (ctx !== undefined) {
    const validateContext = validateSecurityRequestContext as unknown as ValidateFunction<unknown>
    if (!validateContext(ctx)) {
      postResult({
        id,
        space: event.space,
        error: { code: 'error', message: `invalid input: ${ajv.errorsText(validateContext.errors)}` },
        ctx,
      })
      return
    }
    issuer = (ctx as { issuer?: string }).issuer
  }
  // The out-of-band echo rides ctx verbatim — the orchestrating thread's
  // join payload (the you.com MCP `_meta` pattern: host-supplied data
  // round-trips beside the model-facing arguments).
  const echo = (ctx as { echo?: JsonObject } | undefined)?.echo
  const { serverUrl } = input as { serverUrl: string }

  const vend: Vend = { stopReason: null }
  active.set(id, vend)
  try {
    const token = await vendCredential(serverUrl, issuer)
    // A stop wins over the outcome: the (possibly already-vended) credential
    // is discarded and the caller learns the request was canceled.
    if (vend.stopReason === 'canceled') {
      postResult({ id, space: event.space, error: { code: 'canceled' } })
      return
    }
    if (token === undefined) {
      postResult({
        id,
        space: event.space,
        error: { code: 'error', message: `no credential available for ${serverUrl}` },
        ctx,
      })
      return
    }
    postResult({ id, space: event.space, token, echo, ctx })
  } catch (err) {
    // The vend is fail-closed by construction; this is the last-resort guard
    // so no worker-side throw ever escapes as a crash.
    postResult({
      id,
      space: event.space,
      error: { code: 'error', message: err instanceof Error ? err.message : String(err) },
      ctx,
    })
  } finally {
    active.delete(id)
  }
}

// The wire is the behavioral event vocabulary, validated with the shared
// schemas — the trust boundary for anything crossing into this process.
if (import.meta.main) {
  // Standalone (spawned process) — wire the stdio line lane. An in-process
  // import (the composition's frontier embed) wires nothing: the host's
  // stdin is never touched.
  wireInbound((message) => handleInbound(message))
}
