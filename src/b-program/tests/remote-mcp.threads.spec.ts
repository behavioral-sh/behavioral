import { describe, expect, test } from 'bun:test'
import type { BPEvent, JsonObject } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import { hashString } from '../../utils.ts'
import {
  REMOTE_MCP_EVENT_TYPES,
  REMOTE_MCP_PROTOCOL_VERSION,
  REMOTE_MCP_REGISTER_SCRIPT,
  REMOTE_MCP_STORE_COLLECTION,
  remoteMcpThreads,
} from '../remote-mcp.threads.ts'
import { driveComposition } from './composition-drive.ts'

/**
 * The remote-mcp threads through the REAL composition — the MCP layering over
 * the generic `rpc` op: request stamping (`_meta` envelope + the
 * MCP-Protocol-Version header), discovery (server/discover + tools/list →
 * the store registry), execution (tools/call), the multi-round-trip
 * elicitation loop (input_required → host → retry), and the bounded retry
 * on retryable remote failures.
 *
 * Mint semantics (the transform-faculty ruling): the packs' transform
 * listeners complete only through the fixed fourth faculty — the drive is
 * async and settles on quiescence. Zero thread edits: the pack mounts
 * unchanged.
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = async (events: BPEvent[]): Promise<Selected[]> => {
  const drive = driveComposition({ threads: remoteMcpThreads })
  try {
    for (const event of events) drive.trigger(event)
    await drive.settle()
    return drive.selected
  } finally {
    drive.terminate()
  }
}

const URL = 'https://mcp.example.com/mcp'

/** A shell result for one of the threads' stamped rpc legs — the ctx echo rides. */
const rpcResult = (id: string, source: string, leg: string, extraEcho: JsonObject, output: JsonObject): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.shell_request_result,
  detail: {
    id,
    ok: true,
    result: { output, durationMs: 5 },
    ctx: { echo: { source, url: URL, leg, attempt: 0, ...extraEcho } },
  },
})

/** A shell run-op result carrying the stamp script's jsonData — the ctx echo rides. */
const registerResult = (id: string, source: string, output: JsonObject): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.shell_request_result,
  detail: {
    id,
    ok: true,
    result: { jsonData: output, durationMs: 5 },
    ctx: { echo: { source, url: URL, leg: 'register', attempt: 0 } },
  },
})

describe('remote-mcp threads — discovery', () => {
  test('a discover event issues a stamped server/discover rpc op', async () => {
    const selected = await runProgram([
      { type: REMOTE_MCP_EVENT_TYPES.discover, detail: { id: 'r1', input: { url: URL } } },
    ])
    const request = selected.find(
      (s) =>
        s.type === FACULTY_MESSAGE_KINDS.shell_request &&
        (s.detail?.input as { method?: string })?.method === 'server/discover',
    )
    expect(request).toBeDefined()
    const detail = request?.detail as {
      id?: string
      label?: string
      ctx?: { echo?: { source?: string; url?: string; leg?: string } }
      input?: {
        op?: string
        url?: string
        headers?: Record<string, string>
        params?: { _meta?: Record<string, string> }
      }
    }
    expect(detail.id).toBe('r1-discover')
    expect(detail.label).toBe('remote-mcp')
    expect(detail.ctx?.echo?.leg).toBe('discover')
    expect(detail.input?.op).toBe('rpc')
    expect(detail.input?.url).toBe(URL)
    expect(detail.input?.headers?.['MCP-Protocol-Version']).toBe(REMOTE_MCP_PROTOCOL_VERSION)
    expect(detail.input?.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe(REMOTE_MCP_PROTOCOL_VERSION)
  })

  test('the discover result chains tools/list; the tools register in the store and surface', async () => {
    const selected = await runProgram([
      { type: REMOTE_MCP_EVENT_TYPES.discover, detail: { id: 'r1', input: { url: URL } } },
      rpcResult(
        'r1-discover',
        'r1',
        'discover',
        {},
        { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
      ),
      rpcResult('r1-tools', 'r1', 'tools', {}, { tools: [{ name: 'echo', description: 'echoes' }] }),
      registerResult('r1-tools-register', 'r1', {
        ok: true,
        url: URL,
        sourceHash: hashString(URL),
        tools: [{ name: 'echo', description: 'echoes', handle: 'mcp_example_com__echo', sourceHash: hashString(URL) }],
      }),
    ])
    const toolsRequest = selected.find(
      (s) =>
        s.type === FACULTY_MESSAGE_KINDS.shell_request &&
        (s.detail?.input as { method?: string })?.method === 'tools/list',
    )
    expect(toolsRequest).toBeDefined()
    const put = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)
    expect(put).toBeDefined()
    const input = put?.detail as {
      id?: string
      op?: string
      input?: { collection?: string; key?: string; value?: { url?: string; tools?: Array<{ name?: string }> } }
    }
    expect(input.op).toBe('put')
    expect(input.input?.collection).toBe(REMOTE_MCP_STORE_COLLECTION)
    expect(input.input?.key).toBe(URL)
    expect(input.input?.value?.tools?.[0]?.name).toBe('echo')
    const surfaced = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.discovered)
    expect(surfaced).toBeDefined()
    const surfacedDetail = surfaced?.detail as { id?: string; input?: { url?: string; tools?: unknown[] } }
    expect(surfacedDetail.id).toBe('r1')
    expect(surfacedDetail.input?.url).toBe(URL)
  })
})

