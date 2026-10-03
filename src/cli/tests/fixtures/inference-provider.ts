/**
 * Loopback provider fixture for the inference-proxy spec — mirrors
 * `src/faculties/tests/fixtures/model-server.ts` (a real HTTP server behind
 * real round-trips, no fetch mocks). Speaks the Open Responses shape and adds
 * the branches the proxy contract needs:
 *
 * - POST /responses, plain input → JSON ResponseResource (completed message).
 * - Input mentioning {@link RATE_LIMIT_MARKER} → 429 with `retry-after: 7`
 *   (the verbatim-surface case: the proxy must not normalize it).
 * - Input mentioning {@link STREAM_MARKER} → `text/event-stream` that emits
 *   one SSE frame every tick and NEVER closes (the streaming-through case:
 *   the client reads chunks while the provider holds the connection open).
 * - Any bearer other than {@link token} → 401 structured error (auth
 *   enforcement: only the proxy's attached credential passes).
 *
 * Every request (path, authorization header, content-type, body) is recorded
 * in `requests` for proxy assertions — including the zero-requests case that
 * proves the failure path never reaches the provider.
 */

import { FAILURE_MARKER } from '../../../faculties/tests/fixtures/model-server.ts'

export const RATE_LIMIT_MARKER = 'trigger-rate-limit'
export const STREAM_MARKER = 'trigger-stream'
export const PROVIDER_TOKEN = 'sk-provider-fixture-key'
export const RETRY_AFTER_SECONDS = '7'

export type RecordedRequest = {
  path: string
  auth: string | null
  contentType: string | null
  body: unknown
}

export type ProviderFixture = {
  url: string
  requests: RecordedRequest[]
  /** SSE frames emitted so far on the never-closing stream. */
  streamFrames: () => number
  close: () => Promise<void>
}

const assistantMessageItem = (text: string) => ({
  id: 'msg_provider_001',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
})

const jsonError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

/**
 * Start the loopback provider. `token` turns on bearer-auth enforcement
 * (the proxy's attached credential must match).
 */
export const startInferenceProvider = async ({ token }: { token?: string } = {}): Promise<ProviderFixture> => {
  const requests: RecordedRequest[] = []
  let frames = 0
  let streamInterval: ReturnType<typeof setInterval> | undefined

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { pathname } = new URL(req.url)
      let body: unknown = null
      try {
        body = await req.json()
      } catch {
        body = null
      }
      requests.push({
        path: pathname,
        auth: req.headers.get('authorization'),
        contentType: req.headers.get('content-type'),
        body,
      })

      if (token !== undefined && req.headers.get('authorization') !== `Bearer ${token}`) {
        return jsonError(401, 'invalid_api_key', 'missing or invalid API key')
      }

      if (pathname !== '/responses' && !pathname.endsWith('/responses')) {
        return new Response('not found', { status: 404 })
      }
      if (req.method !== 'POST') return jsonError(405, 'method_not_allowed', 'POST only')

      const inputText = JSON.stringify(body ?? {})
      if (inputText.includes(FAILURE_MARKER)) {
        return jsonError(500, 'provider_error', 'provider exploded')
      }
      if (inputText.includes(RATE_LIMIT_MARKER)) {
        return new Response(JSON.stringify({ error: { code: 'rate_limit', message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': RETRY_AFTER_SECONDS },
        })
      }
      if (inputText.includes(STREAM_MARKER)) {
        // A stream that never closes: one SSE frame per tick, forever — the
        // client (the spec) cancels. If the proxy buffered the body, the
        // client's first read would hang instead of landing while the
        // provider is still emitting.
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            let n = 0
            frames = 0
            streamInterval = setInterval(() => {
              frames += 1
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `tick ${n++}` })}\n\n`,
                ),
              )
            }, 10)
          },
          cancel: () => {
            if (streamInterval !== undefined) clearInterval(streamInterval)
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json({
        id: 'resp_provider_001',
        object: 'response',
        status: 'completed',
        model: 'mock-model',
        output: [assistantMessageItem('Hello from provider')],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        error: null,
      })
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    requests,
    streamFrames: () => frames,
    close: async () => {
      if (streamInterval !== undefined) clearInterval(streamInterval)
      server.stop(true)
    },
  }
}
