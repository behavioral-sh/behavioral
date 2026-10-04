# Eval — the capture-side data contract

Reference for an agent building a **behavioral eval harness**. This is a
shape guide for the DATA the harness handles — the trace stream, its event
shapes, the correlation axes, and the redacted/raw split. It is prescriptive
on what a capture layer sees, not on harness code: behavioral supplies the
capture primitives and the wire shapes; the harness is consumer-authored.

(The iterative hill-climb use of the same primitives — capture, analyze,
mutate, repeat — lives in the agenthub project.)

## Public surface

The capture primitive is `useTrace`, returned by `behavioral()` (in-repo at
`src/behavioral/behavioral.ts` — the engine is not one of the package's
exports; `@behavioral/sh` exports `.`, `./faculties`, `./controller`, and
`./utils`, none of which re-export it):

```ts
import { behavioral } from '../../behavioral/behavioral.ts'
import type { Trace } from '../../behavioral/behavioral.types.ts'

const { addThread, trigger, useTrace, step, instanceId } = behavioral()
```

The `Trace` union is **closed** — there is no `sendTrace` hook and no generic
type parameter, so you cannot inject custom trace kinds into the engine's
stream. Agent-lifecycle events (tool calls, messages) are captured by the
consumer's own side-channel (the agent SDK's subscription), written to the
same sink — do **not** correlate them by timestamp alone; see the identity
axis below.

## The data stream: capture-side projections

`Trace` is a closed discriminated union — 12 kinds. [behavioral.md
](./behavioral.md) owns the full kind table; a harness only needs to know
which kinds to key on and what each carries:

| Key on | What it tells the grader | Carries |
|--------|--------------------------|---------|
| `selection` | **What happened** — the chosen candidate | `step`, `selected` |
| `thread_added` | **The provision record** — the full validated `Thread` at registration | `thread` |
| `idle` | **Quiescence** — the settle signal; no further selections until a trigger | `step` |
| `transform` | **Reshape activity** — the contract minted to the transform faculty | `step`, `transformers` (`id` = the park key) |
| `transform_request_result` (a selection, not a trace) | **Reshape outcome** — ok evaluates; ok:false is the failure surface (the target never fired) | `id`, `ok`, `value?/reason` |
| `deadlock` | **Health metric** — candidates existed but all were blocked | `step` |

The remaining kinds (`step`, `pending_bids`, `frontier`, `interrupt`,
`add_thread_error`, `trigger_error`) are per-step scaffolding and the
error surfaces — capture them (they are on the same stream in publication
order), but graders mostly key on the rows above. BP-health metrics
(deadlock counts, idle-to-trigger ratios) read straight off `kind` counts.

## Identity + correlation

Every trace carries `TraceBase { kind, timestamp, instanceId, sessionId }`
(`src/behavioral/behavioral.types.ts`). The two id axes are separate:

- `instanceId` — the per-process identity the engine self-mints (`bp_` +
  UUID v7). Exposed on the API object, so a host can hand it to clients
  without sniffing the wire.
- `sessionId` — the host's session identity, accepted at factory time
  (`behavioral({ sessionId })`), never minted; defaults to `instanceId` when
  no host supplies one.

**Correlate by `sessionId`, not timestamp.** Timestamps order events within
one stream but are too coarse to join the engine's traces with an agent
SDK's side-channel reliably. One trial = one sessionId; the boundary
question below decides what a trial is.

## Umwelt

A trace's umwelt is best-effort, derived by the consumer lane (`traceUmwelt`
in `src/cli/trace-consumer.ts`): a top-level trace `umwelt` if present, else
the `selection`'s / `interrupt`'s `selected.umwelt`, else a
`thread_added`'s `thread.umwelt`, else root. Per-umwelt grading is
**consumer-side filtering** — the engine stamps umwelts on events, not on
traces beyond the above; a grader that wants per-umwelt results filters the
stream itself using the same derivation.

## `Thread[]` for divergence

Divergence analysis needs the **threads**, not just the messages — and with
behavioral the capture is free: every registration emits a `thread_added`
trace carrying the full validated `Thread`, so a subscriber that persists
`thread_added` payloads has the `Thread[]` by the time the run ends. (Replay
= `thread_added` payloads + ingress events in order — see `StepTrace.ingress`
in behavioral.md.)

For divergence analysis, issue `frontier_request { id, op, input }` over the
captured `Thread[]` + messages — `replay`, `explore`, or `verify`. The op
contracts, the `progress` spec, and the `maxDepth`/`truncated` semantics are
[frontier-analysis](./frontier-analysis.md)'s; eval.md only records that a
harness must capture `Thread[]` (via `thread_added`) and the messages to be
able to branch-analyze later. For a plain agent (no behavioral layer) there
are no threads and frontier analysis doesn't apply.