describe('remote-mcp threads — execution', () => {
  test('a call event issues a stamped tools/call rpc op; the result surfaces', async () => {
    const selected = await runProgram([
      {
        type: REMOTE_MCP_EVENT_TYPES.call,
        detail: { id: 'c1', input: { url: URL, tool: 'echo', args: { message: 'hi' } } },
      },
      rpcResult(
        'c1-call',
        'c1',
        'call',
        { tool: 'echo', args: { message: 'hi' }, round: 0 },
        { content: [{ type: 'text', text: 'hi' }] },
      ),
    ])
    const request = selected.find(
      (s) =>
        s.type === FACULTY_MESSAGE_KINDS.shell_request &&
        (s.detail?.input as { method?: string })?.method === 'tools/call',
    )
    expect(request).toBeDefined()
    const detail = request?.detail as {
      id?: string
      input?: { params?: { name?: string; arguments?: unknown; _meta?: Record<string, string> } }
    }
    expect(detail.id).toBe('c1-call')
    expect(detail.input?.params?.name).toBe('echo')
    expect(detail.input?.params?.arguments).toEqual({ message: 'hi' })
    expect(detail.input?.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe(REMOTE_MCP_PROTOCOL_VERSION)
    const result = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)
    expect(result).toBeDefined()
    const d = result?.detail as { id?: string; ok?: boolean; error?: { code?: string } }
    expect(d?.ok).toBe(true)
  })

  test('an input_required result surfaces the elicitation; the response retries with the answers', async () => {
    const selected = await runProgram([
      {
        type: REMOTE_MCP_EVENT_TYPES.call,
        detail: { id: 'c2', input: { url: URL, tool: 'deploy', args: { env: 'prod' } } },
      },
      rpcResult(
        'c2-call',
        'c2',
        'call',
        { tool: 'deploy', args: { env: 'prod' }, round: 0 },
        { inputRequests: { confirm: { message: 'Deploy to prod?' } }, requestState: 'opaque-state-1' },
      ),
      {
        type: REMOTE_MCP_EVENT_TYPES.elicitationResponse,
        detail: {
          id: 'c2',
          input: {
            url: URL,
            tool: 'deploy',
            args: { env: 'prod' },
            round: 0,
            requestState: 'opaque-state-1',
            inputResponses: { confirm: { action: 'accept' } },
          },
        },
      },
      rpcResult(
        'c2-call-r1',
        'c2',
        'call',
        { tool: 'deploy', args: { env: 'prod' }, round: 1 },
        { content: [{ type: 'text', text: 'deployed' }] },
      ),
    ])
    const elicitation = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.elicitation)
    expect(elicitation).toBeDefined()
    const elicited = elicitation?.detail as {
      id?: string
      input?: { url?: string; tool?: string; requestState?: string }
    }
    expect(elicited.id).toBe('c2')
    expect(elicited.input?.url).toBe(URL)
    expect(elicited.input?.tool).toBe('deploy')
    expect(elicited.input?.requestState).toBe('opaque-state-1')
    const retry = selected.find(
      (s) =>
        s.type === FACULTY_MESSAGE_KINDS.shell_request &&
        (s.detail?.input as { params?: Record<string, unknown> })?.params?.inputResponses !== undefined,
    )
    expect(retry).toBeDefined()
    const retryDetail = retry?.detail as {
      id?: string
      input?: {
        url?: string
        method?: string
        params?: {
          name?: string
          arguments?: unknown
          inputResponses?: unknown
          requestState?: string
          _meta?: Record<string, string>
        }
      }
    }
    // A FRESH request id per the MRTR contract; the answers + the byte-exact
    // requestState echo ride the retry params.
    expect(retryDetail.id).toBe('c2-call-r1')
    expect(retryDetail.input?.url).toBe(URL)
    expect(retryDetail.input?.method).toBe('tools/call')
    expect(retryDetail.input?.params?.name).toBe('deploy')
    expect(retryDetail.input?.params?.inputResponses).toEqual({ confirm: { action: 'accept' } })
    expect(retryDetail.input?.params?.requestState).toBe('opaque-state-1')
    const result = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)
    expect(result).toBeDefined()
    const d = result?.detail as { id?: string; ok?: boolean }
    expect(d?.ok).toBe(true)
  })

  test('the MRTR round cap exhausts as a typed round_cap error', async () => {
    const selected = await runProgram([
      {
        type: REMOTE_MCP_EVENT_TYPES.elicitationResponse,
        detail: {
          id: 'c3',
          input: { url: URL, tool: 'deploy', args: {}, round: 2, requestState: 's', inputResponses: {} },
        },
      },
    ])
    const result = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)
    expect(result).toBeDefined()
    const d = result?.detail as { id?: string; ok?: boolean; error?: { code?: string } }
    expect(d?.ok).toBe(false)
    expect(d?.error?.code).toBe('round_cap')
  })
})

