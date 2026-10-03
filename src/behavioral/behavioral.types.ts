import type { JSONSchemaType } from 'ajv'
import Ajv2020 from 'ajv/dist/2020'
import { type FRONTIER_STATUS, IDIOMS, type TRACE_MESSAGE_KINDS } from './behavioral.constants.ts'

/**
 * Shared Ajv instance for the behavioral kernel.
 *
 * Uses draft 2020-12 (the current JSON Schema standard) so thread authors and
 * model-generated threads author `detailSchema` as plain JSON Schema documents.
 * `strict: false` because author-provided schemas may include unknown keywords
 * or custom extensions; `validateSchema` makes Ajv reject structurally-broken
 * schemas at compile time (surfaced as `add_thread_error` by `useAddThread`).
 */
export const ajv = new Ajv2020({ strict: true, validateSchema: true, strictRequired: false })

/**
 * A JSON object value — kernel detail payloads are JSON values.
 * Plain structural type: Ajv validates payloads against per-listener schemas,
 * so no recursive validator is needed for the type itself.
 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// Validating JSON Schema documents (registration-time)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core event shape
// ---------------------------------------------------------------------------

/**
 * An event that threads request, wait for, block, or transform.
 *
 * @property type - Event identifier; listeners match on this.
 * @property detail - JSON payload carried by the event.
 * @property space - Optional scope stamp; listeners only match events in the same space.
 *
 * @public
 */
export type BPEvent = {
  type: string
  detail?: JsonObject
  space?: string
}

export const BPEventSchema: JSONSchemaType<BPEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Event identifier; listeners match on this.' },
    detail: {
      type: 'object',
      required: [],
      additionalProperties: true,
      nullable: true,
      description: 'JSON payload carried by the event.',
    },
    space: { type: 'string', nullable: true, description: 'Scope stamp; listeners match only same-space events.' },
  },
  required: ['type'],
  additionalProperties: false,
}

/** @internal */
export const validateBPEvent = ajv.compile(BPEventSchema)

/**
 * A listener declaration inside a thread rule.
 *
 * @property type - Event type to match.
 * @property ingressMatch - Optional channel restriction. Absent matches either
 *   channel; `true` matches only external trigger-origin candidates; `false`
 *   matches only request-origin candidates (threads and internal re-entry).
 * @property detailSchema - Optional JSON Schema the event's `detail` must conform to.
 * @property detailMatch - Optional detail filter. `true` matches conforming
 *   details; `false` matches non-conforming ones; absent requires conformity
 *   (the default — an absent flag does NOT mean "match anything").
 *
 * @public
 */
export type BPListener = {
  type: string
  ingressMatch?: boolean
  detailSchema?: Record<string, unknown>
  detailMatch?: boolean
}

export const BPListenerSchema: JSONSchemaType<BPListener> = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Event type to match.' },
    ingressMatch: {
      type: 'boolean',
      enum: [true, false],
      nullable: true,
      description:
        'Channel restriction: absent matches either; true = trigger-origin only; false = request-origin only.',
    },
    detailSchema: {
      type: 'object', // <-- Must be at the top level of detailSchema
      nullable: true,
      description: 'JSON Schema the matched event detail must conform to.',
      allOf: [
        { $ref: 'https://json-schema.org/draft/2020-12/schema' },
        {
          anyOf: [
            { required: ['type'] },
            { required: ['properties'] },
            { required: ['$ref'] },
            { required: ['enum'] },
            { required: ['const'] },
            { required: ['items'] },
          ],
        },
      ],
    },
    detailMatch: {
      type: 'boolean',
      enum: [true, false],
      nullable: true,
      description: 'Detail filter: true matches conforming details, false non-conforming; absent requires conformity.',
    },
  },
  required: ['type'],
  additionalProperties: false,
}

/**
 * A transform listener — a {@link BPListener} plus the declarative reshaping
 * contract executed by external code (the daemon): `query` (e.g. a jq
 * expression) is applied to the matched event's `detail`, and the result is
 * emitted as a `target` event.
 *
 * @public
 */
type TransformListener = BPListener & {
  query: string
  target: string
}

