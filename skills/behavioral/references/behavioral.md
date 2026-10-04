# Behavioral

Reference for an agent assisting an engineer in wiring up the Behavioral
behavioral-programming runtime — the event-coordination layer that b-threads
run inside. A behavioral program coordinates b-threads via the super-step
model: each step, pending threads' `request`s are collected as candidates,
those matching any `block` are filtered out, the highest-priority remaining
candidate is selected, threads waiting/requesting/interrupted by it are
resumed, and the next step runs. If no unblocked candidate exists the
program halts until an event arrives via `trigger` (the external admission
surface and one super-step).

## Public surface

The engine lives in-repo at `src/behavioral/behavioral.ts` (with types in
`behavioral.types.ts`, constants in `behavioral.constants.ts`, utils in
`behavioral.utils.ts`). It is **not** one of the package's public exports —
`@behavioral/sh` exports `.` (the `defineConfig` config helper, via
`src/main.ts`), `./faculties` (the faculty wire and config surface),
`./controller`, and `./utils`; none re-export the engine. Import it from its
source path:

```ts
import { behavioral } from '../../behavioral/behavioral.ts'
import type {
  AddThread,
  BPEvent,
  Disconnect,
  Thread,
  Trace,
  UseTrace,
} from '../../behavioral/behavioral.types.ts'
```

`behavioral()` returns a frozen API object with **five members** — no
`useAddHandler`, no `sendTrace`, no generic type parameter:

```ts
const { addThread, trigger, useTrace, step, instanceId } = behavioral({ sessionId?: string })
```

The optional `sessionId` is host-supplied session identity stamped on every
trace alongside the self-minted `instanceId` (the host layer owns session
identity policy); absent it defaults to the `instanceId`.

Threads are JSON objects: `{ label: string, rules: Idioms[], once?: true }`.
Each idiom is one sync point with `request` (propose an event), `waitFor`
(block until an event), `block` (forbid an event), `interrupt` (terminate the
thread on an event), and/or `transform` (match, hand off to external
reshaping, re-enter via a `target` event). `detailSchema` on listeners is
JSON Schema (draft 2020-12), compiled at registration.

## The API surface

`const { addThread, trigger, useTrace, step, instanceId } = behavioral()`

| Member | Signature | Use when |
|--------|-----------|----------|
| `addThread(args)` | `(args: Thread) => void` | Register a b-thread (`{ label, rules, once?, space? }`). The thread's optional `space` field stamps all its idioms (applied at registration). Inert — does not start a super-step. |
| `trigger(event)` | `(event: BPEvent) => void` | Inject an external event (the event carries `space`; absent = root). Triggered candidates carry `ingress: true`, have highest priority (0), and can be blocked. Initiates a super-step. |
| `useTrace(listener)` | `(listener) => Disconnect` | Observe internal state traces emitted after each event selection. Does not affect execution. |
| `removeThread(args)` | `(args: { instanceHash?: number }) => void` | Stage a removal for an instance-hash-stamped thread. Inert until the next super-step — removal applies at the top of `step()` (the addThread re-entry-law mirror), tearing down the generator + any pending bid, traced `thread_removed`. Only `i:<instanceHash>`-keyed entries are removal-addressable (ephemeral `u:`-keyed threads are never); content never enters identity, so a removal address survives rewrites. |
| `step()` | `() => void` | Pump one super-step. The internal re-entry primitive — `addThread` alone is inert, so every re-entry pairs the thread addition with a `step()` pump. |
| `instanceId` | `string` | The per-process identity the engine self-mints and stamps on every trace. Exposed so a host can hand the identity to its clients without sniffing the trace wire (silent on an idle instance). |

### `addThread` — registering threads

```ts
addThread({
  label: 'producer',
  rules: [{ request: { type: 'task' } }],
  once: true,
})
addThread({
  label: 'consumer',
  rules: [{ waitFor: [{ type: 'task' }] }, { request: { type: 'ack' } }],
  once: true,
})
```

A thread is an object with `label`, `rules` (an array of `Idioms` sync points),
and optional `once` and `space`. Without `once`, the thread loops its `rules`
indefinitely; with `once: true`, it runs through the rules once and completes.
The `label` identifies the thread in traces; the `space` stamps its idioms
(absent = root — see Space matching below). Invalid thread arguments (failing
`ThreadSchema`, or an un-compilable `detailSchema`) are surfaced as an
`add_thread_error` trace, not a throw — the thread simply isn't added.

### `trigger` — injecting external events

```ts
const { trigger } = behavioral()
trigger({ type: 'kickoff' })
trigger({ type: 'evt', detail: { ... }, space: 'space-1' })
```