describe('remote-mcp threads — retry', () => {
  test('a retryable remote failure re-requests the op with the attempt advanced', async () => {
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: 'c4-call',
          ok: false,
          ctx: { echo: { source: 'c4', url: URL, tool: 'x', args: {}, leg: 'call', round: 0, attempt: 0 } },
          error: { code: 'error', remoteCode: 503, message: 'HTTP 503', durationMs: 2, retryable: true },
        },
      },
    ])
    const retry = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)
    expect(retry).toBeDefined()
    const detail = retry?.detail as {
      id?: string
      ctx?: { echo?: { attempt?: number } }
      input?: { method?: string; url?: string }
    }
    expect(detail.id).toBe('c4-call')
    expect(detail.ctx?.echo?.attempt).toBe(1)
    expect(detail.input?.method).toBe('tools/call')
  })

  test('the attempt bound exhausts; the failure surfaces to the caller', async () => {
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: 'c5-call',
          ok: false,
          ctx: { echo: { source: 'c5', url: URL, tool: 'x', args: {}, leg: 'call', round: 0, attempt: 2 } },
          error: { code: 'error', remoteCode: 503, message: 'HTTP 503', durationMs: 2, retryable: true },
        },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
    const result = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)
    expect(result).toBeDefined()
    const d = result?.detail as { ok?: boolean; error?: { remoteCode?: number } }
    expect(d?.ok).toBe(false)
    expect(d?.error?.remoteCode).toBe(503)
  })

  test('a non-retryable failure surfaces without a retry', async () => {
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: 'c6-call',
          ok: false,
          ctx: { echo: { source: 'c6', url: URL, tool: 'x', args: {}, leg: 'call', round: 0, attempt: 0 } },
          error: { code: 'error', remoteCode: 400, message: 'bad request', durationMs: 2, retryable: false },
        },
      },
    ])
    expect(selected.some((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
    expect(selected.some((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)).toBe(true)
  })

  test('a failed vend echoes the request ctx — the threads surface the absent credential', async () => {
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.credential_result,
        detail: {
          id: 'c7-call-cred',
          ok: false,
          ctx: {
            echo: {
              id: 'c7-call',
              input: {},
              ctx: { echo: { source: 'c7', url: URL, leg: 'call', round: 0, attempt: 0 } },
            },
          },
          error: { code: 'error', message: 'no credential available' },
        },
      },
    ])
    const result = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)
    expect(result).toBeDefined()
    const d = result?.detail as { id?: string; ok?: boolean; error?: { message?: string } }
    expect(d?.ok).toBe(false)
    expect(d?.error?.message).toContain('no credential')
  })

  test('a failed vend for a non-remote-mcp caller never surfaces a remote-mcp result', async () => {
    // A direct (declarative) rpc caller's vend failure carries no remote-mcp ctx —
    // the derived leg is not "call", so no remote-mcp result fires.
    const selected = await runProgram([
      {
        type: FACULTY_MESSAGE_KINDS.credential_result,
        detail: {
          id: 'direct-1-cred',
          ok: false,
          ctx: { echo: { id: 'direct-1', input: {}, ctx: null } },
          error: { code: 'error', message: 'no credential available' },
        },
      },
    ])
    expect(selected.some((s) => s.type === REMOTE_MCP_EVENT_TYPES.callResult)).toBe(false)
  })
})

