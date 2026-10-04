# UI Layer — the Controller

Reference for an agent assisting an engineer in wiring up the UI layer of a
behavioral app. The live surface is the browser **`Controller`** — it applies
`ui_*` wire messages to a **live DOM** over a WebSocket (or an injected
`Transport`). It is driven by a [behavioral program](./behavioral.md)'s
`selection` listeners (the action channel).

The compiled SSR html tools are **retired** (the ICL conversion removed the
fleet). There is **no `Renderer` class** and no server-side html surface — the
`ui_*` vocabulary's server side is emitted by the agent's behavioral program,
and its browser side is the Controller below.

## Browser Controller

`Controller` is exported via the `@behavioral/sh/controller` package export
(re-exported from `src/controller/controller.ts`). Construct one instance per
page, loaded as an async module script in `<head>`:

```ts
import { Controller } from '@behavioral/sh/controller'
```

The constructor takes lifecycle hooks and optional extensions:

```ts
new Controller({
  extensions,            // optional Map<string, ControllerExtension>
  onPageReveal,          // page reveal callback
  onPageSwap,            // page swap callback
  onPageHide,            // pagehide callback
  onPageShow,            // pageshow callback
  transport,             // optional injected Transport (default: built-in WebSocket carrier)
})
```

### The push model

This is the load-bearing concept: a behavioral page is **push-based**, not
pull-based. The controller does not fetch state and render client-side; it
opens a carrier to its serving agent and applies server-pushed `ui_*`
messages:

| Agent → browser (`CONTROLLER_INCOMING_MESSAGE_TYPES`) | What the Controller does |
|-------------------------------------------------------|--------------------------|
| `ui_render` | Apply HTML to `[b-target]` elements per the `swap` mode |
| `ui_attrs` | Set/remove attributes on `[b-target]` elements |
| `ui_dispatch_custom_event` | Fire a `CustomEvent` on the target |
| `ui_navigate` | Navigate the page (URL change) |
| `ui_scale_check` | Resolve the effective `b-scale` for a target and reply with `ui_scale_check_result` |

