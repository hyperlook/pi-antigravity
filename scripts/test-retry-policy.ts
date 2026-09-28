/**
 * Table-driven tests for isHardQuotaWall and retry policy semantics.
 *
 * Acceptance criteria (from docs/ISSUE-stream-layer-decoupling.md):
 *  - per-minute/RPM/TPM/QPS rate-limit text is NOT treated as a hard quota wall
 *  - "Individual quota reached", "Resets in …", and standalone
 *    "quota exceeded" / "exceeded your" / "daily limit" ARE hard quota walls
 *  - retry counts unchanged: 2 empty-response retries with 500ms → 1000ms backoff
 */
import { isHardQuotaWall } from "../src/runtime/retry.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// isHardQuotaWall table-driven tests
// ---------------------------------------------------------------------------
interface TestCase {
  name: string;
  body: string;
  expected: boolean;
}

const cases: TestCase[] = [
  // ── Hard quota walls (expected: true) ─────────────────────────────────
  {
    name: "Individual quota reached (plain)",
    body: "Individual quota reached. Resets in 3h.",
    expected: true,
  },
  {
    name: "Individual quota reached (no reset hint)",
    body: '{"error":{"code":429,"message":"Individual quota reached"}}',
    expected: true,
  },
  {
    name: "Resets in hint without quota keywords",
    body: "Resource has been exhausted (e.g. check quota). Resets in 24h.",
    expected: true,
  },
  {
    name: "Reset in (singular) hint",
    body: "Limit applied. Reset in 6 hours.",
    expected: true,
  },
  {
    name: "quota exceeded (standalone)",
    body: "quota exceeded for this project",
    expected: true,
  },
  {
    name: "exceeded your (standalone)",
    body: "You have exceeded your daily allocation.",
    expected: true,
  },
  {
    name: "daily limit (standalone)",
    body: "daily limit has been reached for this account",
    expected: true,
  },
  {
    name: "Quota exceeded in JSON error",
    body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded."}}',
    expected: true,
  },

  // ── Transient rate limits (expected: false) ───────────────────────────
  {
    name: "per minute rate limit",
    body: "Rate limit exceeded: 15 requests per minute. quota exceeded",
    expected: false,
  },
  {
    name: "RPM indicator",
    body: "Resource exhausted. RPM limit reached. quota exceeded",
    expected: false,
  },
  {
    name: "TPM indicator",
    body: "Token limit TPM exceeded. exceeded your allocation.",
    expected: false,
  },
  {
    name: "QPS indicator",
    body: "QPS limit reached. daily limit exceeded.",
    expected: false,
  },
  {
    name: "per second rate limit",
    body: "per second limit reached. quota exceeded",
    expected: false,
  },
  {
    name: "generic rate_limit without quota keywords",
    body: "rate_limit: too many requests, slow down",
    expected: false,
  },
  {
    name: "generic rate-limit with quota keywords",
    body: "rate-limit exceeded. quota exceeded.",
    expected: false,
  },
  {
    name: "RESOURCE_EXHAUSTED transient (no quota/reset keywords)",
    body: "Resource has been exhausted (e.g. check quota).",
    expected: false,
  },
  {
    name: "empty body",
    body: "",
    expected: false,
  },
  {
    name: "unrelated 429 message",
    body: "Too many requests. Please try again later.",
    expected: false,
  },
  {
    name: "per min variant",
    body: "Exceeded 100 requests per min. quota exceeded.",
    expected: false,
  },
  {
    name: "rpm lowercase",
    body: "rpm limit: quota exceeded for model",
    expected: false,
  },
];

async function testIsHardQuotaWall(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const tc of cases) {
    const actual = isHardQuotaWall(tc.body);
    if (actual !== tc.expected) {
      console.error(
        `✗ "${tc.name}": expected ${tc.expected}, got ${actual}\n  body: ${JSON.stringify(tc.body)}`,
      );
      failed++;
    } else {
      passed++;
    }
  }
  if (failed > 0) {
    throw new Error(`isHardQuotaWall: ${failed}/${cases.length} cases failed`);
  }
  console.log(`isHardQuotaWall: ${passed} table-driven cases passed`);
}

// ---------------------------------------------------------------------------
// Verify friendlyAntigravityError uses isHardQuotaWall consistently
// ---------------------------------------------------------------------------
async function testFriendlyErrorConsistency(): Promise<void> {
  // Import friendlyAntigravityError — it is exported from stream.ts
  const { friendlyAntigravityError } = await import("../src/stream/stream.js");

  // Hard quota walls should produce "Quota reached." messages
  const hardCases = [
    "Individual quota reached. Resets in 3h.",
    "Quota exceeded for this project.",
    "You have exceeded your daily allocation.",
    '{"error":{"code":429,"message":"daily limit reached"}}',
  ];
  for (const body of hardCases) {
    const msg = friendlyAntigravityError(429, body);
    assert(
      /Quota reached/i.test(msg),
      `Expected 'Quota reached' for hard wall body: ${JSON.stringify(body)}, got: ${msg}`,
    );
  }

  // Transient rate limits should produce "Rate limited" messages
  const softCases = [
    "Rate limit exceeded: 15 requests per minute",
    "RPM limit reached, try again shortly",
    "Resource has been exhausted (e.g. check quota).",
    "Too many requests. Please try again later.",
  ];
  for (const body of softCases) {
    const msg = friendlyAntigravityError(429, body);
    assert(
      /Rate limited|retrying automatically/i.test(msg),
      `Expected transient message for body: ${JSON.stringify(body)}, got: ${msg}`,
    );
  }

  // Extra "limit reached" pattern (only in friendlyAntigravityError, not in isHardQuotaWall)
  // should still produce "Quota reached." to preserve the existing credential rotation trigger
  const extraPatternBody = "Account limit reached, contact support.";
  const extraMsg = friendlyAntigravityError(429, extraPatternBody);
  assert(
    /Quota reached/i.test(extraMsg),
    `Expected 'Quota reached' for 'limit reached' pattern, got: ${extraMsg}`,
  );

  console.log("friendlyAntigravityError: consistency with isHardQuotaWall verified");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await testIsHardQuotaWall();
  await testFriendlyErrorConsistency();
  console.log("All retry policy tests passed!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