const TransformListenerSchema: JSONSchemaType<TransformListener> = {
  type: 'object',
  properties: {
    ...BPListenerSchema.properties,
    query: { type: 'string', description: 'Query (e.g. a jq expression) applied to the matched event detail.' },
    target: { type: 'string', description: 'Event type the query result is emitted as.' },
  } as NonNullable<JSONSchemaType<TransformListener>['properties']>,
  required: ['type', 'query', 'target'],
  additionalProperties: false,
}

/**
 * Registered listener — a {@link BPListener} stamped with its thread's `space`
 * at registration time in {@link generateRulesFunctions}.
 *
 * @public
 */
export type RegisteredBPListener = BPListener & {
  space?: string
}

/**
 * Registered transform listener — a {@link TransformListener} with space
 * stamping, post-registration.
 *
 * @public
 */
export type RegisteredTransformListener = TransformListener & {
  space?: string
}

/**
 * Represents a synchronization statement yielded by a behavioral rule step.
 * This is the core mechanism through which b-threads communicate their behavioral intentions
 * to the behavioral program scheduler at each step of execution.
 *
 * @property request - Propose an event to be selected and triggered. Only one request per sync point.
 * @property waitFor - Wait for specific events. Thread pauses until a matching event is selected.
 * @property block - Prevent specific events from being selected. Higher precedence than requests.
 * @property interrupt - Events that terminate the thread's execution if selected.
 * @property transform - Events to match, hand off to external reshaping, and re-enter via `target`.
 *
 * @remarks
 * - Multiple listeners can be provided as arrays
 * - Blocked events have precedence over requested events
 * - Interrupts cause thread termination
 *
 * @see {@link ThreadSchema} for the tuple that embeds idiom rules
 * @see {@link AddThread} for registering a thread from `Idioms[]` rules
 */
export type Idioms = {
  [IDIOMS.waitFor]?: BPListener[]
  [IDIOMS.interrupt]?: BPListener[]
  [IDIOMS.block]?: BPListener[]
  [IDIOMS.request]?: BPEvent
  [IDIOMS.transform]?: TransformListener[]
}

const IdiomSchema: JSONSchemaType<Idioms> = {
  type: 'object',
  properties: {
    [IDIOMS.waitFor]: {
      type: 'array',
      items: BPListenerSchema,
      minItems: 1,
      nullable: true,
      description: 'Event listeners this thread pauses on; the thread resumes when one is selected.',
    },
    [IDIOMS.interrupt]: {
      type: 'array',
      items: BPListenerSchema,
      minItems: 1,
      nullable: true,
      description: 'Event listeners that terminate the thread when selected.',
    },
    [IDIOMS.block]: {
      type: 'array',
      items: BPListenerSchema,
      minItems: 1,
      nullable: true,
      description: 'Event listeners whose matches are prevented from selection while the thread holds this sync point.',
    },
    [IDIOMS.request]: {
      ...BPEventSchema,
      nullable: true,
      description: 'The event proposed for selection at this sync point.',
    },
    [IDIOMS.transform]: {
      type: 'array',
      items: TransformListenerSchema,
      minItems: 1,
      nullable: true,
      description: 'Declarative reshape contracts: match an event, query its detail, re-enter via target.',
    },
  },
  additionalProperties: false,
}

/**
 * Registered idioms — the internal, post-registration representation.
 *
 * @remarks
 * `detailSchema` stays a plain JSON object (it *is* JSON Schema), so registered
 * listeners serialize without conversion — traces and the frontier visited-set
 * key stay JSON-only by construction.
 */
export type RegisteredIdioms = {
  [IDIOMS.waitFor]?: RegisteredBPListener[]
  [IDIOMS.interrupt]?: RegisteredBPListener[]
  [IDIOMS.block]?: RegisteredBPListener[]
  [IDIOMS.request]?: BPEvent
  [IDIOMS.transform]?: RegisteredTransformListener[]
}

/**
 * Composes an ordered array of rule generators into a single behavioral thread generator.
 *
 * @param rules - Rule generators (each yielding one `RegisteredIdioms`) to compose.
 * @param once - When `true`, the thread runs through the rules once and completes.
 *               When omitted, the thread loops the rules indefinitely.
 * @returns A generator function yielding the idioms from each rule in sequence.
 *
 * @remarks
 * - The `once` flag controls repetition semantics for the behavioral scheduler.
 * - Empty rule arrays complete immediately (the generator is `done` on first call).
 *
 * @see {@link generateRulesFunctions} for building the rule array from author-facing `Idioms`.
 */

