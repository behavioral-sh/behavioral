import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { spawnFaculty } from '../../tests/faculty-harness.ts'
import {
  AudioContentSchema,
  CompactionItemSchema,
  ErrorSchema,
  FunctionCallItemSchema,
  FunctionCallOutputItemSchema,
  ImageContentSchema,
  InputContentPartSchema,
  InputTextContentSchema,
  type KnownStreamEvent,
  KnownStreamEventSchema,
  MessageItemParamSchema,
  MessageItemSchema,
  OpenResponsesRequestSchema,
  type OpenResponsesStreamEvent,
  OutputTextContentSchema,
  ReasoningTextContentSchema,
  StreamEventLaxSchema,
  UsageSchema,
  VideoContentSchema,
  validateSystemTwoInput,
  validateSystemTwoOutput,
} from '../schemas.ts'
import { SYSTEM_TWO_ENDPOINTS_KEY, type SystemTwoEndpoints, type SystemTwoOutput } from '../types.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from './fixtures/model-server.ts'

// ================================================================
// responses worker — the event-wire surface
// ================================================================

type WireResult = {
  id: string
  ok: boolean
  result?: SystemTwoOutput
  error?: Record<string, unknown>
  ctx?: unknown
  space?: string
}

/** Spawn the responses faculty PROCESS and expose the same wire harness API. */
const spawnModelBehavior = (endpoints: SystemTwoEndpoints) => {
  // Endpoint config seeds the spawn ENV (the provisioning contract): the
  // process reads it once at startup and no secret ever crosses the message
  // boundary. Env vars cross Bun.spawn; worker-thread env-data does not.
  const faculty = spawnFaculty({
    file: 'system-two/faculty.ts',
    requestType: FACULTY_MESSAGE_KINDS.system_two_request,
    resultType: FACULTY_MESSAGE_KINDS.system_two_request_result,
    env: { [SYSTEM_TWO_ENDPOINTS_KEY]: JSON.stringify(endpoints) },
  })
  const messages: { type?: string; detail?: unknown; space?: string }[] = []
  const respond = (id: string, input: unknown, space?: string, ctx?: JsonObject): void => {
    faculty.call({ id, input, ...(ctx === undefined ? {} : { ctx }) } as JsonObject, space)
  }
  const cancel = (id: string): void => {
    faculty.post({ type: FACULTY_MESSAGE_KINDS.system_two_cancel, detail: { id } } as never)
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const raw = await faculty.resultFor(id)
    messages.push({ type: FACULTY_MESSAGE_KINDS.system_two_request_result, detail: raw.detail, space: raw.space })
    return { ...raw.detail, id: raw.id, space: raw.space } as WireResult
  }
  return { respond, cancel, resultFor, messages, terminate: (): void => faculty.terminate() }
}

const userMessage = { type: 'message', role: 'user', content: 'Say hello' } as const

describe('model faculty — the ctx join lane', () => {
  test('request ctx echoes on the result — the thread join lane', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      model.respond('call_1', { provider: 'mock', modelId: 'mock-model', input: [userMessage] }, undefined, {
        echo: { leg: 'generation' },
        scale: 's3',
        target: 'body',
      })
      const { ok, ctx } = await model.resultFor('call_1')
      expect(ok).toBe(true)
      expect(ctx).toEqual({ echo: { leg: 'generation' }, scale: 's3', target: 'body' })
    } finally {
      model.terminate()
      await server.close()
    }
  })

  test('request ctx echoes on the error branch too', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      // No endpoint for the provider — the typed error result
      model.respond('call_2', { provider: 'missing', modelId: 'm', input: [userMessage] }, undefined, {
        echo: { leg: 'generation' },
      })
      const { ok, ctx } = await model.resultFor('call_2')
      expect(ok).toBe(false)
      expect(ctx).toEqual({ echo: { leg: 'generation' } })
    } finally {
      model.terminate()
      await server.close()
    }
  })
})