describe('remote-mcp threads — trace cleanliness', () => {
  /** Mount the threads and drive one producer event, collecting selections and transform_error traces. */
  /**
   * The trace-cleanliness drive through the REAL composition: the packs'
   * transform listeners complete only through the fixed fourth faculty, so
   * the post-switch noise class is the DECLINED result — a matched-but-
   * declining listener answers `ok:false` (a result selection, fail-visible;
   * the `transform_error` trace kind retired with the engine switch). The
   * clean pins: zero declined results on clean operation.
   */
  const declinedResults = (selected: Selected[]): Selected[] =>
    selected.filter(
      (s) => s.type === FACULTY_MESSAGE_KINDS.transform_request_result && (s.detail as { ok?: boolean })?.ok === false,
    )

  const traceRunFor = async (event: BPEvent): Promise<Selected[]> => {
    const drive = driveComposition({ threads: remoteMcpThreads })
    try {
      drive.trigger(event)
      await drive.settle()
      return drive.selected
    } finally {
      drive.terminate()
    }
  }

  test('a successful call result is trace-clean — the failure listeners never match successes', async () => {
    // The failure-path listeners (retry, call-failure, discover-failure) must
    // match only failure-shaped details: a genuine success — ctx echo, call
    // leg, a call-shaped output — is the common case, and a matched listener
    // whose jq declines would answer a declined result — stray noise on
    // every clean op (8 fired on every composition boot before this pin).
    const selected = await traceRunFor(
      rpcResult(
        'tc1-call',
        'tc1',
        'call',
        { tool: 'echo', args: {}, round: 0 },
        {
          content: [{ type: 'text', text: 'hi' }],
        },
      ),
    )
    expect(declinedResults(selected)).toHaveLength(0)
  })

  test('a direct caller’s failed vend is trace-clean — the vend-failure gate matches only the remote-mcp echo chain', async () => {
    // The vend-failure listener must match only vends whose ctx echo chain
    // marks them remote-mcp calls: a direct (declarative) rpc caller’s failed
    // vend never even matches, so its decline never answers a result. (The
    // surface outcome itself is pinned above: no remote-mcp result fires.)
    const selected = await traceRunFor({
      type: FACULTY_MESSAGE_KINDS.credential_result,
      detail: {
        id: 'direct-2-cred',
        ok: false,
        ctx: { echo: { id: 'direct-2', input: {}, ctx: null } },
        error: { code: 'error', message: 'no credential available' },
      },
    })
    expect(declinedResults(selected)).toHaveLength(0)
  })

  test('a genuine retryable failure is trace-clean — the siblings divide on the schema field', async () => {
    // A real 503 at attempt 0 (the op stamps `retryable: true` — the rpc op
    // spec pins the computation): the retry listener ACTS and the surface
    // listeners never even match. The division rides the schema field (a
    // const), not a jq numeric check, so no declining sibling answers a
    // declined result per genuine failure.
    const selected = await traceRunFor({
      type: FACULTY_MESSAGE_KINDS.shell_request_result,
      detail: {
        id: 'tc3-call',
        ok: false,
        ctx: { echo: { source: 'tc3', url: URL, tool: 'echo', args: {}, leg: 'call', round: 0, attempt: 0 } },
        error: { code: 'error', remoteCode: 503, message: 'HTTP 503', durationMs: 2, retryable: true },
      },
    })
    expect(declinedResults(selected)).toHaveLength(0)
    const retry = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.shell_request)
    expect(retry).toBeDefined()
    const detail = retry?.detail as { id?: string; ctx?: { echo?: { attempt?: number } } }
    expect(detail.id).toBe('tc3-call')
    expect(detail.ctx?.echo?.attempt).toBe(1)
  })
})

