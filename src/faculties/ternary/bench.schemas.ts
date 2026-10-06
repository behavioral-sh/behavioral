/**
 * The bench row's AJV schema — the capture boundary's validator (rows cross
 * the CDP/file boundary from the GPU rig to the capture sink; the runner
 * validates before writing). Compiled once here; both sides reference this
 * module so no cross-home drift is possible.
 *
 * @packageDocumentation
 */
import type { JSONSchemaType } from 'ajv'
import { ajv } from '../../behavioral/behavioral.types.ts'
import type { BenchRow } from './bench.types.ts'

// The nullable rows follow the shell.types.ts precedent: the plain shape first,
// the JSONSchemaType cast at the boundary (ajv's TS generic wants the null in T).
export const BenchRowSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'kernel_bench_row' },
    run: { type: 'string' },
    model: { type: 'string' },
    kernel: { type: 'string' },
    profile: { type: 'string', enum: ['matvec', 'batch-matmul'] },
    inputLength: { type: 'integer', minimum: 1 },
    outputTokens: { type: 'integer', minimum: 0 },
    wallMs: { type: 'number', minimum: 0 },
    tokPerSec: { type: 'number', minimum: 0, nullable: true },
    repeat: { type: 'integer', minimum: 0 },
    detail: { type: 'object', nullable: true, additionalProperties: true, required: [] },
  },
  required: [
    'kind',
    'run',
    'model',
    'kernel',
    'profile',
    'inputLength',
    'outputTokens',
    'wallMs',
    'tokPerSec',
    'repeat',
  ],
  additionalProperties: false,
} as unknown as JSONSchemaType<BenchRow>

export const validateBenchRow = ajv.compile(BenchRowSchema)
