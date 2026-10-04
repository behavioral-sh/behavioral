/**
 * The reconcile-mounting composition-worker FIXTURE (the transform-faculty
 * iteration's named-need re-evaluation): the shipped `b-program.worker.ts`
 * glue with the BOOT RECONCILIATION PACK mounted — the mount the thread-
 * persistence landing held DAEMON-ONLY because the bundled artifact lacked
 * the nested jq-worker asset (the boot transforms hung ~30s in Atomics.wait).
 * With the transform faculty bundled and self-contained, the pack's joins
 * evaluate through the fixed fourth lane in the browser — this fixture
 * exists to prove the boot completes, not hangs.
 */

import { FACULTY_MESSAGE_KINDS } from '../../../faculties/faculties.constants.ts'
import { validateStoreRequestEvent } from '../../../faculties/faculties.types.ts'
import { runCompositionWorker } from '../../b-program.worker.ts'
import { pluginThreadsReconcileThreads } from '../../plugin-threads.reconcile.ts'
import { useWorker } from '../../use-worker.ts'

const storeLane = useWorker({
  name: 'store',
  worker: () => new Worker('/store-echo.worker.js'),
  validateRequest: validateStoreRequestEvent,
  resultKind: FACULTY_MESSAGE_KINDS.store_request_result,
})

runCompositionWorker({ actuators: [storeLane], threads: pluginThreadsReconcileThreads })