describe('model faculty — non-streaming respond', () => {
  test('round-trips a JSON ResponseResource as a result event', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      model.respond('call_1', {
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'Say hello' }],
      })
      const { id, result } = await model.resultFor('call_1')
      const success = result as {
        items: Array<{ type: string; content?: Array<{ text?: string }> }>
        status: string
        usage?: { total_tokens: number }
        isError?: boolean
      }
      expect(id).toBe('call_1')
      expect(success.isError).toBeUndefined()
      expect(success.status).toBe('completed')
      expect(success.items).toHaveLength(1)
      expect(success.items[0]?.content?.[0]?.text).toBe(ASSISTANT_TEXT)
      expect(success.usage).toMatchObject({ total_tokens: 20 })
    } finally {
      model.terminate()
      await server.close()
    }
  })
})

describe('model faculty — streaming respond', () => {
  test('streams are assembled internally; the only message is the terminal result event', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      model.respond('call_1', {
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'Count from 1 to 5.' }],
        stream: true,
      })
      const { result } = await model.resultFor('call_1')
      const success = result as {
        items: Array<{ type: string; content?: Array<{ text?: string }> }>
        status: string
        events?: Array<{ type: string; delta?: string }>
        isError?: boolean
      }
      expect(success.isError).toBeUndefined()
      expect(success.status).toBe('completed')
      // The terminal result still carries the buffered event list.
      expect(success.events?.map((e) => e.type)).toEqual([
        'response.output_item.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_item.done',
        'response.completed',
      ])
      const text = success.items[0]?.content?.[0]?.text
      expect(text).toBe(ASSISTANT_TEXT)
      // The DELTA wire kind is dead: nothing but the result event is posted.
      expect(model.messages).toHaveLength(1)
      expect(model.messages[0]?.type).toBe(FACULTY_MESSAGE_KINDS.system_two_request_result)
    } finally {
      model.terminate()
      await server.close()
    }
  })
})

describe('model faculty — endpoint config via environment data', () => {
  test('the provisioned apiKey reaches the wire as a bearer header', async () => {
    const server = await startOpenResponsesServer({ apiKey: 'secret-token' })
    const model = spawnModelBehavior({ mock: { url: server.url, apiKey: 'secret-token' } })
    try {
      model.respond('call_1', {
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      })
      const { result } = await model.resultFor('call_1')
      expect((result as { isError?: boolean }).isError).toBeUndefined()
      expect(server.requests[0]?.auth).toBe('Bearer secret-token')
    } finally {
      model.terminate()
      await server.close()
    }
  })

  test('an unknown provider is error data, never a throw', async () => {
    const model = spawnModelBehavior({})
    try {
      model.respond('call_1', {
        provider: 'nope',
        modelId: 'm',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      })
      const { ok, error } = await model.resultFor('call_1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('unknown provider')
    } finally {
      model.terminate()
    }
  })
})

describe('model faculty — failures are data', () => {
  test('a non-2xx response is error data carrying the structured message', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      model.respond('call_1', { provider: 'mock', modelId: 'mock-model', input: [] })
      const { ok, error } = await model.resultFor('call_1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('HTTP 400')
    } finally {
      model.terminate()
      await server.close()
    }
  })
})

describe('model faculty — cancellation', () => {
  test('a system_two_cancel event aborts an in-flight streamed call as error data', async () => {
    const encoder = new TextEncoder()
    // A real server that emits one event and then never closes the stream.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.output_item.added","item":{"id":"msg_c","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
                ),
              )
              // Never close — the call stays in flight until canceled.
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })

    const model = spawnModelBehavior({ mock: { url: `http://localhost:${server.port}` } })
    try {
      model.respond('call_1', {
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        stream: true,
      })
      await Bun.sleep(150)
      model.cancel('call_1')
      const { ok, error } = await model.resultFor('call_1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('canceled')
    } finally {
      model.terminate()
      server.stop(true)
    }
  })
})

