import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { rpcAuthThreads } from '../rpc-auth.threads.ts'

/**
 * The rpc auth seam's thread library against the real engine — the
 * vend-and-replay spine: a typed `credential_required` shell result requests
 * a credential (carrying the original call out-of-band in `ctx.echo`), and
 * the vended `credential_result` replays the call with the token merged in.
 * The op never knows OAuth; the thread orchestrates the cross-faculty
 * round-trip.
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = (events: BPEvent[]): Selected[] => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  for (const thread of rpcAuthThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  // addThread is inert — trigger admits one ingress event and runs one
  // super-step; the second pump cascades transform re-entries.
  program.trigger({ type: 'rpc_auth_pump', detail: {} })
  program.trigger({ type: 'rpc_auth_pump', detail: {} })
  return selected
}

const credentialRequired = (id: string, url: string, extraInput: JsonObject = {}): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.shell_request_result,
  detail: {
    id,
    ok: false,
    error: {
      code: 'credential_required',
      durationMs: 1,
      message: 'credential required',
      request: { op: 'rpc', input: { op: 'rpc', url, method: 'tools/list', auth: true, ...extraInput } },
    },
  },
})

const vended = (credId: string, echo: { id: string; input: JsonObject; ctx?: JsonObject }): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.credential_result,
  detail: { id: credId, ok: true, result: { token: 'vended-1', echo } },
})

describe('rpc auth threads — the vend-and-replay spine', () => {
  test('a credential_required result requests a credential carrying the original call in ctx.echo', () => {
    const selected = runProgram([credentialRequired('c1', 'https://mcp.example.com/mcp')])
    const request = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.credential_request)
    expect(request).toBeDefined()
    const detail = request?.detail as {
      id?: string
      input?: { serverUrl?: string }
      ctx?: { echo?: { id?: string; input?: Record<string, unknown>; ctx?: unknown } }
    }
    expect(detail.id).toBe('c1-cred')
    expect(detail.input?.serverUrl).toBe('https://mcp.example.com/mcp')
    expect(detail.ctx?.echo).toEqual({
      id: 'c1',
      input: { op: 'rpc', url: 'https://mcp.example.com/mcp', auth: true, method: 'tools/list' },
      ctx: null,
    })
  })

  test('a remote 401 challenge (no auth flag) also requests a credential — the reactive path', () => {
    // The threads' issued rpc ops carry ctx but no auth flag: the op maps a
    // 401-on-unauthenticated-call to credential_required, so the seam serves
    // both the declarative and the reactive path with one gate.
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: 'c1r-call',
          ok: false,
          ctx: { echo: { source: 'c1r', url: 'https://mcp.example.com/mcp', leg: 'call', attempt: 0 } },
          error: {
            code: 'credential_required',
            durationMs: 3,
            message: 'credential required for https://mcp.example.com/mcp',
            request: { op: 'rpc', input: { op: 'rpc', url: 'https://mcp.example.com/mcp', method: 'tools/call' } },
          },
        },
      },
    ])
    const request = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.credential_request)
    expect(request).toBeDefined()
    const detail = request?.detail as { id?: string; ctx?: { echo?: { ctx?: unknown } } }
    expect(detail.id).toBe('c1r-call-cred')
    // The echoed ctx preserves the threads' join payload through the vend.
    expect(detail.ctx?.echo?.ctx).toEqual({
      echo: { source: 'c1r', url: 'https://mcp.example.com/mcp', leg: 'call', attempt: 0 },
    })
  })

  test('the vended credential replays the call with the bearer merged in and ctx restored', () => {
    const selected = runProgram([
      vended('c2-cred', {
        id: 'c2',
        input: { op: 'rpc', url: 'https://mcp.example.com/mcp', auth: true },
        ctx: { echo: { source: 'c2', leg: 'call', round: 0, attempt: 0 } },
      }),
    ])
    const replay = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)
    expect(replay).toBeDefined()
    const detail = replay?.detail as {
      id?: string
      ctx?: unknown
      input?: { authToken?: string; auth?: boolean; url?: string }
    }
    expect(detail.id).toBe('c2')
    expect(detail.input?.authToken).toBe('vended-1')
    expect(detail.input?.auth).toBe(true)
    expect(detail.input?.url).toBe('https://mcp.example.com/mcp')
    // The threads' join payload survives the vend round-trip.
    expect(detail.ctx).toEqual({ echo: { source: 'c2', leg: 'call', round: 0, attempt: 0 } })
  })

  test('an absent credential never replays — the caller keeps the credential_required error', () => {
    const selected = runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.credential_result,
        detail: { id: 'c3-cred', ok: false, error: { code: 'error', message: 'no credential' } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
  })

  test('a replayed call that fails again is not re-captured — the loop is bounded', () => {
    // The replayed request carries the token; its credential_required-shaped
    // failure (a 401 after vend) does not match the requestor's gate.
    const selected = runProgram([credentialRequired('c4', 'https://mcp.example.com/mcp', { authToken: 'vended-1' })])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.credential_request)).toBe(false)
  })

  test('a successful shell result is trace-clean — the requestor gate matches only failures', () => {
    // The failure-path listener's detailSchema must match only
    // failure-shaped details: a success (the common case — every rpc op's
    // result) must not even match, so its select() never declines into an
    // empty-output transform_error. Stray error traces on clean operation
    // are noise: 8 of them fired on every composition boot before this pin.
    const program = behavioral()
    const transformErrors: Trace[] = []
    program.useTrace((trace: Trace) => {
      if (trace.kind === TRACE_MESSAGE_KINDS.transform_error) transformErrors.push(trace)
    })
    for (const thread of rpcAuthThreads) program.addThread(thread)
    program.addThread({
      label: 'producer/success',
      once: true,
      rules: [
        {
          request: {
            type: FACULTY_MESSAGE_KINDS.shell_request_result,
            detail: { id: 'ok1', ok: true, result: { output: { done: true } } },
          },
        },
      ],
    })
    program.trigger({ type: 'rpc_auth_pump', detail: {} })
    program.trigger({ type: 'rpc_auth_pump', detail: {} })
    expect(transformErrors).toHaveLength(0)
  })
})
