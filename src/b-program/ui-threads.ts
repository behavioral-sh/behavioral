/**
 * The ui_* producer threads — the view-generation policy that turns browser
 * ingress (`ui_event`, `ui_snapshot`, `ui_form_submit`) into engine-requested
 * egress (`ui_render`, `ui_attrs`, `ui_navigate`, `ui_scale_check`,
 * `ui_style`).
 *
 * @remarks
 * Composition territory (no process, not a faculty) — mounted by `bProgram`
 * when the set's required faculties are on: shell (the scan recipe's
 * executor), store (the design tenant), systemTwo (generation). Absent
 * systemTwo there is no generation lane and the threads don't mount (the
 * remote-mcp precedent for conditionally-mounted core threads).
 *
 * The initial thread set is a FIRST HYPOTHESIS refined by the autoresearch
 * loop (raw capture + frontier replay, `src/cli/ui-capture.ts`) — every
 * thread derives from a structural concept or a design.md lane
 * (the 2026-09-25 design.md rulings), and anything beyond the thin vertical
 * (event → scale preflight → generation → render) is a named later iteration.
 *
 * The pipeline is PER-TRIGGER: the composition's host leg (b-program's pump)
 * mints one `uiPipelineThreads({ id, detail })` set per `render` ingress —
 * every correlation id is per-trigger (`<id>-scale`/`-tenant`/`-gen`/
 * `-render`/`-style`), so concurrent pipelines interleave without dropping, and the
 * trigger's detail rides the generate request (the user's content,
 * model-facing by right) into the systemTwo user message.
 *
 * MINIMAL notes (greppable ceilings, the upgrade path is the loop):
 * - the scan validates token-group SHAPE only — per-value CSS/dimension
 *   linting is the design.md linter's job (`npx @google/design.md lint`);
 * - the generation trigger is the b-trigger convention `render` (a ui_event
 *   whose inner BPEvent has type `render`); the wider ingress vocabulary
 *   (ui_snapshot rehydration, ui_form_submit) rides later iterations;
 * - the user message renders the trigger detail as compact JSON — a
 *   structured content contract (named fields → message parts) rides the
 *   loop's data.
 *
 * @packageDocumentation
 */

import type { JsonObject, Thread } from '../behavioral/behavioral.types.ts'
import {
  CONTROLLER_INCOMING_MESSAGE_TYPES,
  CONTROLLER_OUTGOING_MESSAGE_TYPES,
  SWAP_MODES,
} from '../controller/controller.constants.ts'
import { CONTROLLER_DETAIL_SCHEMAS } from '../controller/controller.schemas.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The logical scan name — the shell_request trace label. */
export const UI_DESIGN_SCAN_TOOL = 'design-scan'

/** The boot scan call's correlation id — the tenant transform matches on it. */
export const UI_DESIGN_SCAN_CALL_ID = 'ui-design-scan'

/** The store collection holding the design tenant. */
export const UI_DESIGN_COLLECTION = 'design'

/** The tenant's store key — one value, the whole scanned context. */
export const UI_DESIGN_CONTEXT_KEY = 'context'

/** The compiled custom-properties stylesheet's store key (the tenant's tokens → CSS). */
export const UI_DESIGN_ARTIFACT_KEY = 'artifact'

// ── The tenant contract — schema-data: one shape, three uses (thread gate,
//    store admission, model-facing vocabulary derivation) ────────────────────

/**
 * The design tenant — the scanned `<home>/DESIGN.md` as data:
 * `tokens` (the YAML frontmatter groups, unknown groups verbatim; null when
 * absent or rejected), `sections` (the `##` prose sections by title; null
 * when absent or rejected), `warnings` (warnings-as-data, the catalog
 * posture). A null-tokens tenant is the plain-degradation lane: generation
 * proceeds without design context, never gated.
 */
export const UI_DESIGN_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    tokens: { type: 'object', required: [], additionalProperties: true, nullable: true },
    sections: { type: 'object', required: [], additionalProperties: true, nullable: true },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['tokens', 'sections', 'warnings'],
  additionalProperties: false,
} as const

// ── The scan recipe (stored-recipe flavor: the SKILL.md fence-slicing +
//    YAML.parse contract, applied to the home DESIGN.md) ────────────────────

