/**
 * Capped exponential backoff with FULL jitter — the websocket-transport
 * `#retry` shape, extracted to ONE shared home so the algorithm is never
 * copied: the transport's reconnect, the admission outage's judge re-issue,
 * and any future retry budget import it. The delay is uniform in
 * `[0, min(9999, 1000 * 2^n))` — `n` is the zero-based retry count.
 */
export const jitteredBackoffMs = (retryCount: number, random: () => number = Math.random): number => {
  const maxDelay = Math.min(9_999, 1_000 * 2 ** Math.max(0, retryCount))
  return Math.floor(random() * maxDelay)
}
