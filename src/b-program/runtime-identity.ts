import type { JSONSchemaType } from 'ajv'
import { ajv } from '../behavioral/behavioral.types.ts'

/**
 * The engine identity — the hello's payload, one neutral home: the
 * composition worker (a browser dedicated worker) and the daemon hosts
 * (serve/socket-host) both speak it, so it lives apart from any carrier
 * module. The host validates before it sends (fail closed), and attaching
 * clients validate on receipt.
 *
 * @public
 */
export type RuntimeIdentity = { instanceId: string; sessionId: string }

/**
 * The hello's wire shape — the one schema home for the hello boundary.
 *
 * @public
 */
export const HelloDetailSchema: JSONSchemaType<RuntimeIdentity> = {
  type: 'object',
  properties: { instanceId: { type: 'string' }, sessionId: { type: 'string' } },
  required: ['instanceId', 'sessionId'],
  additionalProperties: false,
}

/** Compiled once — the host's egress gate for the hello; attach clients reuse it on receipt. */
export const validateHelloDetail = ajv.compile(HelloDetailSchema) as (value: unknown) => boolean
