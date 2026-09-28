/*
 * Probe process fixture — long-running, speaks the unchanged wire over
 * stdio lines: one JSON request per line in, one result-event line out.
 * The `die` op exits 3 mid-stream (crash synthesis); everything else
 * answers the ok envelope and keeps serving — the primitive's respawn
 * brings a fresh instance only after a death.
 * The `emit_malformed` op additionally writes one schema-INVALID but
 * JSON-parseable result line first — the result-lane visibility case (the
 * pump re-enters it, the guard blocks it).
 */

const emit = (event: unknown): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let carry = ''

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  carry += decoder.decode(value, { stream: true })
  const lines = carry.split('\n')
  carry = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const message = JSON.parse(trimmed) as {
      type: string
      detail: { id: string; input: { op: string } }
      space?: string
    }
    if (message.detail.input.op === 'die') {
      process.exit(3)
    }
    if (message.detail.input.op === 'emit_malformed') {
      // Well-formed JSON, wrong detail: no id, no ok — fails the result schema.
      emit({ type: 'shell_request_result', detail: { malformed: true } })
    }
    emit({
      type: 'shell_request_result',
      detail: {
        id: message.detail.id,
        ok: true,
        result: { echoed: message.detail.input.op, env: process.env.PROBE_ENV },
      },
      ...(message.space === undefined ? {} : { space: message.space }),
    })
  }
}
