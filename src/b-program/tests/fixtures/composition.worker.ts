/**
 * The composition-worker FIXTURE entry (rewire slice 2): the shipped
 * `b-program.worker.ts` glue composed with the fixture's actuator leg — the
 * store lane over a real classic echo worker (`/store-echo.worker.js`) built
 * through the REAL `useWorker` primitive. The fixed three faculty workers
 * spawn from the composition bundle's own literals (the fixture server serves
 * their bundled classic artifacts at the resolved paths); systemOne/systemTwo
 * mount endpoint-less unless the page's attach carries models.
 */

import { FACULTY_MESSAGE_KINDS } from '../../../faculties/faculties.constants.ts'
import { validateStoreRequestEvent } from '../../../faculties/faculties.types.ts'
import { runCompositionWorker } from '../../b-program.worker.ts'
import { useWorker } from '../../use-worker.ts'

const storeLane = useWorker({
  name: 'store',
  worker: () => new Worker('/store-echo.worker.js'),
  validateRequest: validateStoreRequestEvent,
  resultKind: FACULTY_MESSAGE_KINDS.store_request_result,
})

runCompositionWorker({ actuators: [storeLane] })
