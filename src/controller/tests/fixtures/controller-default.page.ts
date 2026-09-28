/**
 * The controller-default probe page — the serving contract's proof.
 *
 * Constructs the {@link Controller} with NO injected transport: the default
 * must spawn the dedicated module Worker from the conventional
 * {@link B_PROGRAM_WORKER_PATH} serving path (the flipped `#getTransport`)
 * and reach it — attach → hello → open. The page has a `b-trigger` button;
 * clicking it sends a `ui_event` through the default carrier, and the stub
 * worker's echo renders a marker into the DOM — the full default path made
 * page-observable. Page-level `error` events are recorded (`__defaultProbe`)
 * so the no-route leg can pin "fails visible, never throws into the page".
 */
import { Controller } from '../../controller.ts'

type DefaultProbeState = { errors: string[] }
const state: DefaultProbeState = { errors: [] }
;(window as unknown as { __defaultProbe: DefaultProbeState }).__defaultProbe = state

window.addEventListener('error', (event) => {
  state.errors.push(event instanceof ErrorEvent ? event.message : 'page error')
})

const controller = new Controller({})
;(window as unknown as { __controller: unknown }).__controller = controller
void controller.connect()