There is no `ui_style` message (the #style-deletion ruling, 2026-10-03):
design tokens ride `ui_attrs` — `attr: { style: <bare declarations> }`, the
custom-property declaration list applied inline on the target root
(`setAttribute('style', …)` replaces the WHOLE attribute); the target's
subtree inherits the properties. Scoped component styles ride the `ui_render`
lane: a fragment may carry its own `<style>` with the prelude-less inline-form
`@scope`.

User interactions and page lifecycle emit `ui_*` messages back to the agent:

| Browser → agent (`CONTROLLER_OUTGOING_MESSAGE_TYPES`) | When |
|-------------------------------------------------------|------|
| `ui_event` | A `b-trigger` declaration fired (DOM event → BP event with `getAttributes` detail) |
| `ui_snapshot` | A page lifecycle event (`pagereveal`/`pageswap`/`pagehide`/`pageshow`) — serialized HTML via `getHTML({ serializableShadowRoots: true })` |
| `ui_success` | A server message was applied successfully (carries the request `id`) |
| `ui_error` | A message handler threw (carries `name`, `error`, `stack`, `id`) |
| `ui_scale_check_result` | Reply to a `ui_scale_check` message (carries `effectiveScale`) |
| `ui_form_submit` | A `b-form` form POST completed |

The agent — running a behavioral program — is the source of truth for what
the page shows; the Controller is the DOM applier.

The kind names are `keyMirror` constants in
`src/controller/controller.constants.ts`
(`CONTROLLER_INCOMING_MESSAGE_TYPES` / `CONTROLLER_OUTGOING_MESSAGE_TYPES`).

### The schema home

`CONTROLLER_DETAIL_SCHEMAS` (`src/controller/controller.schemas.ts`) maps
every `ui_*` kind to its AJV detail schema — the guard/reflection home. The
host threads import it (`validateControllerDetail`) to gate controller
messages at the composition boundary. The browser bundle **never** carries
the compiled validators — it ships only the deterministic floors below.

### The floors + classifier story

What keeps the wire safe across every host:

- **Deterministic floors** — `isInvalidTrigger` / `detectXssVectors`
  (`src/controller/controller.utils.ts`): hardcoded invariants (empty
  b-trigger = invalid, the semicolon grammar, on*/scheme vectors) that run
  in every host, browser included, with no ajv/css-tree in the bundle.
- **Schemas as data** — `src/controller/html.schemas.ts` + `css.schemas.ts`:
  pure JSON-schema data (the classifier's context, not compiled validators).
- **The classifier ceiling** — the System One/Jev gate story:
  probabilistic admission over the schema context, with the floors as the
  deterministic backstop. Probabilistic gates never own security invariants.

## The ui_* producer threads

Nothing above emits `ui_*` on the agent side by itself — the view-generation
policy is composition threads: `src/b-program/ui-threads.ts`, mounted by `bProgram`
when shell + store + systemTwo are all on (absent systemTwo there is no
generation lane and the threads don't mount). The shape is a dispatcher +
per-trigger pipelines: a STANDING set (the boot design scan, the tenant +
artifact compile, the render gate) plus, on each `render` ingress, one MINTED
pipeline — `uiPipelineThreads({ id, detail })`, six once-threads added by the
composition's host leg (b-program's pump, the admission-path precedent) — so
concurrent triggers interleave without dropping and every correlation id is
per-trigger (`<id>-scale`/`-tenant`/`-gen`/`-render`/`-attrs`, label
`ui/pipeline:<id>/<leg>`). The vertical is the same — ingress `ui_event` →
scale preflight → generation → `ui_render` — refined by the autoresearch
loop, not by argument.

### The design tenant (DESIGN.md → store)

At boot a scan recipe (the shell faculty's `run` op, the SKILL.md
fence-slicing + `YAML.parse` contract) reads the USER'S `<home>/DESIGN.md` —
[Google's DESIGN.md format](https://github.com/google-labs-code/design.md):
YAML frontmatter token groups plus `##` prose sections — and lands it in the
store as the `design` collection's `context` value:
`{ tokens, sections, warnings }` (warnings-as-data). **The no-lock contract**:
the shipped asset (`skills/behavioral/assets/DESIGN.md`) is an init-copied
seed only — the runtime never reads the asset, never re-syncs it; a user who
edits, replaces, or deletes their home file fully controls (or removes) their
design context. The design lane is an optional input, never a gate: with no
tenant (or a null-tokens tenant) generation proceeds plain and still produces
a conforming `ui_render`.

Consumption is lenient per the format's consumer table: unknown frontmatter
groups and section headings ride verbatim; the spec-named groups
(`colors`/`typography`/`rounded`/`spacing`) validate by shape with a bad
group dropping to a warning; a duplicate `##` section heading rejects the
file (tokens and sections null, the rejection riding the warnings). A missing
`DESIGN.md` is not an error — no tenant, no warnings.

### The scale preflight

A `render` trigger (the b-trigger convention — a `ui_event` whose inner BPEvent
has type `render`, optionally carrying `detail.target`) drives the pipeline's
scale legs: the minted set requests `ui_scale_check` under its per-trigger id
and the scale-join once-thread composes the generation request (`generate`, a
thread-owned event — never a `ui_*` wire message) when the correlated
`ui_scale_check_result` re-enters. The join is the echoed `id` (the controller
wire carries no ctx); a result with a foreign id joins nothing. The effective
scale and target are stamped into the generation request's `ctx` —
host-supplied, never model-facing — and the TRIGGER's own detail rides as the
request's `request` field: the user's content, model-facing by right (it
composes the systemTwo user message).

Without a browser attached the reply never arrives and the hold stands —
correct first-pass behavior: no browser, no scale fact, no generation. The
hold is per-trigger and visible in the frontier (`pending_bids` traces show
the scale-join once-thread parked on its transform listener); a second
trigger mints a SECOND pipeline rather than superseding the first.

### The generation lane → `ui_render`

With the preflight passed, the pipeline's generation legs request a systemTwo
response composing the render. The design tenant is an optional input, never
a gate — with a tenant: the token **vocabulary** (the flattened `--design-*`
custom property names, never literal values) rides model-facing and the prose
sections ride as system context (Consumption/F's two lanes); with NO tenant
(user deleted their `DESIGN.md`, or never had one) generation proceeds plain
— structural output, no token context, no artifact — and still produces a
conforming `ui_render`. The scale fact and target ride the request's `ctx`
(host-supplied, never model-facing; the store and systemTwo wires echo `ctx`
verbatim on results — the join lane the pipeline state round-trips through).
The user message composes from the trigger's own detail (`View request: …`)
— the view the user actually asked for, not a host-supplied fixed string.
The generation endpoint is a config seam: `bProgram({ ui: { provider,
modelId } })` names the provider label and model id the pipelines compose
with (unset = the `default`/`gpt-5.1` conventions; a named provider must
carry an entry in the systemTwo endpoint map).

The model composes only the **html fragment**; the id, target, and swap are
host-stamped (the model is never trusted with the envelope). The composed
detail must validate against `CONTROLLER_DETAIL_SCHEMAS`'s `ui_render` schema
**before the thread requests it** (validate-before-request — the catalog
pattern; the root guard is the backstop, not the only gate). A non-conforming
reply is held as data — the draft is selected and visible in traces, never
emitted.

The custom-properties artifact: a tenant-bearing scan also compiles the
tokens to a stylesheet (`--design-<token-path>: <value>;` — `light-dark()`
values pass through verbatim) stored as the `design` collection's `artifact`
value, compiled from the TENANT only, never from the shipped asset. Generated
html references the properties, not literals.

The artifact's serving seam is the `ui_attrs` egress message: a token-bearing
pipeline composes the SAME declarations as the stored artifact — BARE
custom-property declarations (`--design-<token-path>: <value>;`) — as
`ui_attrs { target, attr: { style: <declarations> } }`, applied inline on the
target root; the subtree inherits through the properties. THE OWNERSHIP
CONVENTION: `setAttribute('style', …)` replaces the WHOLE attribute — the
design lane owns the target root's style attribute; generated fragments style
their DESCENDANTS, never the target root. An innerHTML swap PRESERVES the
target's attributes (`replaceChildren` never touches attributes); the
outerHTML case replaces the element — the per-trigger re-issue re-applies.
Emitted BEFORE the `ui_render` when a token-bearing tenant exists; plain (no
tenant, no tokens) emits nothing. ORDERING: the boot design scan is a
standing thread — a render that beats the scan styles PLAIN (no tenant yet,
correct no-lock behavior); the NEXT render styles, once the tenant has
landed. No lock, no wait — the ordering is the artifact of the standing-scan
timing, never a gate. The declarations are jq-deterministic from
validated tenant tokens — no model in the loop, no standing gate (the render
gate exists for MODEL output). MINIMAL: the `=` selector match only (match
variants ride a named need); the store artifact remains the durable record
for other consumers.

### The autoresearch loop

The initial thread set is a **first hypothesis refined by measurement, not
argument**. The capture lane: an in-process RAW `useTrace` consumer
(`src/b-program/ui-capture.ts`, mounted by the socket host — the TUI/start path)
writes each ui-pipeline run to `<home>/captures/ui-runs.jsonl` as
`{ pipeline, startedAt, threads, reentries, messages }`. Runs are LINEAGE-keyed
— keyed by the minted pipeline id parsed from thread labels, correlation ids,
and ctx lineage, never by a time window — so interleaved pipelines attribute
correctly and unrelated faculty traffic stays out of the runs; the standing
Thread set and the position-tagged once-thread re-entries (the minted legs
included — the pump's subscriber-order warp, the mint arriving before the
ingress trace, is handled by lazy binding) ride `thread_added` for free. A run
closes only at its `ui_render` terminus; a held run stays open (the quiescence
flush of incomplete runs is a named later iteration). The replay pass is
`frontier_request { op: 'replay' }` over a captured run (`uiReplayRequest`) —
the divergence view: replay the full run for the end state, or pass a
message-count prefix (e.g. up to just before the browser's scale reply) to
re-derive the hold — where requests blocked and what the frontier looked
like. The graders are consumer-authored; the loop wires the capture and the
replay, nothing more.

## Wiring guidance

- **Wiring a multi-page app**: one `Controller` per page, constructed in the
  page's `<head>` async module. The default carrier derives the WebSocket URL
  from the page's origin (`location.href.replace(/^http/, 'ws')`); pass
  `transport` to inject a different one.
- **Binding interactive elements**: declare `b-trigger` and `b-form`
  attributes in the DOM; the Controller wires them to emit `ui_event`
  messages on user interaction. No manual `addEventListener` in your code.
- **Page lifecycle**: the `onPage*` hooks fire on `pagereveal`/`pageswap`/
  `pagehide`/`pageshow`. The browser owns document-bound teardown (listeners,
  sockets, timers) on unload and bfcache freeze; the Controller does **not**
  force-close the socket on `pagehide` so a queued snapshot can flush during
  teardown.
- **Scale pre-flight**: the agent sends `ui_scale_check` before generating
  content to learn the effective `b-scale` a render target lives in; the
  Controller replies with `ui_scale_check_result` carrying `effectiveScale`.

## A common wiring mistake to avoid

Calling `Controller` methods directly to mutate the DOM. The Controller is a
**message applier**, not a DOM API — `ui_render`/`ui_attrs`/
`ui_dispatch_custom_event`/`ui_navigate` arrive as server-pushed messages and
are dispatched internally, not called by your code. If you find yourself
reaching for a Controller method to change the page, the correct path is to
emit a `ui_event` (via a `b-trigger`/`b-form` declaration) and let the
agent's behavioral program respond with a server-pushed `ui_render`. The DOM
is downstream of the agent, not the other way around.

The second common mistake: expecting the WebSocket to be manually managed.
The Controller handles connect, retry (bounded backoff on close codes
1006/1012/1013 — max 3 attempts, jittered exponential delay capped at
`UI_CORE_MAX_RETRIES` in `controller.constants.ts`), and message queuing
during disconnect (the queue flushes on reconnect) internally. Do not wrap it
in your own reconnection logic — that races with the Controller's built-in
retry.

## See also

- [behavioral](./behavioral.md) — the runtime whose `selection` listeners
  drive the agent side of the `ui_*` wire (the action channel).