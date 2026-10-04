# Frontier Analysis

Reference for an agent assisting an engineer in wiring up the Behavioral
behavioral-program verification faculty. It answers two questions
across **every reachable state** of a behavioral program, not just sampled
runs: *can it deadlock?* and *can it spin forever without making progress?*

## Public surface

Frontier analysis is a faculty, embedded **in-process** by the composition
(`src/faculties/frontier/faculty.ts` — the composition imports its dispatch
and drives it directly; standalone spawns are a compatibility entry),
speaking the behavioral event wire — `frontier_request { id, op: replay |
explore | verify, input }` in, one `frontier_request_result { id, result }`
out. The composition wires its emit lane via `bindEmit` (results re-enter
the engine, never the host's stdout); threads request it like any satellite.
Ops are short-lived (no cancel event). The event schemas live in
`src/faculties/faculties.types.ts` (the wire's one home).

Threads are JSON objects: `{ label: string, rules: Idioms[], once?: true }`.
Each idiom is one sync point with `request` (propose an event), `waitFor`
(block until an event), `block` (forbid an event), and/or `interrupt`
(terminate the thread on an event). `detailSchema` on listeners is JSON
Schema, compiled at registration.

## The op surface

The ops are `replay` (re-run to a frontier), `explore` (enumerate reachable
frontiers), and `verify` (deadlock/livelock checks), plus the `add_thread`
admission op — verify a candidate `Thread` against the mounted thread set
before it admits (`ok` iff the verification status is `'verified'`). Each
op's input schema lives in the frontier faculty (`FrontierReplayInputSchema`
et al., `src/faculties/frontier/faculty.ts`); the wire event shape itself —
`frontier_request { id, op, input }` / `frontier_request_result { id, result }`
— is homed in `src/faculties/faculties.types.ts`, the wire's one home.

**The admission policy rides the mint, never the caller's claim** (the
2026-10-03 orchestration ruling): the composition's proposal carry composes
the full `add_thread` request — `progress` is the derived `*_result`
vocabulary (unspoofable) and `maxDepth` defaults to 20 000, the requester's
override clamped to 100 000, in the dispatch jq. The op's own validation is
the boundary for anything else: `maxDepth` is REQUIRED (a request without
it fails validation — the error envelope), and an omitted `progress` skips
livelock detection (deadlock-only). The semantic judgment layer (when a
systemOne endpoint is wired) reviews only what the structural analysis
passed — TIGHTEN-only, never loosening a structural reject.

## The `progress` spec

The `progress` distinction matters when diagnosing results:

- **Omit `progress`** → livelock is **not checked**; only deadlocks. Use this
  when you only care about deadlock-freedom.
- **`progress: []`** (empty array) → **nothing** counts as progress, so
  every reachable cycle is a livelock. Rarely what you want; useful as a
  "find every cycle" probe.
- **`progress: ['eventType', ...]`** → a cycle is a livelock iff none of its
  in-cycle edges select one of the listed types. Edges that **leave** the
  cycle don't count — an escape is not progress made inside the cycle.

Status precedence: a deadlock or livelock finding yields `'failed'` even if
exploration was also truncated. A pure truncation (no findings, `maxDepth`
hit) yields `'truncated'`. Only a clean, fully-explored, finding-free run
yields `'verified'`. **Never treat `'truncated'` as a pass** — it means the
verifier gave up before proving anything.

## A common wiring mistake to avoid

Running `verify` (or `explore`) **without `maxDepth`** on a
program with unbounded state (e.g. a thread that requests an event with a
counter `detail` that grows each loop) will not terminate — the state graph
never closes. `maxDepth` is **required** on both ops for this reason. For
finite-state programs (all `once: true`, or loops with bounded `detail`) the
graph closes via state-key dedup and the tool terminates before `maxDepth`.
For anything else, set `maxDepth` and treat `truncated` as "needs a bound or
an abstraction," not a failure of the tool.

## See also

- [behavioral](./behavioral.md) — the runtime whose `Trace` union these ops
  filter on, and the `Thread` shape they take.
- [eval](./eval.md) — capturing a run's `Thread[]` + messages for later
  frontier analysis.