describe('model faculty — event wire', () => {
  test('a request space is echoed on the result event', async () => {
    const model = spawnModelBehavior({})
    try {
      model.respond('call_1', { provider: 'nope', modelId: 'm', input: [] }, 's1')
      const { space } = await model.resultFor('call_1')
      expect(space).toBe('s1')
    } finally {
      model.terminate()
    }
  })

  test('a request without space returns a result without space', async () => {
    const model = spawnModelBehavior({})
    try {
      model.respond('call_1', { provider: 'nope', modelId: 'm', input: [] })
      const { space } = await model.resultFor('call_1')
      expect(space).toBeUndefined()
    } finally {
      model.terminate()
    }
  })

  test('input that fails the boundary schema is error data', async () => {
    const model = spawnModelBehavior({})
    try {
      model.respond('call_1', { modelId: 'm', input: [] })
      const { ok, error } = await model.resultFor('call_1')
      expect(ok).toBe(false)
      expect(String(error?.message)).toContain('invalid input')
    } finally {
      model.terminate()
    }
  })

  test('an event failing the shared event schema is dropped — no result', async () => {
    const model = spawnModelBehavior({})
    try {
      // No id: fails the trust boundary, nothing to correlate a result to.
      model.respond('', { provider: 'nope', modelId: 'm', input: [] })
      model.respond('call_2', { provider: 'nope', modelId: 'm', input: [] })
      const { id } = await model.resultFor('call_2')
      expect(id).toBe('call_2')
      expect(model.messages).toHaveLength(1)
    } finally {
      model.terminate()
    }
  })
})

// ================================================================
// system-two.schemas — request, item, usage, error schemas + stream events
// ================================================================

// --- Scenario 1: happy text turn ---
const happyEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'msg_1',
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'Hello',
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: ' world',
  },
  {
    type: 'response.output_item.done',
    item: {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello world' }],
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
  },
]

// --- Scenario 2: function call with argument deltas ---
const functionCallEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'fc_1',
      type: 'function_call',
      status: 'in_progress',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: '{"location":',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: ' "Paris"}',
  },
  {
    type: 'response.output_item.done',
    item: {
      id: 'fc_1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"location": "Paris"}',
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
  },
]

// --- Scenario 3: failed response ---
const failedEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'msg_fail',
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
]

// --- Scenario 4: compaction item + usage ---
const compactionEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'cmp_1',
      type: 'compaction',
      status: 'completed',
      encrypted_content: 'encrypted:base64data',
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
    usage: {
      input_tokens: 4500,
      output_tokens: 200,
      total_tokens: 4700,
    },
  },
]

// --- Scenario 5: unknown event passthrough ---
const unknownEventEvents: OpenResponsesStreamEvent[] = [
  {
    type: 'response.vendor_extra',
    some_field: 'passes through unvalidated',
  },
  {
    type: 'response.output_item.added',
    item: {
      id: 'msg_2',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
  },
]

// ================================================================
// Tests
// ================================================================

describe('schema validation — request', () => {
  test('valid request parses successfully', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: 'claude-sonnet-4',
      input: [{ type: 'message', role: 'user', content: 'Hello' }],
    })
    expect(result.model).toBe('claude-sonnet-4')
    expect(result.input).toHaveLength(1)
  })

  test('valid request with function_call input parses', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: 'claude-sonnet-4',
      input: [
        {
          type: 'function_call',
          call_id: 'call_xyz',
          name: 'get_weather',
          arguments: '{"location":"London"}',
        },
      ],
    })
    expect(result.input[0]!.type).toBe('function_call')
  })

  test('valid request with function_call_output input parses', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: 'claude-sonnet-4',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_xyz',
          output: '{"temperature":72}',
        },
      ],
    })
    expect(result.input[0]!.type).toBe('function_call_output')
  })

  test('malformed item (missing required field) is hard-rejected', () => {
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: 'm',
        input: [
          { type: 'message', role: 'assistant' }, // missing content
        ],
      }),
    ).toThrow()
  })

  test('unknown item type is hard-rejected', () => {
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: 'm',
        input: [{ type: 'computer_call', id: 'cc_1' }],
      }),
    ).toThrow()
  })

  test('tools with name, description, parameters parse', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })
    expect(result.tools).toHaveLength(1)
  })

  test('tool missing parameters is hard-rejected', () => {
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: 'm',
        input: [{ type: 'message', role: 'user', content: 'Hi' }],
        tools: [{ name: 'read_file', description: 'Read a file from disk' }],
      }),
    ).toThrow()
  })

  test('truncation and instructions parse', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: 'm',
      input: [{ type: 'message', role: 'system', content: 'You are helpful' }],
      truncation: 'disabled',
      instructions: 'Be concise',
    })
    expect(result.truncation).toBe('disabled')
    expect(result.instructions).toBe('Be concise')
  })

  test('spec reasoning param parses; effort is constrained to the spec enum', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: 'Hi' }],
      reasoning: { effort: 'xhigh' },
    })
    expect(result.reasoning?.effort).toBe('xhigh')
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: 'm',
        input: [{ type: 'message', role: 'user', content: 'Hi' }],
        reasoning: { effort: 'ultra' },
      }),
    ).toThrow()
  })
})

