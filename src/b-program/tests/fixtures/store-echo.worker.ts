/**
 * The store-echo fixture worker: a real CLASSIC worker speaking the store
 * wire over structured postMessage objects — the new-tree lane protocol.
 * Answers any `store_request` with the paired `store_request_result`,
 * `ok: true`, the request input echoed as the result payload (the umwelt
 * echoed too — the composition's umwelt stamping round-trips visibly).
 *
 * Classic-safe: no imports, no `import.meta` — the nested module-worker
 * failure applies to every worker the composition spawns.
 */

type WireMessage = {
  type: string
  detail: { id: string; op?: string; input?: Record<string, unknown> }
  umwelt?: string
}

self.onmessage = (event: MessageEvent<WireMessage>) => {
  const message = event.data
  if (message?.type !== 'store_request') return
  self.postMessage({
    type: 'store_request_result',
    detail: { id: message.detail.id, ok: true, result: message.detail.input ?? {} },
    ...(message.umwelt === undefined ? {} : { umwelt: message.umwelt }),
  })
}
