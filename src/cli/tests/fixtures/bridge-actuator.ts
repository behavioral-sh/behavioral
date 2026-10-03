/**
 * The bridge spec's actuator fixture — a REAL process speaking the store wire
 * over stdio lines (the useActuator contract), with one scripted branch: a
 * store_request whose input carries {@link DIE_MARKER} makes the process exit
 * WITHOUT replying — an unsolicited death while a request is in flight (the
 * crash-synthesis case). Every other request echoes the uniform result
 * envelope and the process STAYS ALIVE (so the follow-up round-trip proves
 * the lane's respawn-on-demand).
 *
 * Spawned by the spec's lane builder (`bun run <this file>`), never imported.
 */

const DIE_MARKER = 'trigger-die'

let carry = ''
const decoder = new TextDecoder()

const reply = (event: { detail?: { id?: string } }): void => {
  const id = event.detail?.id
  if (typeof id !== 'string') return
  process.stdout.write(
    `${JSON.stringify({
      type: 'store_request_result',
      detail: { id, ok: true, result: { echoed: true } },
    })}\n`,
  )
}

const reader = Bun.stdin.stream().getReader()
void (async () => {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    const lines = carry.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let event: { type?: string; detail?: { id?: string; input?: unknown } }
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (event.type !== 'store_request') continue
      if (JSON.stringify(event.detail?.input ?? {}).includes(DIE_MARKER)) {
        // Die mid-flight: no reply, unsolicited exit — the crash-synthesis case.
        process.exit(1)
      }
      reply(event)
    }
  }
})()