describe('remote-mcp threads — registration identity', () => {
  test('the tools result issues the stamp run op — script, url + tools env, the register echo leg', async () => {
    const selected = await runProgram([
      { type: REMOTE_MCP_EVENT_TYPES.discover, detail: { id: 'r9', input: { url: URL } } },
      rpcResult('r9-discover', 'r9', 'discover', {}, { supportedVersions: ['2026-07-28'], capabilities: {} }),
      rpcResult('r9-tools', 'r9', 'tools', {}, { tools: [{ name: 'echo', description: 'echoes' }] }),
    ])
    const stamp = selected.find((s) => {
      if (s.type !== FACULTY_MESSAGE_KINDS.shell_request) return false
      const input = s.detail?.input as { op?: string; script?: string } | undefined
      if (input === undefined) return false
      return input.op === 'run' && typeof input.script === 'string' && input.script.includes('hashString')
    })
    expect(stamp).toBeDefined()
    const input = stamp?.detail?.input as { env?: Record<string, string> }
    expect(input.env?.REMOTE_MCP_URL).toBe(URL)
    expect(JSON.parse(input.env?.REMOTE_MCP_TOOLS ?? '[]')).toEqual([{ name: 'echo', description: 'echoes' }])
    const echo = (stamp?.detail?.ctx as { echo?: { leg?: string; source?: string; url?: string } })?.echo
    expect(echo?.leg).toBe('register')
    expect(echo?.source).toBe('r9')
    expect(echo?.url).toBe(URL)
  })

  test('the stamped register result puts the registry value and surfaces the discovery — tools carry handle + sourceHash', async () => {
    const sourceHash = hashString(URL)
    const selected = await runProgram([
      { type: REMOTE_MCP_EVENT_TYPES.discover, detail: { id: 'r10', input: { url: URL } } },
      rpcResult('r10-discover', 'r10', 'discover', {}, { supportedVersions: ['2026-07-28'], capabilities: {} }),
      rpcResult('r10-tools', 'r10', 'tools', {}, { tools: [{ name: 'echo', description: 'echoes' }] }),
      registerResult('r10-tools-register', 'r10', {
        ok: true,
        url: URL,
        sourceHash,
        tools: [{ name: 'echo', description: 'echoes', handle: 'mcp_example_com__echo', sourceHash }],
      }),
    ])
    const put = selected.find((s) => s.type === FACULTY_MESSAGE_KINDS.store_request)
    expect(put).toBeDefined()
    const input = put?.detail as {
      op?: string
      input?: { collection?: string; key?: string; value?: { url?: string; tools?: Array<Record<string, unknown>> } }
    }
    expect(input.op).toBe('put')
    expect(input.input?.collection).toBe(REMOTE_MCP_STORE_COLLECTION)
    expect(input.input?.key).toBe(URL)
    expect(input.input?.value?.url).toBe(URL)
    expect(input.input?.value?.tools?.[0]?.handle).toBe('mcp_example_com__echo')
    expect(input.input?.value?.tools?.[0]?.sourceHash).toBe(sourceHash)
    const surfaced = selected.find((s) => s.type === REMOTE_MCP_EVENT_TYPES.discovered)
    expect(surfaced).toBeDefined()
    const surfacedDetail = surfaced?.detail as { id?: string; input?: { url?: string } }
    expect(surfacedDetail.id).toBe('r10')
    expect(surfacedDetail.input?.url).toBe(URL)
  })
})