describe('content part schemas', () => {
  test('output_text parses', () => {
    const result = OutputTextContentSchema.parse({
      type: 'output_text',
      text: 'Hello world',
    })
    expect(result.text).toBe('Hello world')
  })

  test('reasoning_text parses', () => {
    const result = ReasoningTextContentSchema.parse({
      type: 'reasoning_text',
      text: 'Model is reasoning step by step',
    })
    expect(result.text).toContain('reasoning')
  })
})

describe('item schemas', () => {
  test('message item round-trips', () => {
    const item = {
      id: 'msg_1',
      type: 'message' as const,
      status: 'completed' as const,
      role: 'assistant' as const,
      content: [{ type: 'output_text' as const, text: 'Hi' }],
    }
    const result = MessageItemSchema.parse(item)
    expect(result.id).toBe('msg_1')
    expect(result.role).toBe('assistant')
  })

  test('function_call item parses with assembled arguments', () => {
    const item = {
      id: 'fc_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"location": "Paris"}',
    }
    const result = FunctionCallItemSchema.parse(item)
    expect(result.arguments).toBe('{"location": "Paris"}')
    expect(result.call_id).toBe('call_abc')
  })

  test('function_call_output parses', () => {
    const item = {
      id: 'fco_1',
      type: 'function_call_output' as const,
      status: 'completed' as const,
      call_id: 'call_abc',
      output: '{"temperature": 72}',
    }
    const result = FunctionCallOutputItemSchema.parse(item)
    expect(result.output).toBe('{"temperature": 72}')
  })

  test('compaction item round-trips', () => {
    const item = {
      id: 'cmp_1',
      type: 'compaction' as const,
      status: 'completed' as const,
      encrypted_content: 'encrypted:abc123',
    }
    const result = CompactionItemSchema.parse(item)
    expect(result.encrypted_content).toBe('encrypted:abc123')
  })
})

describe('usage schema', () => {
  test('parses full usage with details', () => {
    const result = UsageSchema.parse({
      input_tokens: 4500,
      output_tokens: 200,
      total_tokens: 4700,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens_details: { reasoning_tokens: 50 },
    })
    expect(result.total_tokens).toBe(4700)
    expect(result.input_tokens_details?.cached_tokens).toBe(1000)
    expect(result.output_tokens_details?.reasoning_tokens).toBe(50)
  })

  test('parses minimal usage without details', () => {
    const result = UsageSchema.parse({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    })
    expect(result.total_tokens).toBe(150)
  })
})

describe('error schema', () => {
  test('error parses with code and message', () => {
    const result = ErrorSchema.parse({
      code: 'context_length_exceeded',
      message: 'Context window full',
    })
    expect(result.code).toBe('context_length_exceeded')
  })
})