Triggered events behave like a one-shot thread requesting the event at
priority 0, stamped `ingress: true`. They are subject to `block` like any
request. An event that fails `BPEvent` validation is rejected at the ingress
boundary and surfaced as a `trigger_error` trace (not a throw), echoing the
attempted `space` when present. `trigger` is how external systems (UI,
network, timers) drive the program — it is external admission plus one
super-step, nothing else. Internal re-entry never uses `trigger`: it adds a
request thread and pumps a super-step with `step()` (see the action channel).

#### The channel invariant

A selected event carries `ingress: true` **iff** it was admitted externally
via `trigger`; everything internal (satellite results, transform
targets, admitted threads) arrives as a thread request added through
`addThread`. Listeners opt into a channel with the optional
`ingressMatch` field:

| listener field | value | matches |
|----------------|-------|---------|
| `ingressMatch` | absent | either channel (backward compatible) |
| `ingressMatch` | `true` | external trigger-origin candidates only |
| `ingressMatch` | `false` | request-origin candidates only (threads + internal re-entry) |

`detailMatch` filters on whether the event's `detail` conforms to
`detailSchema`:

| listener field | value | matches |
|----------------|-------|---------|
| `detailMatch` | absent | `detail` must conform to `detailSchema` (the default) |
| `detailMatch` | `true` | `detail` must conform |
| `detailMatch` | `false` | `detail` must not conform |

An absent `detailMatch` requires conformity — it does **not** mean "match any
detail"; that keeps existing threads' filtering unchanged. All four listener
idioms — `waitFor`, `block`, `interrupt`, `transform` — share this one matching
seam, so both flags apply uniformly. `block` with `ingressMatch: true` is how
backpressure on external events is expressed.

#### Space matching

Space scoping is **root authority** — visibility flows UP only. A thread's
optional `space` stamp (absent = root) applies to all its idioms:

| listener | candidate event | matches? |
|----------|-----------------|----------|
| root (unstamped) | any space | yes — a root listener sees every space |
| space `s1` | `s1` | yes |
| space `s1` | root or a sibling space | no — a stamped listener never escapes its space |

A root thread can wait on, block, interrupt, and transform candidates in
every space; a space-stamped thread is confined to its own — a thread
governing several spaces is admitted per space explicitly, each mount
stamped. Requests are emissions, not observations: a thread's request bids
only in its own space (root requests bid in root). The `transform` target
re-enters stamped with the **source event's** space — a root transformer's
output stays in the space it observed.

### `useTrace` — observation and the action channel

```ts
const disconnect = useTrace((msg: Trace) => {
  // msg is the engine's closed Trace union — narrow by `kind`
  // (12 kinds; the full table below).
})
```

`useTrace` subscribes a listener receiving one `Trace` per step. The listener
may be sync or async (`void | Promise<void>`); **the engine never awaits
it.** Each listener return value is absorbed by `Promise.resolve(...)` with a
rejection handler attached, so a rejecting promise never breaks the
super-step. A listener failure (a sync throw or a rejecting promise) is
caught and logged via `console.error('[behavioral] trace listener ...')` —
listener failures are **log-only**, never published as traces, and the catch
is per-consumer (one failing listener cannot suppress the others).

#### The action-channel pattern (replaces `useAddHandler`)

There is no `useAddHandler` hook. Side effects — tool dispatch, I/O, model
calls — are performed by `useTrace` listeners that observe `selection`
traces and act outside the super-step, then **re-enter the engine as a
thread**. The canonical host is the composition (`src/cli/b-program.ts` —
the runtime composition `bProgram`): its pump subscribes `useTrace`, routes
selected events to their faculty lanes, and re-enters results through one
seam:

```ts
// The in-process re-entry law: addThread alone is inert — every re-entry
// pumps one super-step.
const addThreads = (threads: Thread[]): void => {
  for (const thread of threads) addThread(thread)
  step()
}
```

The contract:

- The listener filters on `msg.kind === 'selection'` and reads
  `msg.selected.type` to decide what to do.
- Async work happens **after** the listener returns — the engine never awaits
  a listener, so the super-step continues without waiting.
- Results re-enter by **adding a `once` thread that `request`s the event**,
  then pumping one super-step (the re-entry law above). The composition's
  `useFaculty` pump funnels every satellite's result threads through the same
  seam, and engine-internal code (the transform executor) calls the internal
  `step()` directly. The re-entry event therefore arrives as a
  **request-origin** candidate (`ingress` absent), which is what lets
  `ingressMatch: false` listeners match internal results while
  `ingressMatch: true` listeners stay external-only.
- Faculty/I/O failures return as **data** on the result event and re-enter
  through the same seam — they never throw into the space.
- A listener throw is `console.error`'d and swallowed — it cannot corrupt the
  program.

This is why "self-modification can't break confluence": the action channel is
an observer of the trace, not a participant in the super-step. Adding or
removing a listener never changes which event the arbiter selects.

## The `transform` idiom — declarative pure-data reshape