/**
 * The design-scan recipe — executed bun-direct by the shell worker's `run`
 * op (script on stdin).
 *
 * Reads the USER'S `<home>/DESIGN.md` (the no-lock contract: the shipped
 * asset at `skills/behavioral/assets/DESIGN.md` is an init-copied seed; the
 * runtime never reads the asset, never re-syncs it — a replaced or deleted
 * home file fully replaces/removes the design context). Missing file is not
 * an error (the skills-scan posture): the empty shape `{ tokens: null,
 * sections: null, warnings: [] }`, no tenant.
 *
 * Validation is lenient per the design.md consumer table (google-labs-code/
 * design.md, docs/spec.md): unknown frontmatter groups and body sections
 * ride verbatim; spec-named groups (`colors`/`typography`/`rounded`/
 * `spacing`) validate by shape — a malformed group drops with a warning; a
 * duplicate `##` section heading REJECTS the file (the one file-level
 * rejection the table names) — tokens and sections null, the rejection
 * riding the warnings.
 */
export const DESIGN_SCAN_SCRIPT = `
import { homedir } from 'node:os'
import { join } from 'node:path'
import { YAML } from 'bun'

const SPEC_GROUPS = new Map([
  ['colors', 'string'],
  ['typography', 'object'],
  ['rounded', 'dimension'],
  ['spacing', 'dimension'],
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const validTokenValue = (value, groupType) => {
  if (groupType === 'object') return isPlainObject(value)
  if (groupType === 'string') return typeof value === 'string'
  return typeof value === 'string' || typeof value === 'number'
}

const home = process.env.BEHAVIORAL_HOME ?? join(homedir(), '.behavioral')
const out = { tokens: null, sections: null, warnings: [] }

const file = Bun.file(join(home, 'DESIGN.md'))
if (await file.exists()) {
  const text = await file.text()

  // Front matter: the --- fence; the YAML slice ONLY (never the whole file).
  let frontmatter = null
  let body = text
  const fence = text.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/)
  if (fence !== null) {
    body = text.slice(fence[0].length)
    try {
      const parsed = YAML.parse(fence[1])
      if (isPlainObject(parsed)) {
        frontmatter = parsed
      } else {
        out.warnings.push('DESIGN.md frontmatter must be a YAML object; the token groups are dropped')
      }
    } catch {
      out.warnings.push('DESIGN.md frontmatter is unparseable YAML; the token groups are dropped')
    }
  }

  // Body sections: ## headings only (a # title is not a section). A
  // duplicate heading rejects the file (the consumer table's one
  // file-level rejection).
  const sections = new Map()
  let current = null
  let rejected = false
  for (const line of body.split(/\\r?\\n/)) {
    const heading = line.match(/^## (.+)$/)
    if (heading !== null) {
      const title = heading[1].trim()
      if (sections.has(title)) {
        out.warnings.push('Duplicate section heading "## ' + title + '": the file is rejected')
        rejected = true
        break
      }
      current = { title, lines: [] }
      sections.set(title, current)
      continue
    }
    if (current !== null) current.lines.push(line)
  }

  if (!rejected) {
    const sectionMap = {}
    for (const [title, section] of sections) sectionMap[title] = section.lines.join('\\n').trim()
    out.sections = Object.keys(sectionMap).length > 0 ? sectionMap : null

    if (frontmatter !== null) {
      // Spec-named groups validate by shape (a bad group drops with a
      // warning); unknown keys ride verbatim (the consumer table).
      const tokens = {}
      for (const key of Object.keys(frontmatter)) {
        const groupType = SPEC_GROUPS.get(key)
        if (groupType === undefined) {
          tokens[key] = frontmatter[key]
          continue
        }
        const value = frontmatter[key]
        if (
          !isPlainObject(value) ||
          !Object.values(value).every((token) => validTokenValue(token, groupType))
        ) {
          out.warnings.push('Token group "' + key + '" is not a flat map of valid ' + groupType + ' tokens; the group is dropped')
          continue
        }
        tokens[key] = value
      }
      out.tokens = tokens
    }
  }
}
console.log(JSON.stringify(out))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** design-scan-boot — once: the scan recipe is requested at boot; the shell worker pipes it. */
const designScanBoot: Thread = {
  label: 'ui/design-scan-boot',
  once: true,
  rules: [
    {
      request: {
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: {
          id: UI_DESIGN_SCAN_CALL_ID,
          label: UI_DESIGN_SCAN_TOOL,
          input: { op: 'run', script: DESIGN_SCAN_SCRIPT, format: 'json' },
        },
      },
    },
  ],
}

/**
 * design-tenant — a scan result carrying a design context (or a rejected
 * file's warnings) is put into the store as the tenant, and a
 * tenant-bearing result ALSO compiles the custom-properties stylesheet
 * artifact (`--design-<token-path>: <value>;` — the light-dark values pass
 * through verbatim; generated html references the properties, not
 * literals). The empty shape (missing DESIGN.md) puts nothing. Fail-closed:
 * a malformed result fails the detailSchema gate, never partial admission.
 */
const designTenant: Thread = {
  label: 'ui/design-tenant',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | select($d.result.jsonData.tokens != null or $d.result.jsonData.sections != null or ($d.result.jsonData.warnings | length) > 0) | { id: "ui-design-tenant", op: "put", input: { collection: "design", key: "context", value: $d.result.jsonData } }',
          target: FACULTY_MESSAGE_KINDS.store_request,
          // The validate-before-put gate: strict at jsonData (the tenant
          // contract), loose around it (the envelope's schema home is the
          // shell faculty).
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', const: UI_DESIGN_SCAN_CALL_ID },
              result: {
                type: 'object',
                properties: { jsonData: UI_DESIGN_CONTEXT_SCHEMA },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
            additionalProperties: true,
          },
        },
        {
          // The artifact compile: from the TENANT (the user's tokens), only
          // when a tenant exists — never from the shipped asset.
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query: `. as $d | ($d.result.jsonData.tokens) as $t | { id: "ui-design-artifact", op: "put", input: { collection: "${UI_DESIGN_COLLECTION}", key: "${UI_DESIGN_ARTIFACT_KEY}", value: { css: (":root {\n" + ([ ($t | paths(scalars)) as $p | "  --design-" + ($p | join("-")) + ": " + ($t | getpath($p) | tostring) + ";" ] | join("\n")) + "\n}") } } }`,
          target: FACULTY_MESSAGE_KINDS.store_request,
          // Only a tenant-bearing result compiles (tokens non-null); the
          // id gate keeps foreign scan results out.
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', const: UI_DESIGN_SCAN_CALL_ID },
              result: {
                type: 'object',
                properties: {
                  jsonData: {
                    type: 'object',
                    properties: {
                      tokens: { type: 'object', required: [], additionalProperties: true },
                      sections: { type: 'object', required: [], additionalProperties: true, nullable: true },
                      warnings: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['tokens', 'sections', 'warnings'],
                    additionalProperties: false,
                  },
                },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
            additionalProperties: true,
          },
        },
      ],
    },
  ],
}

// ── The per-trigger pipeline — the dispatcher's mint ─────────────────────────
//
// Structural IA/E (fixed mechanism, thread-authored policy) + the concurrency
// fix: ONE standing pipeline dropped concurrent triggers and lost the
// trigger detail at the scale-check round trip. The shape is now a dispatcher
// (the composition's host leg — b-program's pump, the admission-path
// precedent: it joins the render ingress and addThreads the set under the
// re-entry law) + per-trigger once-threads, each carrying its whole pipeline
// in pure data: the correlation ids are per-trigger, the joins are the
// echoed id (the controller wire carries no ctx) and ctx.echo (the store and
// systemTwo wires echo it verbatim — both lanes exist), and the trigger's
// detail rides the generate request into the user message.

/** The generation trigger's event type — the b-trigger convention (`b-trigger="click:render"`). */
export const UI_RENDER_TRIGGER_TYPE = 'render'

/**
 * The generation request's event type — thread-owned, NOT a controller
 * `ui_*` message (the egress fan-out emits `ui_*` selections to clients; the
 * pipeline's own vocabulary stays off that wire).
 */
export const UI_GENERATE_EVENT_TYPE = 'generate'

/** The default render target when the trigger detail carries none. */
export const UI_RENDER_TARGET = 'body'

/** The render swap mode the pipeline composes with. */
export const UI_RENDER_SWAP: (typeof SWAP_MODES)[keyof typeof SWAP_MODES] = SWAP_MODES.innerHTML

/** The render draft's event type — the model's composition, held as data before the gate. */
export const UI_RENDER_DRAFT_TYPE = 'render_draft'

/**
 * The generation request's detail — the scale-stamped trigger. The effective
 * scale and target ride `ctx` (host-supplied facts, never model-facing —
 * the Consumption/F lane); `echo.pipeline` carries the per-trigger lineage;
 * `request` is the TRIGGER's OWN detail — the user's content, model-facing
 * by right (it composes the systemTwo user message; the ctx echo lane is
 * only its transport between pipeline legs).
 */
export const UI_GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    ctx: {
      type: 'object',
      properties: {
        scale: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        echo: {
          type: 'object',
          properties: { pipeline: { type: 'string', minLength: 1 } },
          required: ['pipeline'],
          additionalProperties: true,
        },
      },
      required: ['scale', 'target', 'echo'],
      additionalProperties: true,
    },
    request: { type: 'object', required: [], additionalProperties: true },
  },
  required: ['ctx'],
  additionalProperties: false,
} as const

/**
 * The DEFAULT generation endpoint's provider label — the composition config
 * seam's fallback (`bProgram({ ui: { provider, modelId } })` overrides both;
 * the host's endpoint map must carry whatever label is configured:
 * `useSystemTwo({ endpoints: { <provider>: … } })`).
 */
export const UI_GENERATION_PROVIDER = 'default'

/** The default generation model id — the config seam's fallback. */
export const UI_GENERATION_MODEL_ID = 'gpt-5.1'

/** The generation composition contract — the plain lane (no tenant). */
const GENERATION_INSTRUCTIONS =
  'Compose the HTML fragment for the requested UI view. Reply with ONLY the HTML fragment — no prose, no code fences, no explanation.'

/**
 * Mint one per-trigger pipeline — the set the composition's host leg adds on
 * a `render` ingress (the admission-path precedent: the host composes the
 * pure-data threads; `addThread`'s own ThreadSchema gate is the backstop —
 * there is no wire proposal to validate, the factory is trusted host code).
 *
 * The legs (all once-threads, label `ui/pipeline:<id>/<leg>` — the label is
 * the capture's lineage key):
 *
 * - **scale-issue** — requests the `ui_scale_check` under `<id>-scale` (the
 *   controller resolves the DOM fact and replies; the echoed id is the join).
 * - **scale-join** — the correlated reply stamps the `generate` request:
 *   scale+target via ctx, the pipeline lineage via `ctx.echo.pipeline`, the
 *   trigger's detail as `request`. Without a browser the reply never arrives
 *   and this thread parks on its transform listener — the per-trigger hold,
 *   visible in the frontier (no block is needed: this join is the ONLY path
 *   to a generate, so the in-flight discipline is structural).
 * - **context-issue** — the generate fetches the design tenant; the WHOLE
 *   generate detail rides the store request's `ctx.echo` (the join lane).
 * - **generation-compose** — the tenant-bearing (or null) store result
 *   composes the systemTwo request: with a tenant the token VOCABULARY (the
 *   flattened `--design-*` names, never literal values) rides model-facing
 *   and the prose rides system context; the trigger's detail composes the
 *   user message; with NO tenant the request composes plain — the design
 *   lane is an optional input, never a gate.
 * - **style-issue** — a token-bearing tenant ALSO composes the scoped
 *   style: the compiled `--design-*` declarations wrapped in an `@scope`
 *   block rooted on the render target's `b-target` selector (`:scope`
 *   carries the properties; the subtree inherits them — Baseline 2026,
 *   older engines drop the block, plain degradation). The css is
 *   jq-deterministic from validated tenant tokens — no model in the loop, no
 *   standing gate needed (the render gate exists for MODEL output); emitted
 *   before the render, idempotent per target on the browser side. MINIMAL:
 *   the `=` selector match only (match variants ride a named need).
 * - **render-compose** — the model reply composes the render draft: id,
 *   target, and swap are host-stamped (the model is never trusted with the
 *   envelope); only the html is model-composed. The standing render-gate
 *   (below) validates the draft and requests the `ui_render`.
 *
 * The trigger detail is baked into the queries via `JSON.stringify` splices
 * — inert JSON literals to jq's parser (the shell threads' script-splicing
 * precedent), never string interpolation of raw content.
 */
export const uiPipelineThreads = ({
  id,
  detail,
  provider,
  modelId,
}: {
  id: string
  detail: JsonObject
  /** The generation endpoint's provider label — defaults to {@link UI_GENERATION_PROVIDER}. */
  provider?: string
  /** The generation model id — defaults to {@link UI_GENERATION_MODEL_ID}. */
  modelId?: string
}): Thread[] => {
  const target = typeof detail.target === 'string' && detail.target.length > 0 ? detail.target : UI_RENDER_TARGET
  const generationProvider = provider ?? UI_GENERATION_PROVIDER
  const generationModelId = modelId ?? UI_GENERATION_MODEL_ID
  const scaleId = `${id}-scale`
  const tenantId = `${id}-tenant`
  const genId = `${id}-gen`
  const renderId = `${id}-render`

  /** The per-trigger generate listener — UI_GENERATE_SCHEMA with the pipeline const baked in. */
  const generateListenerSchema = {
    ...UI_GENERATE_SCHEMA,
    properties: {
      ...UI_GENERATE_SCHEMA.properties,
      ctx: {
        ...UI_GENERATE_SCHEMA.properties.ctx,
        properties: {
          ...UI_GENERATE_SCHEMA.properties.ctx.properties,
          echo: {
            ...UI_GENERATE_SCHEMA.properties.ctx.properties.echo,
            properties: { pipeline: { type: 'string', const: id } },
          },
        },
      },
    },
  } as const

  const scaleIssue: Thread = {
    label: `ui/pipeline:${id}/scale-issue`,
    once: true,
    rules: [
      {
        request: {
          type: CONTROLLER_INCOMING_MESSAGE_TYPES.ui_scale_check,
          detail: { id: scaleId, target, swap: UI_RENDER_SWAP },
        },
      },
    ],
  }

  const scaleJoin: Thread = {
    label: `ui/pipeline:${id}/scale-join`,
    once: true,
    rules: [
      {
        transform: [
          {
            type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_scale_check_result,
            detailSchema: {
              type: 'object',
              properties: { id: { type: 'string', const: scaleId } },
              required: ['id'],
              additionalProperties: true,
            },
            query: `. as $d | { ctx: { scale: $d.effectiveScale, target: ($d.target // "${target}"), echo: { pipeline: "${id}" } }, request: ${JSON.stringify(detail)} }`,
            target: UI_GENERATE_EVENT_TYPE,
          },
        ],
      },
    ],
  }

  const contextIssue: Thread = {
    label: `ui/pipeline:${id}/context-issue`,
    once: true,
    rules: [
      {
        transform: [
          {
            type: UI_GENERATE_EVENT_TYPE,
            detailSchema: generateListenerSchema,
            query: `. as $d | { id: "${tenantId}", op: "get", input: { collection: "${UI_DESIGN_COLLECTION}", key: "${UI_DESIGN_CONTEXT_KEY}" }, ctx: { echo: $d } }`,
            target: FACULTY_MESSAGE_KINDS.store_request,
          },
        ],
      },
    ],
  }

  const styleIssue: Thread = {
    label: `ui/pipeline:${id}/style-issue`,
    once: true,
    rules: [
      {
        transform: [
          {
            type: FACULTY_MESSAGE_KINDS.store_request_result,
            detailSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', const: tenantId },
                ok: { type: 'boolean', const: true },
                result: {
                  type: 'object',
                  properties: {
                    value: {
                      type: 'object',
                      properties: {
                        // Only a TOKEN-BEARING tenant styles — the plain
                        // lane (null tenant, null tokens) emits nothing.
                        tokens: { type: 'object', required: [], additionalProperties: true },
                      },
                      required: ['tokens'],
                      additionalProperties: true,
                    },
                  },
                  required: ['value'],
                  additionalProperties: true,
                },
                ctx: {
                  type: 'object',
                  properties: { echo: { type: 'object', required: [], additionalProperties: true } },
                  required: ['echo'],
                  additionalProperties: true,
                },
              },
              required: ['id', 'ok', 'result', 'ctx'],
              additionalProperties: true,
            },
            query:
              `. as $d | ($d.ctx.echo) as $e | ($d.result.value.tokens) as $t` +
              ` | {` +
              `    id: "${id}-style",` +
              `    target: $e.ctx.target,` +
              `    css: ("@scope ([b-target=\\"" + $e.ctx.target + "\\"]) {\\n  :scope {\\n" + ([ ($t | paths(scalars)) as $p | "    --design-" + ($p | join("-")) + ": " + ($t | getpath($p) | tostring) + ";" ] | join("\\n")) + "\\n  }\\n}"),` +
              `  }`,
            target: CONTROLLER_INCOMING_MESSAGE_TYPES.ui_style,
          },
        ],
      },
    ],
  }

  const generationCompose: Thread = {
    label: `ui/pipeline:${id}/generation-compose`,
    once: true,
    rules: [
      {
        transform: [
          {
            type: FACULTY_MESSAGE_KINDS.store_request_result,
            detailSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', const: tenantId },
                ok: { type: 'boolean', const: true },
                result: {
                  type: 'object',
                  properties: { value: { type: 'object', required: [], additionalProperties: true, nullable: true } },
                  required: ['value'],
                  additionalProperties: true,
                },
                ctx: {
                  type: 'object',
                  properties: { echo: { type: 'object', required: [], additionalProperties: true } },
                  required: ['echo'],
                  additionalProperties: true,
                },
              },
              required: ['id', 'ok', 'result', 'ctx'],
              additionalProperties: true,
            },
            query:
              `. as $d | ($d.ctx.echo) as $e | ($d.result.value) as $v` +
              ` | (if $v == null then null else ($v.tokens // null) end) as $tokens` +
              ` | (if $v == null then null else ($v.sections // null) end) as $sections` +
              ` | (if $tokens == null then [] else [ ($tokens | paths(scalars)) as $p | "--design-" + ($p | join("-")) ] end) as $vocab` +
              ` | {` +
              `    id: "${genId}",` +
              `    ctx: { scale: $e.ctx.scale, target: $e.ctx.target, pipeline: "${id}" },` +
              `    input: {` +
              `      provider: "${generationProvider}",` +
              `      modelId: "${generationModelId}",` +
              `      instructions: (` +
              `        "${GENERATION_INSTRUCTIONS}"` +
              `        + (if ($vocab | length) > 0 then "\\n\\nReference these CSS custom properties by name — never literal values: " + ($vocab | join(", ")) else "" end)` +
              `        + (if $sections == null then "" else "\\n\\nDesign rationale:\\n\\n" + ([ $sections | to_entries[] | "## " + .key + "\\n\\n" + (.value // "") ] | join("\\n\\n")) end)` +
              `      ),` +
              `      input: [ { type: "message", role: "user", content: ("View request: " + (($e.request // {}) | tostring)) } ],` +
              `    },` +
              `  }`,
            target: FACULTY_MESSAGE_KINDS.system_two_request,
          },
        ],
      },
    ],
  }

  const renderCompose: Thread = {
    label: `ui/pipeline:${id}/render-compose`,
    once: true,
    rules: [
      {
        transform: [
          {
            type: FACULTY_MESSAGE_KINDS.system_two_request_result,
            detailSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', const: genId },
                ok: { type: 'boolean', const: true },
                ctx: {
                  type: 'object',
                  properties: { target: { type: 'string', minLength: 1 } },
                  required: ['target'],
                  additionalProperties: true,
                },
              },
              required: ['id', 'ok', 'ctx'],
              additionalProperties: true,
            },
            query: `. as $d | ([ $d.result.items[]? | select(.type == "message") | .content[]? | select(.type == "output_text") | .text ] | join("")) as $text | { id: "${renderId}", target: $d.ctx.target, html: (if ($text | length) > 0 then $text else null end), swap: "${UI_RENDER_SWAP}" }`,
            target: UI_RENDER_DRAFT_TYPE,
          },
        ],
      },
    ],
  }

  return [scaleIssue, scaleJoin, contextIssue, styleIssue, generationCompose, renderCompose]
}