describe('stream event scenarios', () => {
  test('happy path: item added → text deltas → item done → completed', () => {
    for (const ev of happyEvents) {
      const result = StreamEventLaxSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }
  })

  test('function_call arguments deltas assemble correctly', () => {
    // Validate each event in the scenario
    for (const ev of functionCallEvents) {
      const result = KnownStreamEventSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }

    // Simulate assembling deltas from the stream
    let assembled = ''
    for (const ev of functionCallEvents) {
      if (ev.type === 'response.function_call_arguments.delta') {
        assembled += ev.delta
      }
    }
    // The last item carries the full arguments
    let fullArgs = ''
    for (const ev of functionCallEvents) {
      if (ev.type === 'response.output_item.done' && ev.item.type === 'function_call') {
        fullArgs = ev.item.arguments
      }
    }
    expect(assembled).toBe(fullArgs)
    expect(JSON.parse(fullArgs)).toEqual({ location: 'Paris' })
  })

  test('failed response consumed without thrown error', () => {
    const collected: KnownStreamEvent[] = []
    for (const ev of failedEvents) {
      const parsed = KnownStreamEventSchema.parse(ev)
      collected.push(parsed)
    }
    const terminal = collected[collected.length - 1]
    expect(terminal).toBeDefined()
    expect(terminal!.type).toBe('response.failed')
    if (terminal!.type === 'response.failed') {
      expect(terminal!.error.code).toBe('context_length_exceeded')
    }
  })

  test('unknown event type passes through without failing', () => {
    for (const ev of unknownEventEvents) {
      const result = StreamEventLaxSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }
    // Verify the unknown event has its passthrough field
    const unknown = unknownEventEvents[0]!
    const parsed = StreamEventLaxSchema.parse(unknown)
    expect(parsed.type).toBe('response.vendor_extra')
    // It should have passed through 'some_field'
    expect(parsed).toHaveProperty('some_field')
  })

  test('malformed known frame throws instead of passing through', () => {
    // A response.output_text.delta missing its required `delta` field is a
    // corrupted known frame — it must fail validation, not masquerade as an
    // unknown provider extra.
    const malformed = { type: 'response.output_text.delta', item_id: 'msg_1' }
    expect(() => StreamEventLaxSchema.parse(malformed)).toThrow()
  })

  test('compaction item round-trips through schema', () => {
    for (const ev of compactionEvents) {
      const result = KnownStreamEventSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }
  })

  test('terminal event with usage parses token counts intact', () => {
    const ev = compactionEvents[1]!
    const parsed = KnownStreamEventSchema.parse(ev)
    expect(parsed.type).toBe('response.completed')
    if (parsed.type === 'response.completed') {
      expect(parsed.usage?.input_tokens).toBe(4500)
      expect(parsed.usage?.output_tokens).toBe(200)
      expect(parsed.usage?.total_tokens).toBe(4700)
    }
  })
})

// ================================================================
// system-two.schemas — input content part schemas
// ================================================================

// ================================================================
// Input content parts — schema validation
// ================================================================

describe('InputTextContentSchema', () => {
  test('accepts simple text', () => {
    const result = InputTextContentSchema.parse({ type: 'input_text', text: 'Hello world' })
    expect(result.type).toBe('input_text')
    expect(result.text).toBe('Hello world')
  })

  test('rejects missing text', () => {
    expect(() => InputTextContentSchema.parse({ type: 'input_text' })).toThrow()
  })

  test('rejects wrong type', () => {
    expect(() => InputTextContentSchema.parse({ type: 'image', text: 'nope' })).toThrow()
  })
})

