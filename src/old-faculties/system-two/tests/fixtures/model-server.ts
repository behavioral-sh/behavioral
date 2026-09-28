/**
 * In-process Open Responses endpoint over loopback HTTP (Bun.serve), mirroring
 * the {@link ./mcp-server-fixture.ts} pattern: a real server behind real HTTP,
 * not fetch mocks. The only injected boundary for the tools under test is the
 * endpoint config (URL + key) via the `createModelTools` factory.
 *
 * Responses are built from the openresponses compliance-suite contract
 * (github.com/openresponses/openresponses — bin/compliance-test.ts +
 * src/lib/compliance-tests.ts), trimmed to the Phase-0 item subset the repo's
 * system-two/schemas.ts validates (no assistant `phase` labels, which the
 * strict MessageItemSchema rejects). A canned ResponseResource follows the
 * suite's `getMockResponse` shape minus the phase fields.
 *
 * Faculty contract:
 * - POST /responses, no `tools`, stream falsy → JSON ResponseResource
 *   (completed message item + usage).
 * - POST /responses with non-empty `tools` → JSON ResponseResource whose
 *   output is a single function_call item (the suite's tool-calling template).
 * - POST /responses with `stream: true` → SSE:
 *   output_item.added → output_text.delta ×2 → output_item.done →
 *   response.completed (usage) → data: [DONE].
 * - POST /responses whose input mentions {@link FAILURE_MARKER} → SSE:
 *   output_item.added → response.failed → data: [DONE].
 * - POST /responses with empty `input` → 400 structured error body.
 * - When `apiKey` is configured, requests must carry
 *   `Authorization: Bearer <apiKey>` or get a 401 structured error body.
 *
 * No /responses/compact route: the compaction client was removed — context
 * management is client-side (the 2026-09-21 worker-conversion ruling); no
 * test surface needs it.
 *
 * Every request (path, authorization header, parsed JSON body) is recorded in
 * `requests` for routing/auth assertions.
 */

export const FAILURE_MARKER = 'trigger-failure'

export const REASONING_TEXT = 'Let me think about this'
export const MOCK_RESPONSE_ID = 'resp_mock_001'
export const ASSISTANT_TEXT = 'Hello from mock'
export const FUNCTION_CALL = {
  id: 'fc_mock_001',
  type: 'function_call',
  status: 'completed',
  call_id: 'call_mock_001',
  name: 'get_weather',
  arguments: '{"location": "Paris"}',
} as const

export type RecordedRequest = {
  path: string
  auth: string | null
  body: unknown
}

export type OpenResponsesFixture = {
  /** Base URL — endpoint config for `createModelTools` (no /v1 suffix). */
  url: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

const mockUsage = {
  input_tokens: 12,
  output_tokens: 8,
  total_tokens: 20,
} as const

const assistantMessageItem = (text: string) => ({
  id: 'msg_mock_001',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
})

const reasoningItem = (text: string) => ({
  id: 'rs_mock_001',
  type: 'reasoning',
  status: 'completed',
  content: [{ type: 'reasoning_text', text }],
  summary: [],
  format: 'unknown',
})

const mockResponse = (model: string, output: unknown[]) => ({
  id: MOCK_RESPONSE_ID,
  object: 'response',
  created_at: 1734366691,
  status: 'completed',
  model,
  output,
  usage: mockUsage,
  error: null,
})

const sseResponse = (events: unknown[]): Response =>
  new Response(`${events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })

const jsonError = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

const json = (body: unknown): Response => Response.json(body)

/**
 * Start the loopback fixture. `apiKey` turns on bearer-auth enforcement for
 * every route.
 */
export const startOpenResponsesServer = async ({
  apiKey,
  withReasoning,
}: {
  apiKey?: string
  withReasoning?: boolean
} = {}): Promise<OpenResponsesFixture> => {
  const requests: RecordedRequest[] = []

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
      requests.push({ path: pathname, auth: req.headers.get('authorization'), body })

      if (apiKey && req.headers.get('authorization') !== `Bearer ${apiKey}`) {
        return jsonError(401, 'invalid_api_key', 'missing or invalid API key')
      }

      const typed = (body ?? {}) as {
        model?: string
        input?: unknown[]
        stream?: boolean
        tools?: unknown[]
      }
      const inputText = JSON.stringify(typed.input ?? [])

      if (pathname === '/responses' || pathname.endsWith('/responses')) {
        if (typeof typed.model !== 'string' || typed.model.length === 0) {
          return jsonError(400, 'invalid_request_error', 'model is required')
        }
        if (!Array.isArray(typed.input) || typed.input.length === 0) {
          return jsonError(400, 'invalid_request_error', 'input is required')
        }
        if (Array.isArray(typed.tools) && typed.tools.length > 0) {
          return json(mockResponse(typed.model, [FUNCTION_CALL]))
        }
        if (inputText.includes(FAILURE_MARKER)) {
          return sseResponse([
            {
              type: 'response.output_item.added',
              item: {
                id: 'msg_fail_mock',
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            },
            {
              type: 'response.failed',
              status: 'failed',
              error: { code: 'context_length_exceeded', message: 'Context window full' },
            },
          ])
        }
        if (typed.stream === true) {
          return sseResponse([
            {
              type: 'response.output_item.added',
              item: {
                id: 'msg_sse_001',
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            },
            {
              type: 'response.output_text.delta',
              item_id: 'msg_sse_001',
              output_index: 0,
              content_index: 0,
              delta: 'Hello',
            },
            {
              type: 'response.output_text.delta',
              item_id: 'msg_sse_001',
              output_index: 0,
              content_index: 0,
              delta: ' from mock',
            },
            {
              type: 'response.output_item.done',
              item: assistantMessageItem(ASSISTANT_TEXT),
            },
            {
              type: 'response.completed',
              status: 'completed',
              usage: mockUsage,
            },
          ])
        }
        const output = withReasoning
          ? [reasoningItem(REASONING_TEXT), assistantMessageItem(ASSISTANT_TEXT)]
          : [assistantMessageItem(ASSISTANT_TEXT)]
        return json(mockResponse(typed.model, output))
      }

      return new Response('not found', { status: 404 })
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    requests,
    close: async () => {
      server.stop(true)
    },
  }
}
