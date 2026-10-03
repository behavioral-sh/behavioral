import type { Thread } from '../behavioral/behavioral.types.ts'

/**
 * The guard-thread generator the actuator wire's consumers reuse.
 *
 * @remarks
 * A guard thread `block`s every message whose `detail` does not conform to its
 * schema (`detailMatch: false` matches non-conforming details). A blocked
 * message is never selected, so the rejection is visible in the
 * `frontier`/`pending_bids` traces; valid messages pass untouched.
 *
 * `guardThreads` is the one generator: every mounted actuator's
 * request/cancel/result events derive their guard rules from the same schema
 * homes the spawn wiring compiles — validation lives in threads, and no
 * hand-maintained guard list can drift from the wire contract.
 *
 * @packageDocumentation
 */

/** One guard rule's schema home: the event `type` and the JSON schema for its `detail`. */
export type GuardEntry = {
  type: string
  detailSchema: Record<string, unknown>
}

/** Build one guard thread that blocks every message whose detail fails its entry's schema. */
export const guardThreads = (name: string, description: string, entries: GuardEntry[]): Thread[] => [
  {
    name,
    description,
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
 * extraction home: the guard generator and the spawn wiring's lane seal both
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
 * Extract guard entries from an actuator's three event schemas (the same
 * object the spawn wiring compiles): the `type` constant and the `detail`
 * sub-schema.
 */
export const eventGuardEntries = (schemas: { request: unknown; cancel: unknown; result: unknown }): GuardEntry[] =>
  [schemas.request, schemas.cancel, schemas.result].map((schema) => ({
    type: eventTypeOf(schema),
    detailSchema:
      ((schema as { properties?: Record<string, unknown> }).properties?.detail as
        | Record<string, unknown>
        | undefined) ?? {},
  }))
