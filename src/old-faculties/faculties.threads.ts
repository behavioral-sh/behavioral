import type { Thread } from '../behavioral/behavioral.types.ts'
import { TUI_DETAIL_SCHEMAS } from '../cli/tui.ts'
import { CONTROLLER_DETAIL_SCHEMAS } from '../controller/controller.schemas.ts'

/**
 * The composition's root threads — the default threads, always mounted
 * (independent of the faculty allow-list) — plus the guard generator every
 * mounted faculty reuses.
 *
 * @remarks
 * A guard thread `block`s every message whose `detail` does not conform to its
 * schema (`detailMatch: false` matches non-conforming details). A blocked
 * message is never selected, so the rejection is visible in the
 * `frontier`/`pending_bids` traces; valid messages pass untouched. A block-only
 * thread stays pending forever (nothing resumes it), so its block declaration
 * is active every super-step.
 *
 * `guardThreads` is the one generator: the controller vocabulary
 * (`ui_render`/`ui_event`/…) and every mounted faculty's request/cancel/result
 * events derive their guard rules from the same schema homes that `useFaculty`
 * compiles — validation lives in threads, and no hand-maintained guard list
 * can drift from the wire contract.
 *
 * @packageDocumentation
 */

/** One guard rule's schema home: the event `type` and the JSON schema for its `detail`. */
export type GuardEntry = {
  type: string
  detailSchema: Record<string, unknown>
}

/** Build one guard thread that blocks every message whose detail fails its entry's schema. */
export const guardThreads = (label: string, entries: GuardEntry[]): Thread[] => [
  {
    label,
    rules: [
      {
        block: entries.map((entry) => ({
          type: entry.type,
          detailSchema: entry.detailSchema,
          detailMatch: false,
        })),
      },
    ],
  },
]

/**
 * Read an event schema's wire kind — its `properties.type.const`. The one
 * extraction home: the guard generator and `useFaculty`'s lane seal both
 * derive from it, so a schema without the const fails LOUDLY at wiring time
 * wherever it is read (never as a silently-undefined seal).
 */
export const eventTypeOf = (schema: unknown): string => {
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {}
  const type = (properties.type as { const?: string } | undefined)?.const
  if (type === undefined) throw new Error('event schema is missing properties.type.const')
  return type
}

/**
 * Extract guard entries from a faculty's three event schemas (the same object
 * `useFaculty` compiles): the `type` constant and the `detail` sub-schema.
 */
export const eventGuardEntries = (schemas: { request: unknown; cancel: unknown; result: unknown }): GuardEntry[] =>
  [schemas.request, schemas.cancel, schemas.result].map((schema) => ({
    type: eventTypeOf(schema),
    detailSchema:
      ((schema as { properties?: Record<string, unknown> }).properties?.detail as
        | Record<string, unknown>
        | undefined) ?? {},
  }))

const invalidControllerMessages: GuardEntry[] = Object.entries(CONTROLLER_DETAIL_SCHEMAS).map(
  ([type, detailSchema]) => ({ type, detailSchema: detailSchema as Record<string, unknown> }),
)

const invalidTuiMessages: GuardEntry[] = Object.entries(TUI_DETAIL_SCHEMAS).map(([type, detailSchema]) => ({
  type,
  detailSchema: detailSchema as Record<string, unknown>,
}))

/** The root threads: default threads mounted by every composition. */
export const facultiesThreads: Thread[] = guardThreads('guard:ingress-schema', [
  ...invalidControllerMessages,
  ...invalidTuiMessages,
])