The fifth idiom is `transform`: a declarative, pure-data reshape that fires
**inside** the super-step, complementary to the async action-listener pattern
above (which does I/O outside it). A transform listener matches an event like
`waitFor`/`block`/`interrupt` (same `type` + optional `detailSchema`/`detailMatch`,
where `detailMatch: false` inverts the conformity test),
but instead of pausing or forbidding, it declares a reshape contract the
external host executes:

```ts
addThread({
  label: 'shaper',
  rules: [{
    transform: [{
      type: 'order',          // match this selected event
      detailSchema: { ... },  // optional JSON Schema guard
      query: '.order',        // applied to selected.detail (a jq expression)
      target: 'ship',         // re-enter the engine with this event type
    }],
  }],
})
```

Shape (`TransformListener` in `behavioral.types.ts`): a `BPListener` plus
`query` (string) and `target` (string). When a matching event is selected,
the engine emits a `transform` trace carrying `transformers: { query, target,
thread, space? }[]` **immediately before** the `selection` trace, then resumes
the thread (a transform match wakes the thread like a `waitFor` match) and
applies the contract itself: each `query` is evaluated over `selected.detail`
by the engine's internal jq subprocess (`src/behavioral/jq.worker.ts`, driven
by the `evaluateTransform` bridge in `behavioral.utils.ts`), and the result
re-enters as a `once` thread requesting `{ type: target, detail: result.value }`
stamped with the **source event's** space (a stamped contract's space equals
the event's — stamped confinement; a root transformer's output stays in the
space it observed) — the target stays request-origin. The
engine does no arbitrary I/O; its only external dependency is the jq binary.

Failures are errors-as-data: a contract that fails (jq error, no detail,
empty or non-object output) never fires its target — the failure surfaces as
a `transform_error` trace carrying the `transformer` and a machine-readable
`reason`.

The contract test is `src/behavioral/tests/transform.spec.ts`, and the
production consumer is real: the remote-mcp threads
(`src/faculties/shell/remote-mcp.threads.ts`) drives its entire
discover/tools/call pipeline with transforms over the shell faculty's `rpc`
op.

## The trace union

`Trace` is a closed discriminated union (narrow by `kind`) — the 12 kinds of
`TRACE_MESSAGE_KINDS` (`src/behavioral/behavioral.constants.ts`):

| `kind` | Carries | When |
|--------|---------|------|
| `step` | `step`, `ingress?` | A super-step began; `ingress: true` marks an externally initiated step |
| `pending_bids` | `step`, `threads` (serialized pending set) | Before event selection each step |
| `frontier` | `step`, `status`, `candidates`, `enabled` | After computing the frontier |
| `selection` | `step`, `selected` (the chosen candidate) | When an event is selected |
| `idle` | `step` | No candidates at all — the program is quiescent (not deadlocked); the settle signal |
| `deadlock` | `step` | Candidates exist but all are blocked |
| `thread_added` | `thread` (the full validated `Thread`) | `addThread` registered a thread — the provision record; replay = `thread_added` payloads + ingress events in order |
| `interrupt` | `selected`, `threadLabel`, `step` | A thread was terminated by an interrupt |
| `transform` | `step`, `transformers` | A transform listener matched; the engine applies `query` → `target` in-engine |
| `transform_error` | `step`, `transformer`, `reason`, `stderr?`, `exitCode?` | A transform contract failed (jq error, no detail, empty or non-object output); the target never fires |
| `add_thread_error` | `error` (AJV errors), `space?` | `addThread` rejected invalid args / un-compilable `detailSchema` |
| `trigger_error` | `error` (AJV errors), `space?` | `trigger` rejected an invalid `BPEvent` |
| `thread_removed` | `instanceHash`, `thread` | A staged `removeThread` applied at the top of a super-step — the thread's generator + pending bid tore down (traced even when the target was already displaced; replay = `thread_added` minus `thread_removed`) |

The three error kinds are the engine's failure surfaces, and all are
**traces, not throws** — invalid input is reported as data and the program
keeps running. There is no `feedback_error` trace.

## A common wiring mistake to avoid

Forgetting to start the super-step after adding threads. `addThread`
registers a thread but does **not** start a super-step on its own; the
program pauses until an event enters via `trigger`. A common symptom: threads
are added, nothing happens. For an external event, trigger it; for internal
re-entry (a result or a transform target), add the `once` request thread and
pump a super-step with `step()`. This inertness is deliberate:
pure-requesting programs (tic-tac-toe, water) do not self-start at
registration, so quiescence is preserved until someone admits an event.

The second common mistake: expecting side effects to fire on `trigger`. The
action channel fires on **selected** events — a triggered event that is
`block`ed by an active thread is never selected and never reaches the
`selection` trace. Check the `frontier` trace's `enabled` list to confirm the
event wasn't filtered out.

## See also

- [Frontier analysis](./frontier-analysis.md) — deadlock/livelock verification
  over the closed state graph of a behavioral program.
- [Controller](./controller.md) — the browser-side message applier over the
  `ui_*` wire (the UI-layer reference).
