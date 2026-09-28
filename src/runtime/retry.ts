/**
 * Pure functions for retry-plan classification.
 *
 * `isHardQuotaWall` determines whether a 429 response represents a permanent
 * quota wall (daily limit, individual quota, billing cap) rather than a
 * transient rate-limit burst (per-minute RPM/TPM/QPS). When this returns true
 * the caller should skip endpoint drift and proceed to credential rotation or
 * abort — retrying the same credentials will not help.
 *
 * The classifier mirrors the semantics that were previously inline at two
 * locations in `src/stream/stream.ts` (the endpoint-loop break and the
 * `friendlyAntigravityError` formatter). Extracting it here makes it directly
 * testable without executing a real request path.
 */

/**
 * Returns `true` when a 429 response body indicates a **hard** quota wall that
 * will not resolve within a short retry window.
 *
 * Hard quota signals (any one is sufficient):
 *  - "Individual quota reached"
 *  - "Resets in …" (Google's daily/multi-hour reset hint)
 *  - Quota keywords ("quota exceeded", "exceeded your", "daily limit") **unless**
 *    the body also mentions per-minute/second rate limiting (RPM/TPM/QPS) or
 *    contains a generic "rate limit" phrase, which indicate transient throttling.
 *
 * The function is intentionally **status-unaware**: callers must gate on
 * `status === 429` themselves. This keeps the predicate composable and avoids
 * encoding HTTP semantics into a string classifier.
 */
export function isHardQuotaWall(body: string): boolean {
  if (/Individual quota reached/i.test(body)) return true;
  if (/Resets? in /i.test(body)) return true;

  const isMinuteOrSecondLimit = /per\s*(?:minute|second|min|sec)|rpm|tpm|qps/i.test(body);
  if (isMinuteOrSecondLimit) return false;
  if (/rate.?limit/i.test(body)) return false;

  return /quota exceeded|exceeded your|daily limit/i.test(body);
}