One concrete consumer ships with the harness: the ui autoresearch loop
(`src/cli/ui-capture.ts`) captures ui-pipeline runs exactly this way — the
standing `Thread[]` plus position-tagged once-thread re-entries (the
transform targets' requesters, needed for faithful prefix replay), flushed to
`<home>/captures/ui-runs.jsonl`, with `uiReplayRequest` building the replay
event over a run or a message prefix. See
[controller.md](./controller.md)'s autoresearch section for the pipeline side.

## The redacted/raw split

**Consumer position determines the view.** The engine never awaits or gates
listeners — each `useTrace` subscriber sees the same raw stream, with a
per-consumer catch (one failing listener is log-only and cannot suppress the
others):

- **In-process subscribers are raw.** A second `useTrace` subscriber on the
  composition is THE canonical eval path: it sees every trace unredacted and
  coexists with the composition's own lanes (the pump, the redacted egress
  consumer) — engine isolation is per-consumer, so an eval listener's
  failures never break the program or the log.
- **Every remote carrier is redacted-once.** The stdio serve and the
  instance-socket host wire the egress consumer
  (`createTraceConsumer` in `src/cli/trace-consumer.ts`): one redaction
  pass, then fan-out to the JSONL log (`<root>/<umwelt>/<date>.jsonl`) and
  the `trace` notification. Redaction replaces exactly the secret-bearing
  values — declared secret values (env keys matching the sensitive-name
  pattern, minimum length 8), sensitive field names (`authorization`,
  `cookie`, `token`, ...), and credential shapes — with `[REDACTED]`.

What a grader can rely on per position: an in-process grader sees the full
fidelity stream (secrets included — it is inside the trust boundary); a
remote grader reads redacted traces and must NOT expect credential-bearing
fields to carry values (redacted fields are exactly the secrets — their
presence is still informative, their content is not). Do not try to recover
redacted values from the carrier; capture what you must via the in-process
subscriber instead.

## Wiring seams as shapes, not code

The host-facing runtime is `HostRuntime = { trigger, useTrace, start,
terminate, identity }` (`src/cli/serve.ts` — a pick of the composition's
handle). The seams a harness wires:

- **The engine never awaits listeners** — a capture listener that throws or
  rejects cannot stall the super-step; keep sinks synchronous when ordering
  is the contract (`traceLogSink` is sync by design for exactly this
  reason). Async work belongs after the listener returns, re-entered via
  `trigger`/`step` per the action channel (behavioral.md).
- **Subscribe before `start()`** — the boot cascade runs after subscribers
  attach, so boot traces are observable.
- **Sinks are the harness's** — behavioral does not prescribe JSONL, a
  database, a socket, or any store; the egress consumer above is what the
  runtime's own carriers do, and a harness mirrors or reuses it.

## Intake questions

These shape the capture wiring; the answers differ by eval:

- **Boundary** — what counts as one trace? One agent session? One task
  attempt? One inference turn? One branched exploration? For eval, usually
  *one trial* (one task attempt, start to a terminal result) — which maps to
  one `sessionId`.
- **Lifecycle** — what event closes the trace and triggers flush? A
  `completed`/`failed`/`timed_out` result? A turn budget? A wall-clock
  budget?
- **Sink** — in-process subscriber or a remote carrier? This decides the
  redacted/raw split above. Then: file, socket, DB, in-memory.
- **Retention** — all trials kept, or only failures, or a sample? The
  keep/discard rule is the consumer's.
- **Analysis target** — post-hoc outcome grading, divergence analysis
  (needs `Thread[]` capture), or both? Decide at intake: the messages alone
  can't reconstruct reachable branches, and `thread_added` is the only
  provision record.

## Grading is beyond this package

behavioral supplies the capture primitive (`useTrace`) and, for behavioral
agents, the divergence-analysis faculty (frontier analysis). It supplies
**no grading code**. Graders are consumer-authored:

- **Deterministic** — read the trace, apply rules (gold-answer match,
  BP-health metrics over `kind` counts, token/cost aggregation).
- **LLM-rubric** — a subprocess grader that reads the trace and asks a judge
  model.
- **Hybrid** — deterministic pre-filter + LLM-rubric on the survivors.

Anthropic's framing applies to the outcome-grading subset: *grade what the
agent produced, not the path it took.* Trajectory signals (tool-call count,
BP deadlocks, latency) are metrics, not pass/fail graders. The divergence
case is the exception — there, the *branches* are the thing being graded.

## See also

- [behavioral](./behavioral.md) — the runtime, the full trace-kind table,
  and the hook surface.
- [frontier-analysis](./frontier-analysis.md) — the op contracts over a
  captured `Thread[]` + messages.