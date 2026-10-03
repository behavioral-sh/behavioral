import { describe, expect, test } from 'bun:test'
import type { Keychain } from '../../actuators/keychain-oauth-provider.ts'
import { InMemoryKeychain } from '../../actuators/keychain-oauth-provider.ts'
import { saveProviderToken } from '../../actuators/provider-keys.ts'
import {
  PROVIDER_TOKEN,
  type ProviderFixture,
  RATE_LIMIT_MARKER,
  RETRY_AFTER_SECONDS,
  STREAM_MARKER,
  startInferenceProvider,
} from './fixtures/inference-provider.ts'

/**
 * The inference proxy spec — REAL HTTP round-trips: the proxy handler is
 * served on loopback `Bun.serve`, the provider is the loopback fixture, the
 * custody floor is the in-memory keychain (the actuator tests' fake `Bun.secrets`
 * pattern). No fetch mocks anywhere on the path.
 */

/** The test harness: a real server mounting the proxy + the provider fixture. */
const harness = async ({
  providers,
  session,
}: {
  providers: Record<string, string>
  session: string
}): Promise<{ proxyUrl: string; provider: ProviderFixture; keychain: Keychain; close: () => Promise<void> }> => {
  const provider = await startInferenceProvider({ token: PROVIDER_TOKEN })
  const origins = Object.fromEntries(
    Object.entries(providers).map(([id, path]) => [id, path === '@provider' ? provider.url : path]),
  )
  const keychain = InMemoryKeychain()
  const { createInferenceProxy } = await import('../serve.ts')
  const { validSession } = await import('../session.ts')
  const proxy = createInferenceProxy({
    providers: origins,
    session: (req) => validSession(req, session),
    keychain,
  })
  const server = Bun.serve({ port: 0, fetch: (req) => proxy(req) })
  return {
    proxyUrl: `http://localhost:${server.port}`,
    provider,
    keychain,
    close: async () => {
      server.stop(true)
      await provider.close()
    },
  }
}

const seedCredential = async (
  h: Awaited<ReturnType<typeof harness>>,
  provider: string,
  token: string,
): Promise<void> => {
  // Custody writes the origin-stamped blob — the same floor the proxy vends
  // through (issuer-bound to the provider's allow-listed origin).
  await saveProviderToken({ provider, origin: new URL(h.provider.url).origin, token, keychain: h.keychain })
}

const post = (proxyUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('the inference proxy', () => {
  test('a sessioned request forwards the body unmodified with the keychain credential attached, and the response surfaces verbatim', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'typesafe', PROVIDER_TOKEN)
      const body = { model: 'm', input: [{ type: 'message', role: 'user', content: 'hi' }] }
      const res = await post(h.proxyUrl, '/v1/inference/typesafe/responses', body, {
        cookie: 'behavioral_session=sess-1',
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { status: string; output: unknown[] }
      expect(json.status).toBe('completed')

      // The provider saw exactly the proxied request: our credential, the
      // unmodified body, the passthrough content-type.
      expect(h.provider.requests).toHaveLength(1)
      const seen = h.provider.requests[0]!
      expect(seen.path).toBe('/responses')
      expect(seen.auth).toBe(`Bearer ${PROVIDER_TOKEN}`)
      expect(seen.contentType).toBe('application/json')
      expect(seen.body).toEqual(body)
    } finally {
      await h.close()
    }
  })

  test('a bearer presentation authenticates too — one session, two presentations', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'typesafe', PROVIDER_TOKEN)
      const res = await post(
        h.proxyUrl,
        '/v1/inference/typesafe/responses',
        { model: 'm', input: [{}] },
        {
          authorization: 'Bearer sess-1',
        },
      )
      expect(res.status).toBe(200)
      expect(h.provider.requests).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  test('no session → 401 and the provider is never reached — the credential is never attached on the failure path', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'typesafe', PROVIDER_TOKEN)
      const res = await post(h.proxyUrl, '/v1/inference/typesafe/responses', { model: 'm', input: [{}] })
      expect(res.status).toBe(401)
      expect(h.provider.requests).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test('an invalid session → 401 and the provider is never reached', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'typesafe', PROVIDER_TOKEN)
      const res = await post(
        h.proxyUrl,
        '/v1/inference/typesafe/responses',
        { model: 'm', input: [{}] },
        {
          cookie: 'behavioral_session=sess-2',
        },
      )
      expect(res.status).toBe(401)
      expect(h.provider.requests).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test('an unknown provider → 404', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      const res = await post(
        h.proxyUrl,
        '/v1/inference/openrouter/responses',
        { model: 'm', input: [{}] },
        {
          cookie: 'behavioral_session=sess-1',
        },
      )
      expect(res.status).toBe(404)
    } finally {
      await h.close()
    }
  })

  test('a provider whose configured origin is not http(s) → 403 — never forwarded', async () => {
    const h = await harness({ providers: { intranet: 'file:///etc' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'intranet', PROVIDER_TOKEN)
      const res = await post(
        h.proxyUrl,
        '/v1/inference/intranet/responses',
        { model: 'm', input: [{}] },
        {
          cookie: 'behavioral_session=sess-1',
        },
      )
      expect(res.status).toBe(403)
    } finally {
      await h.close()
    }
  })

  test('a provider with no custody entry → 502 — the body is never sent', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      const res = await post(
        h.proxyUrl,
        '/v1/inference/typesafe/responses',
        { model: 'm', input: [{}] },
        {
          cookie: 'behavioral_session=sess-1',
        },
      )
      expect(res.status).toBe(502)
      expect(h.provider.requests).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test('a 429 from the provider surfaces retry-after verbatim — un-normalized for the worker retry logic', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'typesafe', PROVIDER_TOKEN)
      const res = await post(
        h.proxyUrl,
        '/v1/inference/typesafe/responses',
        { model: 'm', input: [{ type: 'message', role: 'user', content: RATE_LIMIT_MARKER }] },
        { cookie: 'behavioral_session=sess-1' },
      )
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBe(RETRY_AFTER_SECONDS)
    } finally {
      await h.close()
    }
  })

  test('an SSE body streams through chunk-by-chunk — the provider never closes, the client reads while it emits', async () => {
    const h = await harness({ providers: { typesafe: '@provider' }, session: 'sess-1' })
    try {
      await seedCredential(h, 'typesafe', PROVIDER_TOKEN)
      const res = await post(
        h.proxyUrl,
        '/v1/inference/typesafe/responses',
        { model: 'm', input: [{ type: 'message', role: 'user', content: STREAM_MARKER }] },
        { cookie: 'behavioral_session=sess-1' },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      // The first frame lands while the provider is STILL emitting — a
      // buffered proxy would hang here instead.
      const reader = res.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(new TextDecoder().decode(first.value!)).toContain('data: ')
      // The stream is live end-to-end: the provider keeps pushing frames the
      // client has not read yet (nothing buffered the whole body).
      await Bun.sleep(50)
      expect(h.provider.streamFrames()).toBeGreaterThan(1)
      await reader.cancel()
    } finally {
      await h.close()
    }
  })
})
