/**
 * The bundled System Two provider — the DEFAULT Open Responses implementation.
 *
 * @remarks
 * This file is a provider ENTRY: it defines `openResponsesRespond` (one
 * `/responses` call per input) and hands it to `configSystemTwo`, which wires
 * the process (inbound lane, result envelope, cancel/timeout). A third party
 * writes their own entry the same way with a different `respond`; the wire
 * contract does not change.
 *
 * `detail.input` is validated against `validateSystemTwoInput` inside
 * `configSystemTwo`; stream events are assembled internally and never posted —
 * no consumer exists (MINIMAL: router-published delta trace when one does).
 *
 * Endpoint config (URLs + resolved API keys + extra headers) is delivered via
 * environment data before the process is spawned and read once by
 * `configSystemTwo` — secrets never enter a request message or the
 * model-facing schema.
 *
 * MINIMAL: no request-level concurrency cap — the host/threads decide how many
 * calls to have in flight. Upgrade path: an executor-side queue if a runaway
 * fan-out ever needs bounding.
 *
 * @packageDocumentation
 */

import { configSystemTwo, type SystemTwoRespond } from './config.ts'
import {
  ErrorSchema,
  type KnownStreamEvent,
  KnownStreamEventSchema,
  makeSchema,
  type Error as OpenResponsesError,
  type OpenResponsesStreamEvent,
  type OutputItem,
  OutputItemSchema,
  StreamEventLaxSchema,
  type Usage,
  UsageSchema,
} from './schemas.ts'
import type { SystemTwoEndpointConfig, SystemTwoInput, SystemTwoOutput } from './types.ts'

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

const joinUrl = (base: string, path: string): string => `${base.replace(/\/$/, '')}${path}`

const buildHeaders = (endpoint: SystemTwoEndpointConfig): Record<string, string> => ({
  'content-type': 'application/json',
  ...(endpoint.apiKey !== undefined && { authorization: `Bearer ${endpoint.apiKey}` }),
  ...endpoint.headers,
})

/** Structured error body ({ error: { code, message } }) on a non-2xx response. */
const describeHttpError = async (res: Response): Promise<string> => {
  let detail = ''
  try {
    const raw = await res.text()
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } }
    if (parsed.error && typeof parsed.error === 'object') {
      const { code, message } = parsed.error
      detail = `${typeof code === 'string' ? code : 'unknown_error'}: ${typeof message === 'string' ? message : raw}`
    } else {
      detail = raw
    }
  } catch {
    detail = ''
  }
  return `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`
}

/** Tool-input fields with named wire mappings — everything else passes through. */
const NAMED_INPUT_KEYS = new Set([
  'provider',
  'modelId',
  'input',
  'tools',
  'instructions',
  'truncation',
  'stream',
  'reasoningEffort',
])

const buildRespondBody = (input: SystemTwoInput): Record<string, unknown> => {
  const body: Record<string, unknown> = { model: input.modelId, input: input.input }
  // Passthrough: spec params we do not name + endpoint extensions cross the
  // wire verbatim. Named mappings are assigned after, so they win collisions.
  for (const [key, value] of Object.entries(input)) {
    if (NAMED_INPUT_KEYS.has(key) || value === undefined) continue
    body[key] = value
  }
  if (input.tools !== undefined) body.tools = input.tools
  if (input.instructions !== undefined) body.instructions = input.instructions
  if (input.truncation !== undefined) body.truncation = input.truncation
  if (input.stream === true) body.stream = true
  if (input.reasoningEffort !== undefined) body.reasoning = { effort: input.reasoningEffort }
  return body
}

// ---------------------------------------------------------------------------
// Response schemas (lax envelopes — the strict content lives in the item union)
// ---------------------------------------------------------------------------

const usageJsonSchema = UsageSchema.schema
const errorJsonSchema = ErrorSchema.schema
const outputItemJsonSchema = OutputItemSchema.schema

type ResponseResource = {
  id: string
  object: string
  status: string
  output: OutputItem[]
  usage?: Usage
  error?: OpenResponsesError | null
}

const responseResourceSchema = makeSchema<ResponseResource>({
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    status: { type: 'string' },
    model: { type: 'string' },
    output: { type: 'array', items: outputItemJsonSchema },
    usage: { ...usageJsonSchema, additionalProperties: true, nullable: true },
    error: { ...errorJsonSchema, additionalProperties: true, nullable: true },
  },
  required: ['id', 'object', 'status', 'output'],
  additionalProperties: true,
})

// ---------------------------------------------------------------------------
// SSE streaming — parse frames incrementally and assemble the terminal result
// ---------------------------------------------------------------------------

type StreamOutcome =
  | { events: OpenResponsesStreamEvent[]; knownEvents: KnownStreamEvent[] }
  | { isError: true; message: string }

