/**
 * Worker transport spec (unit level).
 *
 * Single observable interface: the {@link WorkerTransport} — the controller's
 * page-side Transport over a `Worker | MessagePort`, speaking the composition
 * port protocol (attach → hello, raw ClientMessage egress, `message`/`trace`
 * frames ingress). Driven over REAL message-channel boundaries: a
 * `MessageChannel` pair (the SharedWorker-port shape the transport must
 * support) and a real spawned Worker for the dedicated-worker shape.
 *
 * The dedicated-worker default-spawn path (the controller's `#getTransport`
 * flip) is proven at the real browser boundary in
 * `worker-transport.webview.spec.ts` — the serving-contract probe.
 */
import { describe, expect, test } from 'bun:test'
import { COMPOSITION_PORT_KINDS, WorkerTransport } from '../worker-transport.ts'

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read the next inbound frame the simulated worker receives on its channel leg. */
const inboundFrame = (port: MessagePort): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    port.addEventListener('message', (event: MessageEvent) => resolve(event.data as Record<string, unknown>), {
      once: true,
    })
  })

describe('WorkerTransport — the attach handshake', () => {
  test('posts attach (minted umwelt) and surfaces hello as the open status', async () => {
    const channel = new MessageChannel()
    const hello = inboundFrame(channel.port2)

    const statusEvents: unknown[] = []
    const transport = new WorkerTransport({ worker: channel.port1 })
    transport.onStatus((event) => statusEvents.push(event))

    const attach = (await hello) as { kind?: string; umwelt?: string }
    expect(attach.kind).toBe(COMPOSITION_PORT_KINDS.attach)
    expect(attach.umwelt).toBeUndefined() // no claim — the worker mints the umwelt

    channel.port2.postMessage({
      kind: COMPOSITION_PORT_KINDS.hello,
      umwelt: 'tab_stub',
      identity: { instanceId: 'stub', sessionId: 'stub' },
    })
    await wait()

    expect(statusEvents).toEqual([{ type: 'open' }])
    expect(transport.umwelt).toBe('tab_stub')
  })

  test('a claimed umwelt rides the attach frame', async () => {
    const channel = new MessageChannel()
    const hello = inboundFrame(channel.port2)

    new WorkerTransport({ worker: channel.port1, umwelt: 'tab_claimed' })

    const attach = (await hello) as { kind?: string; umwelt?: string }
    expect(attach.kind).toBe(COMPOSITION_PORT_KINDS.attach)
    expect(attach.umwelt).toBe('tab_claimed')
  })
})

describe('WorkerTransport — egress and ingress', () => {
  test('send posts the ClientMessage raw, no envelope', async () => {
    const channel = new MessageChannel()
    const firstInbound = inboundFrame(channel.port2)

    const transport = new WorkerTransport({ worker: channel.port1 })
    await firstInbound // attach
    await inboundFrame(channel.port2) // trace_subscribe (kinds omitted = all)

    const received = inboundFrame(channel.port2)
    transport.send({ type: 'ui_event', detail: { event: { type: 'do_thing' } } } as never)
    expect(await received).toEqual({ type: 'ui_event', detail: { event: { type: 'do_thing' } } })
  })

  test('message frames forward as ServerMessages to onMessage', async () => {
    const channel = new MessageChannel()
    const firstInbound = inboundFrame(channel.port2)

    const messages: unknown[] = []
    const transport = new WorkerTransport({ worker: channel.port1 })
    transport.onMessage((message) => messages.push(message))
    await firstInbound // attach
    await inboundFrame(channel.port2) // trace_subscribe

    channel.port2.postMessage({
      kind: COMPOSITION_PORT_KINDS.message,
      message: { type: 'ui_render', detail: { id: 'r1', target: 'main', html: '<p>x</p>', swap: 'innerHTML' } },
    })
    await wait()
    expect(messages).toEqual([
      { type: 'ui_render', detail: { id: 'r1', target: 'main', html: '<p>x</p>', swap: 'innerHTML' } },
    ])
  })

  test('trace frames tap onTrace; unknown and non-object frames are ignored', async () => {
    const channel = new MessageChannel()
    const firstInbound = inboundFrame(channel.port2)

    const traces: unknown[] = []
    const transport = new WorkerTransport({ worker: channel.port1, onTrace: (trace) => traces.push(trace) })
    await firstInbound // attach
    await inboundFrame(channel.port2) // trace_subscribe

    channel.port2.postMessage({ kind: COMPOSITION_PORT_KINDS.trace, trace: { kind: 'idle' } })
    channel.port2.postMessage({ kind: 'unknown_frame' })
    channel.port2.postMessage('not an object')
    await wait()
    expect(traces).toEqual([{ kind: 'idle' }])
    expect(transport.umwelt).toBeUndefined() // no hello yet — unknown frames change nothing
  })
})

describe('WorkerTransport — the dedicated-worker shape', () => {
  test('a real spawned Worker answers attach with hello and opens the carrier', async () => {
    const worker = new Worker(new URL('./fixtures/stub-b-program.worker.ts', import.meta.url))
    const statusEvents: unknown[] = []
    const transport = new WorkerTransport({ worker })
    transport.onStatus((event) => statusEvents.push(event))
    const hello = new Promise<unknown>((resolve) => {
      worker.addEventListener('message', (event: MessageEvent) => resolve(event.data), { once: true })
    })
    const frame = (await hello) as { kind?: string; umwelt?: string; identity?: unknown }
    expect(frame.kind).toBe(COMPOSITION_PORT_KINDS.hello)
    expect(frame.umwelt).toBe('stub_umwelt')
    expect((frame.identity as { instanceId?: string }).instanceId).toBe('stub-b-program')
    await wait()
    expect(statusEvents).toEqual([{ type: 'open' }])
    expect(transport.umwelt).toBe('stub_umwelt')
    worker.terminate()
  })
})
