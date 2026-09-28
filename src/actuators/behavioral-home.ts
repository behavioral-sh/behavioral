import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The harness home — the single `.behavioral` root.
 *
 * @remarks
 * `BEHAVIORAL_HOME` overrides the default `~/.behavioral`; every home-derived
 * path (store db, traces, config) resolves from here, so pointing the env var
 * at another directory isolates a whole harness instance (tests, evals, cloud).
 *
 * @public
 */
export const behavioralHome = (env: Record<string, string | undefined> = process.env): string =>
  env.BEHAVIORAL_HOME ?? join(homedir(), '.behavioral')