/** Parse the body of a `text/event-stream` response, invoking `onEvent` per frame. */
const streamEvents = async (
  body: ReadableStream<Uint8Array>,
  onEvent: (event: OpenResponsesStreamEvent) => void,
): Promise<StreamOutcome> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: OpenResponsesStreamEvent[] = []
  const knownEvents: KnownStreamEvent[] = []

  const consumeFrame = (frame: string): StreamOutcome | 'continue' | 'done' => {
    // MINIMAL: only the FIRST data: line of a frame is taken — the SSE spec
    // allows multi-line data fields (concatenated). Our providers emit
    // one-line data frames; upgrade path: join all data: lines if a
    // multi-line-data provider ever appears.
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (line === undefined) return 'continue'
    const payload = line.slice('data: '.length).trim()
    if (payload.length === 0) return 'continue'
    if (payload === '[DONE]') return 'done'
    let data: unknown
    try {
      data = JSON.parse(payload)
    } catch {
      return { isError: true, message: `malformed SSE frame: ${payload.slice(0, 120)}` }
    }
    // Strict known-event validation first (full discrimination for assembly);
    // unknown provider extras fall through to the lax passthrough schema.
    const known = KnownStreamEventSchema.safeParse(data)
    if (known.success) {
      events.push(known.data)
      knownEvents.push(known.data)
      onEvent(known.data)
      return 'continue'
    }
    const lax = StreamEventLaxSchema.safeParse(data)
    if (!lax.success) {
      return { isError: true, message: `invalid stream event: ${lax.error.message}` }
    }
    events.push(lax.data)
    onEvent(lax.data)
    return 'continue'
  }

  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx = buffer.indexOf('\n\n')
    while (idx !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const outcome = consumeFrame(frame)
      if (outcome === 'done') return { events, knownEvents }
      if (outcome !== 'continue') return outcome
      idx = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim().length > 0) {
    const outcome = consumeFrame(buffer)
    if (outcome !== 'continue' && outcome !== 'done') return outcome
  }
  return { events, knownEvents }
}

/** Assemble items/status/usage/error from the terminal stream events. */
const assembleResponse = (events: OpenResponsesStreamEvent[], knownEvents: KnownStreamEvent[]): SystemTwoOutput => {
  const items: OutputItem[] = []
  let status = 'completed'
  let usage: Usage | undefined
  let error: OpenResponsesError | undefined
  for (const ev of knownEvents) {
    if (ev.type === 'response.output_item.done') {
      items.push(ev.item)
    } else if (ev.type === 'response.completed') {
      status = 'completed'
      usage = ev.usage
    } else if (ev.type === 'response.failed') {
      status = 'failed'
      error = ev.error
      usage = ev.usage
    } else if (ev.type === 'response.incomplete') {
      status = 'incomplete'
      usage = ev.usage
    }
  }
  return {
    events,
    items,
    status,
    ...(usage !== undefined && { usage }),
    ...(error !== undefined && { error }),
  }
}

// ---------------------------------------------------------------------------
// The provider: one Open Responses call per input
// ---------------------------------------------------------------------------

const openResponsesRespond: SystemTwoRespond = async (input, { endpoints, signal }) => {
  const endpoint = endpoints[input.provider]
  if (!endpoint) return { isError: true, message: `[Error: unknown provider "${input.provider}"]` }
  try {
    const res = await fetch(joinUrl(endpoint.url, '/responses'), {
      method: 'POST',
      headers: buildHeaders(endpoint),
      body: JSON.stringify(buildRespondBody(input)),
      signal,
    })
    if (!res.ok) return { isError: true, message: await describeHttpError(res) }
    if (input.stream === true && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Stream events are assembled into the terminal result; nothing is
      // posted mid-stream (no consumer — see the header MINIMAL note).
      const outcome = await streamEvents(res.body as ReadableStream<Uint8Array>, () => {})
      if ('isError' in outcome) return outcome
      return assembleResponse(outcome.events, outcome.knownEvents)
    }
    const parsed = responseResourceSchema.safeParse(await res.json())
    if (!parsed.success) return { isError: true, message: 'invalid response resource from endpoint' }
    return {
      items: parsed.data.output,
      status: parsed.data.status,
      ...(parsed.data.usage !== undefined && { usage: parsed.data.usage }),
      ...(parsed.data.error != null && { error: parsed.data.error }),
    }
  } catch (error) {
    // An abort (timeout/cancel) propagates so configSystemTwo maps the stop
    // reason to its message; any other throw is transport/parse error data.
    if (signal.aborted) throw error
    return { isError: true, message: error instanceof Error ? error.message : String(error) }
  }
}

// The process entry: wire only when spawned (an in-process import wires nothing).
if (import.meta.main) {
  configSystemTwo(openResponsesRespond)
}
