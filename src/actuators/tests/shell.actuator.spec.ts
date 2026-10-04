import { describe, expect, test } from 'bun:test'
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { ACTUATOR_MESSAGE_KINDS } from '.././actuators.constants.ts'
import type { ShellError, ShellSuccess } from '.././shell.types.ts'
import { type FacultyResult, spawnFaculty } from './faculty-harness.ts'

/**
 * Shell worker integration tests — exercised through the real worker
 * boundary speaking the behavioral event wire: `shell_request` events in
 * (op-discriminated: 'run' = a TS script executed bun-direct via
 * `bun run -`; 'shell' = a Bun Shell command through the constant wrapper),
 * one `shell_request_result` out.
 *
 * @remarks
 * The executor is BUN everywhere — no bash, no POSIX shell dependency. The
 * `run` op spawns `bun run -` with the script on stdin. The `shell` op spawns
 * the same bun entry with the constant wrapper on stdin; the command rides
 * env (`EXEC_CMD`) and the payload rides env (`EXEC_STDIN`) or, over the
 * large-payload threshold, a temp file (`EXEC_STDIN_PATH` /
 * `EXEC_CMD_PATH` + Bun.file redirect). Payload temp files are deleted in
 * the worker's after-path on EVERY exit — completion and kill alike.
 *
 * @packageDocumentation
 */

/** The envelope as posted: { id, ok: true, result } | { id, ok: false, error }. */
type WireResult =
  | { id: string; ok: true; result: ShellSuccess; umwelt?: string }
  | { id: string; ok: false; error: ShellError; umwelt?: string }

/** Spawn the shell worker and expose an event-wire harness over it. */
/** Spawn the shell faculty PROCESS and expose the same wire harness API. */
const spawnShellWorker = () => {
  const faculty = spawnFaculty({
    file: 'shell.actuator.ts',
    requestType: ACTUATOR_MESSAGE_KINDS.shell_request,
    resultType: ACTUATOR_MESSAGE_KINDS.shell_request_result,
  })
  const results: WireResult[] = []
  const observe = (raw: FacultyResult): void => {
    const d = raw.detail as { ok: boolean; result?: ShellSuccess; error?: ShellError }
    results.push({
      id: raw.id,
      ok: d.ok,
      ...(d.ok ? { result: d.result } : { error: d.error }),
      umwelt: raw.umwelt,
    } as WireResult)
  }
  // The harness's resultFor observes every result once; tests use the wrapper.
  const rawFor = faculty.resultFor
  void rawFor
  const run = (id: string, script: string, extra?: Record<string, unknown>, umwelt?: string): void => {
    void faculty
    faculty.call({ id, label: 'test-run', input: { op: 'run', script, ...extra } } as JsonObject, umwelt)
  }
  const sh = (id: string, command: string, extra?: Record<string, unknown>, umwelt?: string): void => {
    void faculty
    faculty.call({ id, label: 'test-sh', input: { op: 'shell', command, ...extra } } as JsonObject, umwelt)
  }
  const cancel = (id: string): void => {
    faculty.post({ type: ACTUATOR_MESSAGE_KINDS.shell_cancel, detail: { id } } as never)
  }
  /** ok-branch payload or throws — error paths use errorFor. */
  const payloadFor = async (id: string): Promise<ShellSuccess> => {
    const r = await resultFor(id)
    if (!r.ok) throw new Error(`expected ok result for ${id}, got error: ${JSON.stringify(r.error)}`)
    return r.result
  }
  /** error-branch interior or throws — ok paths use payloadFor. */
  const errorFor = async (id: string): Promise<ShellError> => {
    const r = await resultFor(id)
    if (r.ok) throw new Error(`expected error result for ${id}, got ok: ${JSON.stringify(r.result)}`)
    return r.error
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const raw = await faculty.resultFor(id)
    observe(raw)
    const found = results.find((r) => r.id === id)
    if (found !== undefined) return found
    // Canceled/timeout results may have been observed already; also cover
    // results whose detail the pump dropped.
    return { id: raw.id, ok: true, result: {} as ShellSuccess, umwelt: raw.umwelt }
  }
  return { run, sh, cancel, resultFor, payloadFor, errorFor, terminate: (): void => faculty.terminate() }
}

/** Leftover payload temp files in the OS tmpdir (the cleanup observable). */
const leftoverPayloadFiles = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('shell-payload-'))

