/**
 * The generic HTTP JSON-RPC 2.0 client — a `fetch`-based envelope carrier
 * used by the shell faculty's `rpc` op.
 *
 * @remarks
 * Protocol-agnostic by construction: the client knows nothing about MCP,
 * `_meta`, protocol versions, or tool semantics — it carries the JSON-RPC
 * envelope (`{ jsonrpc: "2.0", id, method, params }`) over one stateless
 * HTTP POST per call. The MCP layering (request stamping, `server/discover`,
 * `tools/call`, MRTR) lives in the remote-mcp threads, not here.
 *
 * Auth is a seam, not a capability: the client does not know about OAuth —
 * it asks the injectable `getAuthToken` for a token and rides it as a
 * bearer header when one is vended. (The credential seam's other end is the
 * security faculty; wiring is the composition's, not this module's.)
 *
 * Errors-as-data (the op-runners law): HTTP non-OK, JSON-RPC error payloads,
 * malformed responses, and network failures all return
 * `{ ok: false, error: { code, message } }` — no throw crosses a
 * transport/protocol failure. Only a caller-side programming error (an
 * unserializable envelope) throws, and it never reaches this client.
 *
 * `fetch` is injectable for tests; the default is the platform global.
 *
 * @packageDocumentation
 */

import type { JsonObject } from '../../behavioral/behavioral.types.ts'

/** The outcome of one RPC call — the modified-B envelope, errors-as-data. */
export type RpcResult<T = JsonObject> =
  | { ok: true; result: T }
  | { ok: false; error: { code: number | string; message: string } }

/** A token vendor — the auth seam's client-side end. `undefined` = no token. */
export type GetAuthToken = () => Promise<string | undefined>

export type SendInput = {
  url: string
  method: string
  params?: JsonObject
  /** JSON-RPC correlation id. Defaults to a fresh UUID — stateless calls need one to match responses. */
  id?: string | number
  /** Optional bearer-token vendor, consulted per call. */
  getAuthToken?: GetAuthToken
  /** Caller-supplied headers (transport stamps; the vended bearer always rides last). */
  headers?: Record<string, string>
  /** Injectable transport. Defaults to the platform `fetch`. */
  fetch?: typeof fetch
  /** Abort signal for the in-flight POST — cancellation rides the transport. */
  signal?: AbortSignal
}

/** Build the JSON-RPC 2.0 request envelope for one call. */
const envelope = ({ method, params, id }: { method: string; params?: JsonObject; id: string | number }) =>
  ({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }) as JsonObject

/** Decode one HTTP response body as a JSON-RPC 2.0 outcome. */
const decodeBody = async ({ response, id }: { response: Response; id: string | number }): Promise<RpcResult> => {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, error: { code: 'invalid_response', message: 'response body is not JSON' } }
  }
  const body = parsed as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
  if (typeof body === 'object' && body !== null && body.jsonrpc === '2.0' && (body.id === id || body.id === null)) {
    if (body.error !== undefined && typeof body.error === 'object' && body.error !== null) {
      const err = body.error as { code?: unknown; message?: unknown }
      return {
        ok: false,
        error: {
          code: typeof err.code === 'number' || typeof err.code === 'string' ? err.code : 'invalid_response',
          message: typeof err.message === 'string' ? err.message : 'JSON-RPC error (no message)',
        },
      }
    }
    return { ok: true, result: (body.result ?? {}) as JsonObject }
  }
  return { ok: false, error: { code: 'invalid_response', message: 'response is not a JSON-RPC 2.0 response' } }
}

/**
 * Send one JSON-RPC 2.0 request over a single stateless HTTP POST.
 *
 * @returns the result branch on success; error data on HTTP failure, JSON-RPC
 * error payloads, malformed responses, and network failures — never a throw.
 */
export const send = async ({
  url,
  method,
  params,
  id = crypto.randomUUID(),
  getAuthToken,
  headers,
  fetch: fetchImpl = fetch,
  signal,
}: SendInput): Promise<RpcResult> => {
  const token = getAuthToken === undefined ? undefined : await getAuthToken().catch(() => undefined)
  const base: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  // Caller stamps ride the base; the vended bearer rides last (it always wins).
  const requestHeaders: Record<string, string> = { ...base, ...(headers ?? {}) }
  if (token !== undefined) requestHeaders.authorization = `Bearer ${token}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(envelope({ method, params, id })),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (err) {
    return {
      ok: false,
      error: { code: 'network', message: err instanceof Error ? err.message : String(err) },
    }
  }
  if (!response.ok) {
    return { ok: false, error: { code: response.status, message: `HTTP ${response.status} ${response.statusText}` } }
  }
  return decodeBody({ response, id })
}
