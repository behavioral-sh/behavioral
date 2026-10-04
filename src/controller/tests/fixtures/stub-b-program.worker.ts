/**
 * The stub bProgram worker — the fixture worker served at the conventional
 * `B_PROGRAM_WORKER_PATH` route by the WebView probe fixture server
 * (`worker-serve.ts`), and spawned directly by `worker-transport.spec.ts`
 * (the dedicated-Worker shape).
 *
 * Speaks the minimum composition port protocol: `attach` → `hello` (stub
 * identity, minted umwelt), and echoes any raw ClientMessage back as a
 * `message` frame carrying a `ui_render` marker — so the probe pages can
 * observe the controller's full egress path (a `ui_error` report renders a
 * marker into the page). Also answers a raw `ping` with `pong` for the
 * raw-worker probe (the `.ts`-URL probe's engine-acceptance leg).
 */
const STUB_IDENTITY = { instanceId: 'stub-b-program', sessionId: 'stub-b-program' }

const onFrame = (frame: unknown): unknown => {
  if (typeof frame !== 'object' || frame === null) return undefined
  const record = frame as Record<string, unknown>
  if (record.kind === 'attach') {
    return { kind: 'hello', umwelt: record.umwelt ?? 'stub_umwelt', identity: STUB_IDENTITY }
  }
  if (record.kind === 'ping') return { kind: 'pong' }
  // A raw ClientMessage (e.g. the controller's ui_error report) echoes back
  // as a selection — a render the probe page can observe in its DOM.
  if (typeof record.type === 'string') {
    return {
      kind: 'message',
      message: {
        type: 'ui_render',
        detail: {
          id: `stub_${record.type}`,
          target: 'main',
          html: `<p id="stub_${record.type}">${record.type}</p>`,
          swap: 'innerHTML',
        },
      },
    }
  }
  return undefined
}

self.onmessage = (event: MessageEvent) => {
  const reply = onFrame(event.data)
  if (reply !== undefined) self.postMessage(reply)
}