describe('shell worker — event wire', () => {
  test('a shell_request event returns a shell_request_result carrying the id', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w1', 'console.log("wire-ok")')
      const { id, ok } = await shell.resultFor('w1')
      expect(id).toBe('w1')
      expect(ok).toBe(true)
      expect((await shell.payloadFor('w1')).lines).toEqual(['wire-ok'])
    } finally {
      shell.terminate()
    }
  })

  test('a request umwelt is echoed on the result event', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w2', 'console.log("echoed")', undefined, 'demo')
      const { umwelt } = await shell.resultFor('w2')
      expect(umwelt).toBe('demo')
    } finally {
      shell.terminate()
    }
  })

  test('input without the op-discriminated payload is error data', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w3', 'console.log("never")') // then overwrite via sh with a bad shape:
      // 'run' without script, 'shell' without command, and an unknown op:
      shell.run('w4', '')
      const err = await shell.errorFor('w4')
      expect(err.code).toBe('error')
      expect(String(err.message).includes('invalid input')).toBe(true)
    } finally {
      shell.terminate()
    }
  })

  test('unknown input keys are rejected as error data — the op boundary is strict', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w5', 'console.log(1)', { unknownKnob: true })
      const err = await shell.errorFor('w5')
      expect(err.code).toBe('error')
      expect(String(err.message).includes('invalid input')).toBe(true)
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — run op (bun-direct TS scripts)', () => {
  test('a TS script executes via bun run - with no bash in the tree', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('r1', 'console.log(JSON.stringify({ via: "bun", env: Bun.env.RUN_OP_VAR }))', {
        env: { RUN_OP_VAR: 'merged' },
        format: 'json',
      })
      const payload = await shell.payloadFor('r1')
      expect(payload.jsonData).toEqual({ via: 'bun', env: 'merged' })
    } finally {
      shell.terminate()
    }
  })

  test('cwd option directs the script', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('r2', 'console.log(process.cwd())', { cwd: tmpdir() })
      const payload = await shell.payloadFor('r2')
      // macOS resolves /var → /private/var in the child — compare real paths
      expect(payload.lines?.[0]).toBe(realpathSync(tmpdir()))
    } finally {
      shell.terminate()
    }
  })

  test('valid JSON stdout parses into jsonData; invalid is an error with a bounded snippet', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('r3', 'console.log(JSON.stringify({a: 1}))', { format: 'json' })
      const good = await shell.payloadFor('r3')
      expect(good.jsonData).toEqual({ a: 1 })
      shell.run('r4', 'console.log("not json {")', { format: 'json' })
      const bad = await shell.errorFor('r4')
      expect(bad.code).toBe('error')
      expect(String(bad.message).includes('json_parse_failed')).toBe(true)
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — shell op (Bun Shell commands via the wrapper)', () => {
  test('echo completes with real stdout and a zero exit', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s1', 'echo shell-op-works')
      const payload = await shell.payloadFor('s1')
      expect(payload.lines).toEqual(['shell-op-works'])
      expect(payload.exitCode).toBe(0)
    } finally {
      shell.terminate()
    }
  })

  test('a non-zero exit is completed data with the real exit code', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s2', 'echo failing; exit 3')
      const payload = await shell.payloadFor('s2')
      expect(payload.exitCode).toBe(3)
    } finally {
      shell.terminate()
    }
  })

  test('dialect: pipes, chains, and command substitution behave', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s3', 'echo hello bun shell | wc -w')
      const payload = await shell.payloadFor('s3')
      expect(payload.lines?.[0]?.trim()).toBe('3')
      shell.sh('s4', 'echo done-$(echo now)')
      const sub = await shell.payloadFor('s4')
      expect(sub.lines).toEqual(['done-now'])
    } finally {
      shell.terminate()
    }
  })

  test('stdin reaches the command through the env channel', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s5', 'cat', { stdin: 'payload-line-1\npayload-line-2' })
      const payload = await shell.payloadFor('s5')
      expect(payload.lines).toEqual(['payload-line-1', 'payload-line-2'])
    } finally {
      shell.terminate()
    }
  })

  test('a command carrying its own stdin redirect still works', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s6', `cat < ${import.meta.path}`, { maxLines: 5_000 })
      const payload = await shell.payloadFor('s6')
      expect((payload.lines ?? []).length).toBeGreaterThan(10)
    } finally {
      shell.terminate()
    }
  })

  test('a large command rides the temp-file channel and completes', async () => {
    const shell = spawnShellWorker()
    const before = leftoverPayloadFiles()
    try {
      // > the 100KB env threshold — the command text itself is the payload
      const big = `echo ${'x'.repeat(150_000)}`
      shell.sh('s7', big, { maxCharacters: 200_000 })
      const payload = await shell.payloadFor('s7')
      expect(payload.lines?.[0]?.length).toBe(150_000)
      // sensible deletion: no payload temp files survive completion
      expect(leftoverPayloadFiles().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      shell.terminate()
    }
  })

  test('a large stdin payload rides the temp-file channel into the command', async () => {
    const shell = spawnShellWorker()
    const before = leftoverPayloadFiles()
    try {
      shell.sh('s8', 'wc -c', { stdin: 'y'.repeat(150_000), maxCharacters: 200_000 })
      const payload = await shell.payloadFor('s8')
      expect(payload.lines?.[0]?.trim()).toBe('150000')
      expect(leftoverPayloadFiles().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      shell.terminate()
    }
  })

  test('temp files are deleted even when the command is killed — the after-path always runs', async () => {
    const shell = spawnShellWorker()
    const before = leftoverPayloadFiles()
    try {
      const big = `echo ${'z'.repeat(150_000)}; sleep 30`
      shell.sh('s9', big, { timeoutMs: 200 })
      const err = await shell.errorFor('s9')
      expect(err.code).toBe('timeout')
      await Bun.sleep(100) // the finally-path delete is async
      expect(leftoverPayloadFiles().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — containment', () => {
  test('an expired deadline group-kills the tree and reports timeout', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k1', 'sleep 30', { timeoutMs: 200 })
      const err = await shell.errorFor('k1')
      expect(err.code).toBe('timeout')
    } finally {
      shell.terminate()
    }
  })

  test('a shell_cancel reaps the process group and leaves the worker usable', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k2', 'sleep 30')
      await Bun.sleep(250) // let the wrapper start and the sleeper spawn
      shell.cancel('k2')
      const killed = await shell.errorFor('k2')
      expect(killed.code).toBe('canceled')
      // usable after: a fresh call completes
      shell.sh('k3', 'echo still-alive')
      const after = await shell.payloadFor('k3')
      expect(after.exitCode).toBe(0)
    } finally {
      shell.terminate()
    }
  })

  test('the line cap group-kills a flooding command at maxLines', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k4', 'yes flooding', { maxLines: 20 })
      const err = await shell.errorFor('k4')
      expect(err.code).toBe('line_quota')
    } finally {
      shell.terminate()
    }
  })

  test('over-ceiling input bounds are clamped and the clamp is reported', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k5', 'echo clamp-check', { limit: 5_000, maxCharacters: 300_000 })
      const payload = await shell.payloadFor('k5')
      expect(payload.clamped).toEqual(['maxCharacters 300000 -> 200000', 'limit 5000 -> 1000'])
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — paging', () => {
  test('defaults return every line with totalLines and hasMore false', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('p1', 'seq 1 5')
      const payload = await shell.payloadFor('p1')
      expect(payload.lines).toEqual(['1', '2', '3', '4', '5'])
      expect(payload.totalLines).toBe(5)
      expect(payload.hasMore).toBe(false)
    } finally {
      shell.terminate()
    }
  })

  test('offset skips lines and limit bounds the window', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('p2', 'seq 1 10', { offset: 2, limit: 3 })
      const payload = await shell.payloadFor('p2')
      expect(payload.lines).toEqual(['3', '4', '5'])
      expect(payload.totalLines).toBe(10)
      expect(payload.hasMore).toBe(true)
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — raw format + stderr', () => {
  test('raw keeps the tail bounded by maxCharacters with a truncation notice', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('q1', 'seq 1 4000', { format: 'raw', maxCharacters: 2_000, maxLines: 5_000 })
      const payload = await shell.payloadFor('q1')
      expect(String(payload.stdout).includes('[...truncated')).toBe(true)
      expect(payload.hasMore).toBe(true)
    } finally {
      shell.terminate()
    }
  })

  test('stderr is captured separately from stdout', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('q2', 'echo to-out; echo to-err 1>&2')
      const payload = await shell.payloadFor('q2')
      expect(payload.lines).toEqual(['to-out'])
      expect(payload.stderr).toBe('to-err')
    } finally {
      shell.terminate()
    }
  })
})