describe('the remote-mcp registration stamp script (real run)', () => {
  const runStamp = async (url: string, tools: unknown): Promise<Record<string, unknown>> => {
    const proc = Bun.spawn(['bun', 'run', '-'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, REMOTE_MCP_URL: url, REMOTE_MCP_TOOLS: JSON.stringify(tools) },
    })
    proc.stdin.write(REMOTE_MCP_REGISTER_SCRIPT)
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    return JSON.parse(stdout) as Record<string, unknown>
  }

  test('stamps each tool with the hostname-prefixed handle and the server-URI djb2 hash — the real hashString', async () => {
    const out = await runStamp(URL, [{ name: 'echo', description: 'echoes' }])
    expect(out.ok).toBe(true)
    expect(out.url).toBe(URL)
    expect(out.sourceHash).toBe(hashString(URL))
    const tools = out.tools as Array<{ name?: string; handle?: string; sourceHash?: number }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.handle).toBe('mcp_example_com__echo')
    expect(tools[0]!.sourceHash).toBe(hashString(URL))
  })

  test('two servers exposing the same tool name land as distinct handles with distinct hashes', async () => {
    const a = await runStamp('https://a.example.com/mcp', [{ name: 'summarize' }])
    const b = await runStamp('https://b.example.com/mcp', [{ name: 'summarize' }])
    const toolsA = a.tools as Array<{ handle?: string; sourceHash?: number }>
    const toolsB = b.tools as Array<{ handle?: string; sourceHash?: number }>
    expect(toolsA[0]!.handle).toBe('a_example_com__summarize')
    expect(toolsB[0]!.handle).toBe('b_example_com__summarize')
    expect(toolsA[0]!.handle).not.toBe(toolsB[0]!.handle)
    expect(toolsA[0]!.sourceHash).not.toBe(toolsB[0]!.sourceHash)
  })

  test('a same-named server across configs (same host, different ports) keeps the handle — the hash disambiguates', async () => {
    const p1 = await runStamp('https://mcp.example.com:8443/mcp', [{ name: 'echo' }])
    const p2 = await runStamp('https://mcp.example.com:9443/mcp', [{ name: 'echo' }])
    const tools1 = p1.tools as Array<{ handle?: string; sourceHash?: number }>
    const tools2 = p2.tools as Array<{ handle?: string; sourceHash?: number }>
    expect(tools1[0]!.handle).toBe(tools2[0]!.handle)
    expect(tools1[0]!.sourceHash).not.toBe(tools2[0]!.sourceHash)
  })
})