export type RulesFunction = () => Generator<RegisteredIdioms, void, unknown>

export type UseThread = (rules: RulesFunction[], once?: true) => RulesFunction

/**
 * @internal
 * Represents a b-thread that is currently executing its rule sequence.
 *
 * These are threads that are active and running between synchronization
 * points. Running threads are those that have been moved from the
 * pending state after selecting an event that matches their `waitFor`
 * or `request` declarations.
 */
export type RunningBid = {
  /** The thread's `name` — carried from the definition (or minted for ingress/transform threads). */
  name: string
  /** The priority level of the thread, used for resolving conflicts when multiple threads request events. Lower numbers = higher priority. */
  priority: number
  /** Internal iterator representing the thread's execution state. Holds the current position in the rule sequence. */
  generator: IterableIterator<RegisteredIdioms>
  ingress?: true
  space?: string
  /** Where present, the thread's `description` (minted threads carry a default). */
  description?: string
}

/**
 * @internal
 * Represents a b-thread that has yielded and is waiting for the next event selection.
 *
 * These threads have reached a synchronization point and declared their `Idioms` (request, waitFor, block, interrupt).
 * The thread remains in this state until an event matching its `waitFor`, `request`, or `interrupt` is selected.
 */
export type PendingBid = RegisteredIdioms & RunningBid

/**
 * @internal
 * Represents a potential event candidate derived from a pending thread's request.
 *
 * During each super-step, the behavioral program collects all requested events as candidates,
 * filters out those that are blocked, and selects the highest priority remaining candidate.
 * This structure holds the metadata needed for this selection process.
 */
export type CandidateBid = {
  /** The priority of the thread proposing the event. Lower numbers indicate higher priority in the selection process. */
  priority: number
  /** The type of the requested event, used for matching against waitFor, block, and interrupt declarations. */
  type: string
  /** Optional detail payload of the requested event, contains any data associated with this event. */
  detail?: BPEvent['detail']

  ingress?: true
  space?: string
}
/**
 * A b-thread registration tuple.
 *
 * @property name - Unique-ish human name; appears in trace messages.
 * @property description - One short paragraph (≤512 chars) describing what the thread does — model-readable.
 * @property rules - The thread's synchronization statements, executed in order.
 * @property once - When `true`, the thread runs its rules once and completes.
 * @property sourceHash - Optional provenance: the djb2 hash of the plugin's local path or remote URI, stamped at the proposal path.
 *
 * @public
 */
export type Thread = {
  space?: string
  name: string
  description: string
  once?: true
  rules: Idioms[]
  sourceHash?: number
}

/**
 * The runtime schema mirror of {@link Thread} — the admission gate's home.
 * Exported so wire consumers (the frontier's `add_thread` op) derive their
 * input schemas from it instead of hand-mirroring the tuple shape.
 *
 * @internal
 */
export const ThreadSchema: JSONSchemaType<Thread> = {
  type: 'object',
  properties: {
    space: {
      type: 'string',
      nullable: true,
      description: 'Scope stamp; the thread matches only events in the same space.',
    },
    name: { type: 'string', minLength: 1, description: 'Human-readable thread name; appears in trace messages.' },
    description: {
      type: 'string',
      maxLength: 512,
      description: 'One short paragraph describing the thread — the model-facing self-description.',
    },
    once: {
      type: 'boolean',
      enum: [true],
      nullable: true,
      description: 'When true, the thread runs its rules once and completes; otherwise it loops indefinitely.',
    },
    rules: { type: 'array', items: IdiomSchema, description: 'The synchronization statements executed in order.' },
    sourceHash: {
      type: 'integer',
      minimum: 0,
      nullable: true,
      description:
        "Provenance: djb2 of the plugin's canonical source (path or URI) — the association join key; minted at the proposal path.",
    },
  },
  required: ['name', 'description', 'rules'],
  additionalProperties: false,
}

/** @internal */
export const validateThread = ajv.compile(ThreadSchema)

export type Threads = Thread[]

