import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { Trace } from '../../behavioral/behavioral.types.ts'
import { TRACE_PUSH_KIND } from '../faculties.constants.ts'
import { tracePipe } from '../trace-pipe.ts'
import { createTracePipeServer, type TracePipeServer } from './fixtures/trace-pipe-server.ts'

/**
 * The trace pipe — the composition worker's upstream trace leg (the
 * one-observability-stream ruling): the worker's redacted trace stream
 * pushes to the daemon bridge over the landed faculty-wire framing
 * (one JSON line per event — a trace rides `{ type: 'trace', detail }`).
 * Push-only: no re-entries, no result seal; queue-before-open and the
 * bounded reconnect mirror the socket lane's transport discipline.
 */

const traceOf = (kind: string, extra: Record<string, unknown> = {}): Trace =>
  ({ kind, timestamp: 0, instanceId: 'i', sessionId: 's', step: 1, ...extra }) as Trace

describe('the trace pipe', () => {
  test('a push lands as a trace line in the landed framing', async () => {
    const server: TracePipeServer = await createTracePipeServer()
    try {
      const pipe = tracePipe({ url: server.url })
      pipe.push(traceOf(TRACE_MESSAGE_KINDS.idle))
      const trace = await server.waitForTrace()
      expect(server.frames[0]!.type).toBe(TRACE_PUSH_KIND)
      expect(trace.kind).toBe(TRACE_MESSAGE_KINDS.idle)
      pipe.terminate()
    } finally {
      await server.close()
    }
  })

  test('pushes queue before the socket opens and flush in order', async () => {
    const server: TracePipeServer = await createTracePipeServer()
    try {
      const pipe = tracePipe({ url: server.url })
      pipe.push(traceOf('first'))
      pipe.push(traceOf('second'))
      const first = await server.waitForTrace((t) => t.kind === 'first')
      expect(first.kind).toBe('first')
      const second = await server.waitForTrace((t) => t.kind === 'second')
      expect(second.kind).toBe('second')
      // Order preserved: first's line index precedes second's.
      expect(server.traceOrder()).toEqual(['first', 'second'])
      pipe.terminate()
    } finally {
      await server.close()
    }
  })

  test('a push after the socket dies queues for the reconnect — no silent loss', async () => {
    const server: TracePipeServer = await createTracePipeServer()
    try {
      const pipe = tracePipe({ url: server.url })
      pipe.push(traceOf('before-drop'))
      await server.waitForTrace((t) => t.kind === 'before-drop')
      // Drop the connection server-side (a service restart — retryable).
      await server.dropConnections()
      // A push racing the drop queues; the reconnect flushes it.
      pipe.push(traceOf('after-drop'))
      const flushed = await server.waitForTrace((t) => t.kind === 'after-drop')
      expect(flushed.kind).toBe('after-drop')
      pipe.terminate()
    } finally {
      await server.close()
    }
  })

  test('terminate stops the pipe — a later push never hits the wire', async () => {
    const server: TracePipeServer = await createTracePipeServer()
    try {
      const pipe = tracePipe({ url: server.url })
      pipe.push(traceOf(TRACE_MESSAGE_KINDS.idle))
      await server.waitForTrace()
      pipe.terminate()
      pipe.push(traceOf('too-late'))
      await Bun.sleep(100)
      expect(server.traces.some((t) => t.kind === 'too-late')).toBe(false)
    } finally {
      await server.close()
    }
  })
})