describe('ImageContentSchema', () => {
  test('accepts a data: URI', () => {
    const result = ImageContentSchema.parse({
      type: 'image',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    })
    expect(result.type).toBe('image')
    expect(result.image_url.url).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  test('accepts a regular URL', () => {
    const result = ImageContentSchema.parse({
      type: 'image',
      image_url: { url: 'https://example.com/photo.jpg' },
    })
    expect(result.image_url.url).toBe('https://example.com/photo.jpg')
  })

  test('accepts optional detail', () => {
    const result = ImageContentSchema.parse({
      type: 'image',
      image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' },
    })
    expect(result.image_url.detail).toBe('high')
  })

  test('rejects missing url', () => {
    expect(() => ImageContentSchema.parse({ type: 'image', image_url: {} })).toThrow()
  })

  test('rejects missing image_url entirely', () => {
    expect(() => ImageContentSchema.parse({ type: 'image' })).toThrow()
  })

  test('rejects invalid detail value', () => {
    expect(() =>
      ImageContentSchema.parse({
        type: 'image',
        image_url: { url: 'data:image/png;base64,AAAA', detail: 'ultra' },
      }),
    ).toThrow()
  })
})

describe('AudioContentSchema', () => {
  test('accepts base64 data with format', () => {
    const result = AudioContentSchema.parse({
      type: 'audio',
      data: '//uQxAAAAA...',
      format: 'mp3',
    })
    expect(result.type).toBe('audio')
    expect(result.data).toBe('//uQxAAAAA...')
    expect(result.format).toBe('mp3')
  })

  test('accepts data without optional format', () => {
    const result = AudioContentSchema.parse({
      type: 'audio',
      data: 'data:audio/mpeg;base64,AAAA',
    })
    expect(result.data).toBe('data:audio/mpeg;base64,AAAA')
    expect(result.format).toBeUndefined()
  })

  test('rejects missing data', () => {
    expect(() => AudioContentSchema.parse({ type: 'audio', format: 'wav' })).toThrow()
  })

  test('rejects invalid format value', () => {
    expect(() => AudioContentSchema.parse({ type: 'audio', data: 'AAAA', format: 'mp4' })).toThrow()
  })

  test('accepts all valid audio formats', () => {
    for (const format of ['mp3', 'wav', 'ogg', 'flac', 'aac'] as const) {
      const result = AudioContentSchema.parse({ type: 'audio', data: 'AAAA', format })
      expect(result.format).toBe(format)
    }
  })
})

describe('VideoContentSchema', () => {
  test('accepts base64 data with format', () => {
    const result = VideoContentSchema.parse({
      type: 'video',
      data: 'AAAA',
      format: 'mp4',
    })
    expect(result.type).toBe('video')
    expect(result.data).toBe('AAAA')
    expect(result.format).toBe('mp4')
  })

  test('accepts data without optional format', () => {
    const result = VideoContentSchema.parse({
      type: 'video',
      data: 'data:video/mp4;base64,AAAA',
    })
    expect(result.format).toBeUndefined()
  })

  test('rejects missing data', () => {
    expect(() => VideoContentSchema.parse({ type: 'video', format: 'webm' })).toThrow()
  })

  test('rejects invalid format value', () => {
    expect(() => VideoContentSchema.parse({ type: 'video', data: 'AAAA', format: 'mp3' })).toThrow()
  })

  test('accepts all valid video formats', () => {
    for (const format of ['mp4', 'webm', 'avi', 'mov', 'quicktime'] as const) {
      const result = VideoContentSchema.parse({ type: 'video', data: 'AAAA', format })
      expect(result.format).toBe(format)
    }
  })
})

describe('InputContentPartSchema (discriminated union)', () => {
  test('narrows to input_text', () => {
    const result = InputContentPartSchema.parse({ type: 'input_text', text: 'hi' })
    // TypeScript narrowing check: result.text should be accessible
    expect(result.type).toBe('input_text')
    if (result.type === 'input_text') {
      expect(result.text).toBe('hi')
    }
  })

  test('narrows to image', () => {
    const result = InputContentPartSchema.parse({
      type: 'image',
      image_url: { url: 'data:image/png;base64,AAAA' },
    })
    expect(result.type).toBe('image')
    if (result.type === 'image') {
      expect(result.image_url.url).toBe('data:image/png;base64,AAAA')
    }
  })

  test('narrows to audio', () => {
    const result = InputContentPartSchema.parse({ type: 'audio', data: 'AAAA', format: 'ogg' })
    expect(result.type).toBe('audio')
    if (result.type === 'audio') {
      expect(result.data).toBe('AAAA')
      expect(result.format).toBe('ogg')
    }
  })

  test('narrows to video', () => {
    const result = InputContentPartSchema.parse({ type: 'video', data: 'AAAA', format: 'mp4' })
    expect(result.type).toBe('video')
    if (result.type === 'video') {
      expect(result.data).toBe('AAAA')
    }
  })

  test('rejects unknown type', () => {
    expect(() => InputContentPartSchema.parse({ type: 'output_text', text: 'hello' })).toThrow()
    expect(() => InputContentPartSchema.parse({ type: 'reasoning_text', text: 'thinking' })).toThrow()
  })
})

describe('MessageItemParamSchema with InputContentPart[]', () => {
  test('accepts content as string', () => {
    const result = MessageItemParamSchema.parse({
      type: 'message',
      role: 'user',
      content: 'Hello',
    })
    expect(result.content).toBe('Hello')
  })

  test('accepts content as array of input content parts', () => {
    const parsed = MessageItemParamSchema.parse({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is this?' },
        { type: 'image', image_url: { url: 'data:image/png;base64,iVBOR' } },
        { type: 'audio', data: 'AAAA', format: 'wav' },
      ],
    })
    expect(Array.isArray(parsed.content)).toBe(true)
    const content = parsed.content as Array<unknown>
    expect(content).toHaveLength(3)
    const first = content[0] as { type: string }
    expect(first.type).toBe('input_text')
  })

  test('accepts a single image content part in array', () => {
    const result = MessageItemParamSchema.parse({
      type: 'message',
      role: 'user',
      content: [{ type: 'image', image_url: { url: 'data:image/png;base64,AAAA' } }],
    })
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content).toHaveLength(1)
  })

  test('rejects array with mixed output-side content parts', () => {
    expect(() =>
      MessageItemParamSchema.parse({
        type: 'message',
        role: 'user',
        content: [{ type: 'output_text', text: 'hello' }],
      }),
    ).toThrow()
  })
})