/**
 * The serialized (plain-JSON) mirror of an authored {@link Thread} — the ONE
 * home for wire consumers that validate an authored thread structurally
 * (frontier's replay/add_thread input schemas) instead of hand-mirroring the
 * shape. Rules stay permissive here (idiom internals as plain objects) — a
 * caller's `detailSchema` reaches the runtime validator verbatim; the engine's
 * `ThreadSchema` gate re-validates at registration.
 *
 * @internal
 */
export const SerializedThreadSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, description: 'Human-readable thread name.' },
    description: { type: 'string', maxLength: 512 },
    sourceHash: { type: 'integer', minimum: 0 },
    once: { type: 'boolean', enum: [true], nullable: true },
    rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['name', 'description', 'rules'],
  additionalProperties: false,
} as const

/**
 * Structural contract for consumer-supplied trace extensions.
 *
 * @remarks
 * `Trace` variants happen to satisfy this shape (each spreads it), but consumers
 * should treat this as the contract their *extension* kinds must match when
 * parameterizing {@link behavioral} with a custom trace type — namely
 * `{ kind: string; timestamp: number }` plus kind-specific fields. Extension
 * kinds should use literal `kind` strings distinct from the engine's
 * `TRACE_MESSAGE_KINDS` so narrowing by `kind` remains unambiguous in the
 * unified `Trace | T` stream.
 *
 * The two id axes are separate and both live on the wire: `instanceId` is the
 * per-process identity the engine self-mints; `sessionId` is the host's
 * session identity (the host mints and manages session ids), defaulted
 * to the `instanceId` when no host supplies one. The engine accepts a session
 * id at factory time — it never mints one and never returns ids.
 *
 * @see {@link TraceBaseSchema} for the runtime (JSON-schema) mirror
 * @see {@link Trace} for the engine's closed trace union
 */
type TraceBase = {
  kind: string
  timestamp: number
  instanceId: string
  sessionId: string
}

/**
 * Wire schema for the fields every trace carries — the runtime mirror of
 * {@link TraceBase}. The one home for the trace wire's common shape: per-kind
 * trace validators derive from this (spread the properties, extend `required`)
 * instead of hand-mirroring the fields.
 */
export const TraceBaseSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', description: 'Trace discriminator; narrow the unified trace stream on this.' },
    timestamp: { type: 'number', description: 'Wall-clock time the trace was emitted.' },
    instanceId: { type: 'string', description: 'Per-process identity the engine self-mints.' },
    sessionId: { type: 'string', description: "Host-managed session identity; defaults to the engine's instanceId." },
  },
  required: ['kind', 'timestamp', 'instanceId', 'sessionId'],
} as const

// ---------------------------------------------------------------------------
// Trace kinds
// ---------------------------------------------------------------------------

export type FrontierTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.frontier
  step: number
  status: (typeof FRONTIER_STATUS)[keyof typeof FRONTIER_STATUS]
  candidates: CandidateBid[]
  enabled: CandidateBid[]
}

export type SelectionTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.selection
  step: number
  selected: CandidateBid
}

export type DeadlockTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.deadlock
  step: number
}

/**
 * Emitted when a super-step finds no candidate events at all — the program is
 * quiescent (waiting on external input), distinct from a deadlock (candidates
 * exist but every one is blocked). The settle signal: no further selections
 * will occur until a trigger arrives.
 */
export type IdleTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.idle
  step: number
}

/**
 * Emitted when `useAddThread` receives arguments that fail `ThreadSchema`
 * validation or contain an un-compilable `detailSchema`.
 *
 * @property error - Ajv error objects (`ErrorObject[]`) describing the failure,
 * narrowed via `Array.isArray`.
 *
 * @public
 */
export type AddThreadError = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.add_thread_error
  error: unknown[]
  space?: string
}

/**
 * Emitted when `addThread` successfully registers a thread — the provision
 * record. Carries the full validated {@link Thread} so the trace log is
 * self-contained: replay = `thread_added` payloads + ingress events in
 * order (see `StepTrace.ingress` for the replay filter).
 *
 * @public
 */
export type ThreadAddedTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.thread_added
  thread: Thread
}

export type SerializedThread = {
  name: string
  description?: string
  priority: number
  ingress?: true
  space?: string
  request?: Pick<BPEvent, 'type' | 'detail'>
  waitFor?: RegisteredBPListener[]
  block?: RegisteredBPListener[]
  interrupt?: RegisteredBPListener[]
  transform?: RegisteredTransformListener[]
}