/**
 * render-gate — validate-before-request (the catalog pattern): the draft must
 * conform to the controller's `ui_render` detail schema — CONTROLLER_DETAIL_SCHEMAS's
 * own schema, derived never hand-mirrored — before the thread requests the
 * render. The root guard is the backstop; this is the gate. A non-conforming
 * draft is held as data (selected, visible in traces, never emitted).
 */
const renderGate: Thread = {
  label: 'ui/render-gate',
  rules: [
    {
      transform: [
        {
          type: UI_RENDER_DRAFT_TYPE,
          detailSchema: CONTROLLER_DETAIL_SCHEMAS[CONTROLLER_INCOMING_MESSAGE_TYPES.ui_render],
          query: `. as $d | { id: $d.id, target: $d.target, html: $d.html, swap: $d.swap }`,
          target: CONTROLLER_INCOMING_MESSAGE_TYPES.ui_render,
        },
      ],
    },
  ],
}

/**
 * The ui_* producer threads' STANDING set — what `bProgram` mounts with shell
 * + store + systemTwo: the boot design scan, the tenant + artifact compile,
 * and the render gate. The pipeline itself is per-trigger
 * ({@link uiPipelineThreads}, minted by the composition's host leg).
 */
export const uiThreads: Thread[] = [designScanBoot, designTenant, renderGate]
