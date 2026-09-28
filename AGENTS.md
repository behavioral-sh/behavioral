# AGENTS.md

## Rules

# Bun APIs

**Prefer Bun over Node.js** when running in Bun environment.

**File system:** `Bun.file(path).exists()`, `.text()`, `.json()`, `.bytes()` — not `node:fs`. `Bun.write(path, data)` — not `writeFileSync`.
**Shell:** prefer `Bun.$\`cmd\`` with `.cwd()`, `.nothrow()`, `.quiet()` for repo scripts. Use `Bun.spawn()` only when lower-level process control is actually needed (IPC, manual stdin streaming, detached/background child management, explicit stdio descriptors).
**Path:** `Bun.resolveSync()` for modules, `import.meta.dir` for current dir. Keep `node:path` for join/resolve/dirname.
**Executables:** `Bun.which(cmd)` to check existence. `bunx` not `npx`.
**When Node.js OK:** readline, node:path, APIs without Bun equivalents.
**Varlock-backed env:** when repo commands need secrets, use `.env.schema` and Varlock-injected
environment variables. Avoid brittle nested shell quoting for authenticated calls.
**Web research:** use the `you` skill for web search, research, and content extraction when
repo-local evidence is insufficient or current external context is needed.

# Workflow

## Git as Context

**Read history before working** — `git log --oneline -20` at session start.
**File history** — `git log --oneline -- <path>` to understand why.
**Branch scope** — `git diff main...HEAD --stat` for current changes.
**History over stale prose** — code + git history wins. Update the doc.

## Git Commits

**Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`
**Multi-line messages** for detailed context. **Never --no-verify**.
**Wrap commit body lines at 100 chars or less** to satisfy commitlint.
**Prefer a commit message file for multi-line commits** (`git commit -F /tmp/message.txt`) so body
wrapping is visible before hooks run. Use repeated `-m` flags only for short body lines already
checked to be 100 chars or less.
**Do not retry a failed commit with the same message shape** after commitlint rejects it. Rewrite
the message with wrapped body lines first.

**Git lock recovery:** if `/.git/index.lock` is present, first assume an interrupted or overlapping
Git operation rather than corruption. Check that no Git process is still running, then remove the
stale lock with `rm -f .git/index.lock` before retrying. Avoid starting a new commit while hook
formatters or other Git operations are still in flight.

## Pull Requests

**Template required** — before opening or editing a PR, read `.github/pull_request_template.md`
and preserve every required heading exactly.
**Check after editing** — after opening or editing a PR, run
`gh pr checks <pr-number> --repo behavioral-sh/behavioral`.
**Fix description lint** — if `pr-description-lint` fails, inspect the failing job with
`gh run view` and update the PR body with `gh pr edit` until the required heading check passes.

## Code Quality Gate

Before committing code, choose validation based on area of effect. Bun is the default test runner.

Minimum gate:
1. `bun --bun tsc --noEmit`
2. targeted tests for the changed surface

Use broader validation when runtime behavior, tool behavior, schemas/validators, shared
infrastructure, or any broad/uncertain surface changes. Use the minimum gate when the change is
tightly bounded and verified by inspection or code search, or is path-only rename, link/reference
cleanup, wording-only docs/skills text, or another edit that does not materially change executable
faculty. If you choose targeted tests, state the scope and why the narrower gate suffices.

Broader validation is still area-aware — it does not mean "run unrelated tests." Examples: if
`skills/<name>/scripts` changed, run that skill's tests plus shared `src/` tests those scripts
depend on; if a `src/<feature>` CLI command changed, run that feature's tests plus CLI/schema
tests; if only `src/controller/` changed, run the controller test surfaces; if shared code changed
and the impact is broad or unclear, expand coverage until the affected surface is credibly covered.

`docs:` and `chore:` commits may skip executable validation when they do not change
behavior.

## Directory Boundaries

**`src/actuators/`** — the daemon-side capability layer: the baked-in trio,
FLAT — no faculty subfolders. The process entries are dot-suffixed
(`shell.actuator.ts` — bun-direct script execution — `run` op TS scripts via
`bun run -`, `shell` op Bun Shell commands through the wrapper; `rpc` op
generic remote JSON-RPC — the remote-mcp layering is the threads, not the op;
temp-file payloads over ~100KB, deleted on every exit; `rpc.client.ts`),
`store.actuator.ts` (durable space-scoped persistence), and
`security.actuator.ts` (the cross-cutting credential/policy actuator:
`keychain-oauth-provider.ts` is the issuer-bound OAuth `BunKeychain`
over `Bun.secrets`; it vends `credential_request` → `credential_result` —
broker env-data first, keychain floor second). Each actuator ships ONLY its
process entry (`<name>.actuator.ts`) + implementation tests (in `tests/` —
`<name>.actuator.spec.ts` et al.) — no threads
(threads are composition-side, in `src/faculties/<name>/`), no overrides
(baked-in, never overridable; the config's `actuators` array is the explicit
allow-list of the trio ONLY), no external provider entries. The shared spawn
primitive (`use-actuator.ts` — spawn, wire in/out, exit-code crash synthesis
as `faculty_error`, respawn on demand, terminate; no schema compilation — the
wire home's once-compiled validators flow in), the shared spec harness
(`tests/`), and `instance-lock.ts` (the `<home>/instance.pid`
single-instance lock) live here; `process-lane.ts` stays in `src/faculties/`
until the composition graph's `bindEmit` import moves to the emit seam (the
shelf's `emit-lane` extraction).
Dependency arrow: actuators → faculties for the wire + policy types, never
the reverse; the browser never calls an actuator.
**`src/faculties/`** — the browser-side thinking layer: the frontier embed
plus the system faculties and every thread pack + the wire. Shared modules
sit at the top: the faculty event wire (`faculties.types.ts` +
`faculties.constants.ts` — every request/result event kind, validators
(compiled once here, both sides reference), and the kind registry), the
spawn primitive the system faculties wire through (`use-faculty.ts` —
Bun.spawn processes speaking the wire over stdio lines; it compiles the
faculty's event schemas and returns them so the composition derives guard
threads; exit-code crash synthesis as `faculty_error`; respawn on demand),
the process lane (`process-lane.ts` — stdio emit/inbound, the envData
bridge, bindEmit for the frontier embed), `behavioral-home.ts` (the
`BEHAVIORAL_HOME` root), `resolve-faculty-entry.ts` (bundled/absolute/
home-relative provider-entry paths — the system faculties' endpoint
surface; baked-in actuators never resolve external entries), and
`faculties.threads.ts` (the composition's root guard threads).
The browser faculties live in their own subfolders — `threads.ts` (their
thread packs), `types.ts`/`schemas.ts`, `config.ts` (the system faculties),
plus their `tests/`:
- `system-two/` — Open Responses model calls; a provider entry —
  `configSystemTwo(respond)` wires it, `useSystemTwo({ endpoints })` seeds the
  endpoint map
- `system-one/` — TypeSafe/OpenRouter Decisions; `configSystemOne` +
  `useSystemOne({ endpoint })`, with 429/529 retry; `threads.ts` — the
  admission judgment threads (the BP-native blocking judge over the Decisions
  lane; the composition mounts it when systemOne is wired) and the supervision
  threads (the runtime circuit breaker — the counting supervisor, its
  block-then-judge verdict, and its recovery; `bProgram({ supervision })`
  mounts the pack with systemOne when the host names watched types; a
  root-mounted supervisor's block is global — one space's runaway loop halts
  the watched type everywhere — while a space-stamped supervisor set
  confines, expressible but not built)
- `frontier/` — the in-process embed — imported and driven by the composition;
  standalone spawns are a compatibility entry
Each browser faculty owns its event types + input boundary; results echo the
request `space`; op runners errors-as-data. The daemon trio's capability
prose lives under `src/actuators/` above — the two directories, one
capability: faculties think (browser), actuators act (daemon).
**`src/tools/`** — deleted (fleet 0): the ICL conversion retired the CLI tool
fleet. Remote MCP is remote-mcp threads over the shell faculty's
generic `rpc` op (`src/faculties/shell/remote-mcp.threads.ts` — the retired
`mcp` faculty's replacement; the official SDK dependency is gone);
skill/plugin operations are the shell faculty's threads
(`src/faculties/shell/threads.ts` + `src/faculties/shell/plugin-threads.threads.ts` —
the plugin-thread proposal path: a host proposal → worker import → engine-ThreadSchema
validation → one `add_thread` candidate per validated export) + recipes + store,
taught by `skills/skill-conventions/`.
**`src/faculties.ts`** — the faculties public surface (package export `./faculties`): the
`Actuator` union (the `bProgram` `actuators` allow-list — the trio only), the wire
types + JSON schemas/validators (`faculties.types.ts`), the override thread
threads (`shellThreads`), their schemas/types, `useFaculty`, and the
System One/Two config surface (`configSystemOne`/`useSystemOne`,
`configSystemTwo`/`useSystemTwo`) — what a
`config.ts` imports to compose. (`facultiesThreads`, the default root threads, is internal.)
**`src/b-program/`** — the composition home (`src/b-program.ts` boundary, the `src/controller.ts`
precedent): the host-agnostic runtime composition `bProgram` (`b-program/b-program.ts` — the
in-process engine + frontier embed, the capability spawns, the thread mounts) and its specs
(`tests/`). The bProgram worker entry (the browser's per-tab composition worker) joins this home
with the browser-shape work; the `src/cli/` boundary shrinks to host entries (serve,
attach-or-start, socket-host), config/init, and the TUI.
**`src/behavioral/`** — the pure language layer: types, constants, utils, the interpreter core
(`behavioral.ts`), and its internal jq subprocess (`jq.worker.ts` — engine-internal, wire-external;
nothing outside behavioral/ speaks its wire). Zero process entries that speak the faculty wire —
dependency arrow is one-way: `src/faculties/` → `src/behavioral/`.
**`src/controller/`** — the browser Controller: a validation-free dumb relay over an injectable
Transport, plus `controller.utils.ts` (DelegatedListener, swapBoundary, the deterministic floors
`isInvalidTrigger`/`detectXssVectors`) and render-time scale error-back. `controller.schemas.ts`
holds the AJV detail schemas for the `ui_*` wire shapes — imported by the host/threads, never
the browser bundle (types in `controller.types.ts`, schemas in the separate file). The
controller owns no AJV at runtime; its floors are hardcoded invariants (on*, malformed
b-trigger, scale mismatch).
**`src/cli/`** — the `behavioral` CLI framework (`makeCliRouter`/`parseCli`) and its commands,
registered in `bin/behavioral.ts`. `init` (`src/cli/init.ts`) generates
`<home>/config.ts` (+ optional provider entries under `<home>/providers/`):
interactive tour by default at a TTY (injectable `ask` collector), agent JSON
otherwise; api keys ride as env-var-name references, never literals. The
`behavioral tools` fleet dispatcher is retired with the
fleet (0 tools); turn/config commands land here as the composition rulings build out. The
JSON-RPC IPC host lives here too: `b-program.ts` (the runtime composition, `bProgram`),
`json-rpc.ts` (the line codec), `serve.ts` (the `serve`
entry — ingress messages → triggers, `ui_*` selections → client notifications, redacted
traces out), `load-config.ts` (`<BEHAVIORAL_HOME>/config.ts`), `trace-consumer.ts`, and
`plugin-thread-registry.ts` (the plugin-thread admission registry under `<home>` —
host-local, keyed (plugin, file, content hash, space): `bProgram` mounts admitted
snapshots at boot, decided keys never re-adjudicate), and `ui-threads.ts` (the
`ui_*` producer threads — the view-generation policy: the standing design.md
scan → store tenant + artifact compile + render gate, plus the per-trigger
pipeline factory `uiPipelineThreads` (six once-threads minted by b-program's
pump on each `render` ingress — scale preflight, generation, `ui_render`,
the scoped `ui_style` serving seam, every correlation id per-trigger); mounted with shell + store + systemTwo,
composition territory — no process, not a faculty), and `ui-capture.ts` (the
autoresearch loop's capture side — the in-process lineage-keyed raw run
consumer + the frontier replay builder; the socket host wires its file sink
under `<home>/captures`).
**`src/utils/`** — shared pure utilities.
**`src/faculties/<faculty>/threads.ts`** — composition-side thread packs:
`shell/threads.ts` (the ICL threads — skill/plugin scans, catalog/manifest
schema gates, links dispatchers + stored recipes), `shell/rpc-auth.threads.ts`
(the credential vend-and-replay spine), `shell/remote-mcp.threads.ts` (the MCP
layering over the rpc op), `shell/plugin-threads.threads.ts` (the plugin-thread
proposal path — dispatcher, import join, candidate carry, add_thread dispatch),
and `system-one/threads.ts` (the admission judgment threads + the supervision
threads — the runtime circuit breaker, its judgment, and its recovery).
Threads are composition-side; actuators ship without theirs. `bProgram`
mounts a faculty's threads when the faculty and its required faculties are
on — except `faculties.threads.ts`, the composition's **root guard
threads**, always mounted regardless of the allow-list. The
former `src/threads/` is dissolved; its engine-layer specs live with their
faculties (`src/faculties/<faculty>/tests/`), while specs for the shared modules
stay in `src/faculties/tests/`.
**`tasks/`** — Harbor skill-authoring task specs (challenge content; not shipped, not a plugin).
**`scripts/`** — repo setup and package-maintenance shell glue.
**`skills/`** — published reference skills.
**`.agents/skills/`** — workspace-installed skills.

**CLI features** — a `makeCli` JSON-in/JSON-out command is exported through its `src/cli/<feature>.ts`
module and registered in `bin/behavioral.ts`. Invoke as `behavioral <command> '<json>'`; each
command supports `--schema <input|output>`, `--dry-run`, `--help`.

## GitHub CLI

**Always use `gh` for GitHub URLs** — `gh api`, `gh pr view`, `gh issue view`. Never WebFetch for GitHub content.

# Context Repository

**Source of Truth Hierarchy:**

| Source | Role |
|--------|------|
| `src/` code + types | What the system IS |
| `git log` | Why it changed |
| `AGENTS.md` | How to work here (rules) |
| `docs/*.md` | Design rationale (verify against code) |
| `skills/` | Implementation patterns + operational tools |

**When sources conflict:** Code + git history wins. Update the stale doc.

**Keep docs in sync:** When code changes affect docs, update in the same commit.

# Module Organization

**No index.ts** — rename to feature name.
**Explicit .ts extensions** — `import { x } from './file.ts'`
**Re-export at boundaries** — parent `feature.ts` re-exports from `feature/feature.ts`.
**No internal barrel duplicate** — keep the outer boundary file like `src/feature.ts`, but do not add an extra
`src/feature/feature.ts` barrel when direct exports from concrete files are clearer.
**Helpers first** — define helper consts/functions BEFORE their first reference.
**Direct imports** — import from specific files, not through re-exports within a module.

**File naming:**
- Shared files use module prefix: `feature.types.ts`, `feature.schemas.ts`, `feature.utils.ts`, `feature.constants.ts`
- Feature files use dash-case: `resolve-relative-path.ts`, `limit-text-bytes.ts`, `key-mirror.ts`
- Name the file after its primary export: `resolveRelativePath` → `resolve-relative-path.ts`
- Main entry uses module name: `behavioral.ts`, `server.ts`, `controller.ts`
- **Never prefix feature files with the directory name** — the directory already provides context

**File organization:**
- `feature.types.ts` — types only
- `feature.schemas.ts` — `JSONSchemaType<T>` schemas + AJV-compiled validators
- `feature.constants.ts` — constants
- `feature.ts` — main implementation

# Testing

**Use `test` not `it`**. **Organize with `describe`**.
**No conditional assertions** — assert condition first, then value.
**Test both branches** — try/catch, conditionals, fallbacks need both paths.
**Use real dependencies** — prefer installed packages over mocks.
**Coverage:** happy path, edge cases, error paths, real integrations.
**Run:** choose tests by affected surface. Do not run unrelated areas just to satisfy a blanket rule.
Expand test coverage when the impact is broad, shared, or uncertain.

# Accuracy

**95% confidence threshold** — report uncertainty rather than guess.
**Verification first** — read files before stating implementation details.
**When uncertain:** state the discrepancy, explain why, present to user. Never invent solutions.
**TypeScript verification** — use the `lsp` skill for type-aware analysis (hover, references, definitions, symbols, exports, find).

# Core Conventions

**Type over interface** — `type User = {` not `interface User {`
**No any** — use `unknown` with type guards. At external boundaries (file/network/IPC/event-detail
payloads), validate with AJV: define a `JSONSchemaType<T>` and compile with `ajv.compile` (the shared
instance in `src/behavioral/behavioral.types.ts`; thread `detailSchema` gates and faculty
input boundaries are the pattern homes). Trust the validated value downstream.
**PascalCase types** — schemas get `Schema` suffix.
**Schemas are AJV, not Zod.** Define wire shapes as `JSONSchemaType<T>` and compile with the shared
`ajv` instance. Prefer structural schemas (`oneOf` branches, strict `additionalProperties: false` at
every level) so constraints are explicit and JSON-schema replay contracts stay aligned. Do not
hand-maintain a parallel Zod shape alongside an AJV one. Schema-data is exported for reuse (the
catalog/manifest/recipe contracts in `src/faculties/shell/threads.ts`).
**No cross-module schema drift.** When a CLI command returns a shape produced by another module,
the output schema must derive from or reference that module's exported schema —
not be hand-mirrored. Failure mode: a module's output type changes; a downstream CLI/tool schema
silently rejects the new field (`additionalProperties: false` bites). Fix: one JSON-schema home for
the shape (e.g. a faculty's event schema in `src/faculties/faculties.types.ts`), consumed
downstream via `.schema` or export.
**CLI schema reflection uses AJV.** The `makeCliRouter`/`parseCli` framework in `src/cli/cli.ts`
reflects command schemas via `--schema input|output` — schemas are `JSONSchemaType<T>` objects,
so reflection is `JSON.stringify(schema)`. The CLI AJV instance (`useDefaults: true`) matches
Zod's `.default()` faculty; otherwise it is identical to the shared AJV.
**Arrow functions** — `const fn = () =>` over `function fn()`.
**Object params >2 args** — `fn({ a, b, c }: { ... })`.
**Private fields** — `#field` (ES2022) not `private field`.
**JSON imports** — `import x from 'file.json' with { type: 'json' }`.
**@ts-ignore needs description** — `// @ts-ignore - reason here`.
**Behavioral handlers:** do not use local `try/catch` for validation or side-effect errors
inside `addHandler`/feedback handlers unless explicitly converting a known domain failure into a
normal result event. Let behavioral publish `feedback_error` snapshots for handler failures.
**Mermaid diagrams only** — no ASCII box-drawing.

## Minimal-Implementation Directive

Before writing code, resolve the task at the FIRST step that holds:
1. Does this capability need to exist for the stated task? If it is speculative, do not build it.
   Say so in one sentence and stop.
2. Does something already in THIS codebase do it? Reuse it. Read before you write;
   re-implementing a helper that lives three files over is the most common waste.
   Check `src/utils.ts` first (`keyMirror`, `deepEqual`, `isTypeOf`, `trueTypeOf`, `ueid`,
   case conversion, `htmlEscape`, `wait`); read `src/utils.ts` (it re-exports `src/utils/`) to
   explore its exports when uncertain.
3. Does the standard library or the runtime/platform already do it? (`<input type="date">`, a DB
   unique constraint, a CSS rule.) Use it.
4. Does an already-installed dependency do it? Use it. Do not add a new dependency for something
   a few lines cover.
5. Can it be one clear expression? Write the one expression.
6. Otherwise: the smallest code that fully handles the task.

NON-NEGOTIABLE FLOOR — none of the steps above may remove any of these, and "minimal" is never
a reason to drop them:
- input validation at trust boundaries (anything crossing a process, network, file, or user edge),
- error handling that prevents data loss or silent corruption,
- authn/authz and other security checks,
- accessibility for anything a human interacts with.

If a step would require cutting one of these, that step does not apply.

Leave exactly one runnable check behind for any non-trivial logic.
Mark deliberate shortcuts with a `MINIMAL:` comment naming the ceiling and the upgrade path,
so "later" is greppable instead of forgotten.

## Runtime Wiring Style

Prefer direct callsite wiring when logic is local, stable, and used once.

- Do not add wrapper helpers that only rename or pass through one existing function; do not
  extract one-off shell commands, single-use handlers, or small runtime checks into local
  helpers just to "clean up" a callsite. Inline unless the extraction removes real duplication or
  improves correctness.
- Do not replace a short set of direct event registrations with forwarding maps or event
  lists unless there is a demonstrated maintenance benefit.
- Keep runtime boundary code explicit at callsites: IPC handlers, event-emitter wiring, path
  resolution at security-sensitive boundaries, process lifecycle wiring.
- Prefer tests that exercise the real runtime boundary (process, IPC, event, lifecycle) over
  helper-only tests that bypass the contract. Small abstractions are justified only when they
  remove real cross-callsite duplication, materially improve correctness, encode a real domain
  concept, or improve testing without hiding the runtime contract.