export type PendingBidsTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.pending_bids
  step: number
  threads: SerializedThread[]
}

export type TriggerError = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.trigger_error
  error: unknown[]
  /** The attempted event `space`, echoed for observability even when validation fails. */
  space?: string
}

export type InterruptTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.interrupt
  selected: CandidateBid
  threadLabel: string
  step: number
}

export type Transformer = { query: string; target: string; thread: string; space?: string }

export type TransformTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.transform
  step: number
  transformers: Transformer[]
}

/**
 * Machine-readable reasons a transform contract failed to produce its target
 * event. The engine never throws for these — each becomes a
 * {@link TransformErrorTrace} and the target never fires.
 */
export type TransformFailureReason =
  /** jq exited non-zero with stderr (`JqError`) — bad query or runtime failure */
  | 'jq_error'
  /** the matched event carried no detail to query */
  | 'no_detail'
  /** the host realm has no SharedArrayBuffer (not crossOriginIsolated) — the bridge stays down */
  | 'jq_unavailable'
  /** the query produced no output (`first()` returns `undefined`) */
  | 'empty_output'
  /** the query output was not an object (scalar, array, or null) */
  | 'non_object_output'
  /** the eval worker was killed at the timeout — a never-terminating query */
  | 'jq_timeout'
  /** the evaluated value exceeded the shared-buffer result cap */
  | 'output_too_large'

/**
 * The result of a transform evaluation — the whole first output, parsed, or
 * a machine-readable failure reason. Never thrown; serialized over the
 * worker bridge between `jq.worker.ts` and `evaluateTransform`.
 */
export type TransformEvaluation =
  | { ok: true; value: JsonObject }
  | { ok: false; reason: TransformFailureReason; stderr?: string; exitCode?: number }

/**
 * Structural schema for the SAB frame the jq worker ships back — the
 * trust-boundary validation in the `evaluateTransform` bridge (the
 * two-guards pattern: JSON.parse proves syntax, this proves shape). Hand-written `oneOf` on the `ok` discriminant, cast through
 * `unknown` per the tools-fleet precedent; the `value` branch is the JsonObject
 * floor, mirroring the worker's own object check. Strict
 * `additionalProperties: false` at every level; no defaults (the strict-mode
 * oneOf conflict does not apply).
 */
export const TransformEvaluationSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [true], description: 'True — the transform produced a value.' },
        value: {
          type: 'object',
          required: [],
          additionalProperties: true,
          description: 'The parsed query output object.',
        },
      },
      required: ['ok', 'value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', enum: [false], description: 'False — the transform failed; see reason.' },
        reason: {
          type: 'string',
          enum: ['jq_error', 'no_detail', 'empty_output', 'non_object_output', 'jq_timeout', 'output_too_large'],
          description: 'Machine-readable failure reason; the engine never throws for these.',
        },
        stderr: { type: 'string', nullable: true, description: 'jq stderr, present when reason is jq_error.' },
        exitCode: { type: 'integer', nullable: true, description: 'jq exit code, present when reason is jq_error.' },
      },
      required: ['ok', 'reason'],
      additionalProperties: false,
    },
  ],
} as unknown as JSONSchemaType<TransformEvaluation>

/** @internal Compiled once — the jq-worker frame guard. */
export const validateTransformEvaluation = ajv.compile(TransformEvaluationSchema)

export type TransformErrorTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.transform_error
  step: number
  /** The failed reshape contract. */
  transformer: Transformer
  /** Machine-readable failure reason. */
  reason: TransformFailureReason
  /** jq stderr, present when reason is `'jq_error'`. */
  stderr?: string
  /** jq exit code, present when reason is `'jq_error'`. */
  exitCode?: number
}

export type StepTrace = TraceBase & {
  kind: typeof TRACE_MESSAGE_KINDS.step
  step: number
  ingress?: true
}

/**
 * Discriminated union of all observable moments from the BP engine.
 * Consumers narrow by the `kind` field.
 *
 * @remarks
 * Hand-written (not derived from a validator) — Ajv has no discriminated-union
 * inference; the union is the type-level contract while the per-kind schemas
 * are the runtime contract.
 *
 * @see {@link SelectionTrace} for event selection observations
 * @see {@link DeadlockTrace} for blocked-candidate deadlock observations
 *
 * @public
 */
