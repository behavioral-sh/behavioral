import { describe, expect, test } from 'bun:test'
import { DAEMON_BRIDGE_PATH, defaultActuatorLanes } from '../b-program.worker.ts'

/**
 * The default actuator leg — the trio over the socket lane (the ruled third
 * lane beside spawn and worker). Pins: the lane names route the composition's
 * trio, each lane is EXACTLY the ruled four-key interface, and the leg lands
 * DARK — construction opens no socket (the lanes connect only when a request
 * routes; the daemon bridge is the thin-faculty-host work, later).
 */
describe('the composition worker\u2019s default actuator leg', () => {
  test('the trio routes by name, each lane exactly the four-key interface', () => {
    const lanes = defaultActuatorLanes('ws://localhost:1').map((build) => build(() => {}))
    expect(lanes.map((lane) => lane.name)).toEqual(['shell', 'store', 'security'])
    for (const lane of lanes) {
      expect(Object.keys(lane).sort()).toEqual(['invalidEventGate', 'name', 'send', 'terminate'])
    }
    for (const lane of lanes) lane.terminate()
  })

  test('the leg lands DARK — construction and idle attach open no socket', async () => {
    // A probe server records every upgrade attempt; the dark leg must never
    // knock. A malformed-URL default (empty origin) would throw at connect —
    // the factory accepts a lazy resolver so the resolution happens at first
    // SEND, not at construction.
    let knocks = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request, srv) => {
        if (srv.upgrade(request)) {
          knocks++
          return undefined
        }
        return new Response('upgrade required', { status: 426 })
      },
      websocket: { message: () => {}, open: () => {}, close: () => {} },
    })
    try {
      const lanes = defaultActuatorLanes(() => `ws://localhost:${server.port}${DAEMON_BRIDGE_PATH}`).map((build) =>
        build(() => {}),
      )
      await Bun.sleep(200)
      expect(knocks).toBe(0)
      // The first send is what knocks — the dark leg wakes only on use.
      lanes[1]?.send({ type: 'store_request', detail: { id: 'dark_1', input: {} } })
      const deadline = Date.now() + 5_000
      while (knocks === 0) {
        if (Date.now() > deadline) throw new Error('the first send never knocked')
        await Bun.sleep(10)
      }
      expect(knocks).toBe(1)
      for (const lane of lanes) lane.terminate()
    } finally {
      server.stop(true)
    }
  })

  test('the conventional daemon-bridge path is the pinned constant', () => {
    expect(DAEMON_BRIDGE_PATH).toBe('/faculty-wire')
  })
})
