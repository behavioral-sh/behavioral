import { describe, expect, test } from 'bun:test'
import type { BPEvent, JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { rpcAuthThreads } from '../rpc-auth.threads.ts'
import { driveComposition } from './composition-drive.ts'

/**
 * The rpc auth seam's thread library through the REAL composition — the
 * vend-and-replay spine: a typed `credential_required` shell result requests
 * a credential (carrying the original call out-of-band in `ctx.echo`), and
 * the vended `credential_result` replays the call with the token merged in.
 * The op never knows OAuth; the thread orchestrates the cross-faculty
 * round-trip.
 *
 * Mint semantics (the transform-faculty ruling): the packs' transform
 * listeners complete only through the fixed fourth faculty — the drive is
 * async and settles on quiescence. Zero thread edits: the pack mounts
 * unchanged.
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = async (events: BPEvent[]): Promise<Selected[]> => {
  const drive = driveComposition({ threads: rpcAuthThreads })
  try {
    for (const event of events) drive.trigger(event)
    await drive.settle()
    return drive.selected
  } finally {
    drive.terminate()
  }
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
  test('a credential_required result requests a credential carrying the original call in ctx.echo', async () => {
    const selected = await runProgram([credentialRequired('c1', 'https://mcp.example.com/mcp')])
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

  test('a remote 401 challenge (no auth flag) also requests a credential — the reactive path', async () => {
    // The threads' issued rpc ops carry ctx but no auth flag: the op maps a
    // 401-on-unauthenticated-call to credential_required, so the seam serves
    // both the declarative and the reactive path with one gate.
    const selected = await runProgram([
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

  test('the vended credential replays the call with the bearer merged in and ctx restored', async () => {
    const selected = await runProgram([
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

  test('an absent credential never replays — the caller keeps the credential_required error', async () => {
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.credential_result,
        detail: { id: 'c3-cred', ok: false, error: { code: 'error', message: 'no credential' } },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
  })

  test('a replayed call that fails again is not re-captured — the loop is bounded', async () => {
    // The replayed request carries the token; its credential_required-shaped
    // failure (a 401 after vend) does not match the requestor's gate.
    const selected = await runProgram([
      credentialRequired('c4', 'https://mcp.example.com/mcp', { authToken: 'vended-1' }),
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.credential_request)).toBe(false)
  })

  test('a successful shell result is trace-clean — the requestor gate matches only failures', async () => {
    // The failure-path listener's detailSchema must match only
    // failure-shaped details: a success (the common case — every rpc op's
    // result) must not even match, so no transform_request is minted for it
    // and no declining jq can surface. Post-switch noise class (the
    // transform-faculty ruling): a matched-but-declining listener answers
    // ok:false — a result SELECTION, not a trace kind; the retired
    // transform_error noise was 8 per composition boot before this pin.
    const drive = driveComposition({ threads: rpcAuthThreads })
    try {
      drive.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'ok1', ok: true, result: { output: { done: true } } },
      })
      await drive.settle()
      const declined = drive.selected.filter(
        (s) =>
          s.type === FACULTY_MESSAGE_KINDS.transform_request_result && (s.detail as { ok?: boolean })?.ok === false,
      )
      expect(declined).toHaveLength(0)
      expect(drive.selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.credential_request)).toBe(false)
    } finally {
      drive.terminate()
    }
  })
})