export type Trace =
  | TriggerError
  | FrontierTrace
  | DeadlockTrace
  | IdleTrace
  | SelectionTrace
  | AddThreadError
  | ThreadAddedTrace
  | PendingBidsTrace
  | InterruptTrace
  | TransformTrace
  | TransformErrorTrace
  | StepTrace

/**
 * @internal
 * Frontier classification for the current pending set.
 *
 * This is an execution-oriented shape used by the scheduler to decide whether to:
 * - select and process an event (`ready`)
 * - emit a deadlock trace (`deadlock`)
 * - do nothing (`idle`)
 */
export type Frontier = {
  candidates: CandidateBid[]
  enabled: CandidateBid[]
  status: keyof typeof FRONTIER_STATUS
}

/**
 * @internal
 * Reconstructed replay result for downstream explorer slices.
 */
export type ReplayToFrontierResult = {
  pending: Set<PendingBid>
  frontier: Frontier
}

/**
 * Represents a cleanup function for resource management.
 * Follows the disposable pattern for proper lifecycle management.
 *
 * @returns `void` or `Promise<void>` for asynchronous cleanup.
 *
 * @see {@link UseFeedback} for event handler cleanup
 * @see {@link UseTrace} for trace listener cleanup
 */
export type Disconnect = () => void | Promise<void>

/**
 * A callback function invoked with a trace of the behavioral program's state
 * after each event selection step (super-step). This provides a hook for observing
 * the program's internal execution state in real-time without affecting its behavior.
 *
 * The listener is called immediately after an event is selected but before the event is
 * published to feedback handlers. This allows for real-time monitoring, logging,
 * debugging, and analysis of the behavioral program's execution flow.
 *
 * @param msg - A trace describing the step (an engine {@link Trace} variant).
 * @returns `void` for synchronous listeners or `Promise<void>` for asynchronous
 *   processing. The return value is ignored by the behavioral program.
 *
 * @see {@link UseTrace} for registering trace listeners
 * @see {@link Trace} for the engine's trace structure
 */
export type TraceListener = (msg: Trace) => void | Promise<void>

/**
 * Represents a generic structure for event detail payloads.
 * It's a record where keys are string identifiers (typically event property names)
 * and values can be of any type. This type is often used as a constraint
 * in more specific event handling types to allow for arbitrary data.
 *
 * It serves as the default type for the `Details` generic parameter in `Handlers<Details>`,
 * meaning if no specific event map is provided, handlers will expect `EventDetails` for
 * their payloads.
 */
// biome-ignore lint/suspicious/noExplicitAny: Default event map allows any detail type, constrained by Handlers<T>
export type EventDetails = Record<string, any>

/**
 * Hook for monitoring internal state transitions of the behavioral program.
 * Provides debugging, visualization, and analysis capabilities.
 *
 * @param listener - Callback receiving traces after each event selection.
 * @returns Disconnect function for cleanup.
 *
 * @remarks
 * - Called before feedback handlers
 * - Doesn't affect program execution
 * - Useful for debugging, tracing, and eval capture (see the `eval` skill)
 *
 * @see {@link Trace} for the engine's trace structure
 * @see {@link TraceListener} for listener type
 */
export type UseTrace = (listener: TraceListener) => Disconnect

export type AddThread = (args: Thread) => void
/**
 * Injects external events into the behavioral program.
 * Primary interface for external systems to communicate with the program.
 *
 * @param args - Event to trigger, including its `type`, optional `detail`, and
 *   optional `space` (absent = root). The event carries its own space; the
 *   external surface is not partially applied per space.
 *
 * @remarks
 * - Triggered candidate events carry `ingress: true`, so listeners can require
 *   or exclude external origin via their `ingressMatch` flag.
 * - Triggered events have highest priority (0)
 * - Can be blocked by active threads
 * - Initiates new execution cycle
 *
 * @see {@link BPEvent} for event structure
 */
export type Trigger = <T extends BPEvent>(args: T) => void

export type SendTrace = {
  (value: Trace): void
  subscribe(listener: (msg: Trace) => void | Promise<void>): () => void
}