// ================================================================
// Event-input boundary — schema contract + passthrough over the wire
// ================================================================

describe('respond input schema — contract', () => {
  test('respond requires provider, modelId, and input', () => {
    expect(validateSystemTwoInput({})).toBe(false)
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm' })).toBe(false)
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm', input: [] })).toBe(true)
  })

  test('reasoningEffort declares the spec enum and passes non-spec values through', () => {
    // Spec values accepted.
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'high' })).toBe(true)
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'xhigh' })).toBe(true)
    // Non-spec values (OpenAI-only minimal, endpoint extensions) pass through.
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'minimal' })).toBe(true)
    // Structure is still guarded: empty and non-string values rejected.
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: '' })).toBe(false)
    expect(validateSystemTwoInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 3 })).toBe(false)
  })
})

describe('model faculty — passthrough to the wire', () => {
  test('extras are inert body data and never reconfigure the endpoint', async () => {
    const server = await startOpenResponsesServer({ apiKey: 'real-key' })
    const model = spawnModelBehavior({ mock: { url: server.url, apiKey: 'real-key' } })
    try {
      model.respond('call_1', {
        provider: 'mock',
        modelId: 'mock-model',
        input: [userMessage],
        apiKey: 'inert-body-value',
        url: 'http://evil.example',
      })
      const { result } = await model.resultFor('call_1')
      // The call still went to the provisioned endpoint with the provisioned
      // key — args never reconfigure the connection.
      expect((result as { isError?: boolean }).isError).toBeUndefined()
      expect(server.requests[0]?.path).toBe('/responses')
      expect(server.requests[0]?.auth).toBe('Bearer real-key')
      // Extra keys pass through as plain body data, nothing more.
      const body = server.requests[0]?.body as Record<string, unknown>
      expect(body.apiKey).toBe('inert-body-value')
      expect(body.url).toBe('http://evil.example')
    } finally {
      model.terminate()
      await server.close()
    }
  })

  test('extra key-values pass through validation and reach the wire verbatim', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      model.respond('call_1', {
        provider: 'mock',
        modelId: 'mock-model',
        input: [userMessage],
        prompt_cache_key: 'cache-1',
        temperature: 0.2,
        // OpenAI-only effort flows through as the raw spec param object.
        reasoning: { effort: 'minimal' },
      })
      const { result } = await model.resultFor('call_1')
      expect((result as { isError?: boolean }).isError).toBeUndefined()
      const body = server.requests[0]?.body as Record<string, unknown>
      expect(body.prompt_cache_key).toBe('cache-1')
      expect(body.temperature).toBe(0.2)
      expect(body.reasoning).toEqual({ effort: 'minimal' })
    } finally {
      model.terminate()
      await server.close()
    }
  })
})

describe('model faculty — output conformance', () => {
  test('the terminal result satisfies the output schema', async () => {
    const server = await startOpenResponsesServer()
    const model = spawnModelBehavior({ mock: { url: server.url } })
    try {
      model.respond('call_1', { provider: 'mock', modelId: 'mock-model', input: [userMessage] })
      const { result } = await model.resultFor('call_1')
      expect(validateSystemTwoOutput(result)).toBe(true)
      expect((result as { isError?: boolean }).isError).toBeUndefined()
      expect((result as { items: Array<{ content?: Array<{ text?: string }> }> }).items[0]?.content?.[0]?.text).toBe(
        ASSISTANT_TEXT,
      )
    } finally {
      model.terminate()
      await server.close()
    }
  })
})
