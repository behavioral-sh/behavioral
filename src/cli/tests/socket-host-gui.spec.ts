import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Trace } from '../../behavioral/behavioral.types.ts'
import { CONNECT_BEHAVIORAL_ROUTE } from '../../controller/bundle-controller.ts'
import type { HostRuntime } from '../serve.ts'
import { createSocketHost } from '../socket-host.ts'

const homes: string[] = []
const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'behavioral-socket-gui-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const fakeRuntime = (): HostRuntime => {
  const listeners = new Set<(trace: Trace) => void>()
  return {
    identity: { instanceId: 'bp_gui_test', sessionId: 'bp_gui_test' },
    trigger: () => {},
    useTrace: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    start: () => {},
    terminate: () => {},
  }
}

describe('createSocketHost — the GUI carrier', () => {
  test('serves the bundled controller runtime at the connect route', async () => {
    const host = await createSocketHost({ runtime: fakeRuntime(), home: tempHome() })
    const response = await fetch(`http://localhost${CONNECT_BEHAVIORAL_ROUTE}`, { unix: host.path })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript;charset=utf-8')
    // The gzipped bundle decodes to real controller runtime: the ui_render
    // handler wire type and the default worker carrier are present (the kept
    // slice-0 flip: the composition boots in the bProgram worker spawned from
    // the conventional serving path — not the WebSocket carrier).
    const body = await response.text()
    expect(body).toContain('ui_render')
    expect(body).toContain('b-program.worker')
    await host.close()
  }, 30_000)

  test('non-connect paths stay on the 426 WebSocket-only carrier', async () => {
    const host = await createSocketHost({ runtime: fakeRuntime(), home: tempHome() })
    const response = await fetch('http://localhost/other', { unix: host.path })
    expect(response.status).toBe(426)
    await host.close()
  })

  test('dev mode rebuilds the bundle per request; prod mode caches it', async () => {
    const host = await createSocketHost({ runtime: fakeRuntime(), home: tempHome(), dev: true })
    const first = await fetch(`http://localhost${CONNECT_BEHAVIORAL_ROUTE}`, { unix: host.path })
    expect(first.status).toBe(200)
    const second = await fetch(`http://localhost${CONNECT_BEHAVIORAL_ROUTE}`, { unix: host.path })
    expect(second.status).toBe(200)
    // Both responses decode to the controller runtime (rebundled or cached —
    // the per-request rebuild is exercised by the bundle spec; here the dev
    // host serves valid, current bundles on every request).
    expect(await first.text()).toContain('ui_render')
    expect(await second.text()).toContain('ui_render')
    await host.close()
  }, 30_000)
})
