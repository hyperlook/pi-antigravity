import {
  accountSwitchLabel,
  formatAccountsUsage,
  formatUsageSummary,
  parseUsageCommand,
} from "../src/usage/usage.js";
import { expect } from "bun:test";

console.log("Running usage formatter tests...");

const baseUsage = {
  projectId: "test",
  endpoint: "test",
  groups: [],
  models: [],
  fetchedAt: Date.now(),
};

// Regression fixture for #3501 error message
const message3501 =
  "/v1internal:retrieveUserQuotaSummary failed: You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. Please contact your administrator to request a license. (#3501)";

const out = formatUsageSummary({
  ...baseUsage,
  quotaSummaryError: message3501,
});

expect(
  out.includes("needs a paid subscription") || out.includes("free-tier can't use that endpoint"),
).toBe(true);

expect(parseUsageCommand("").action).toBe("compare");
expect(parseUsageCommand("current")).toEqual({ action: "current" });
expect(parseUsageCommand("remove a@example.com")).toEqual({
  action: "remove",
  selector: "a@example.com",
});
expect(parseUsageCommand("2")).toEqual({ action: "switch", selector: "2" });
expect(parseUsageCommand("switch 2").action).toBe("invalid");
expect(parseUsageCommand("remove").action).toBe("invalid");

const comparison = formatAccountsUsage([
  {
    index: 1,
    accountId: "a@example.com",
    label: "a@example.com",
    active: true,
    usage: {
      ...baseUsage,
      planLabel: "Google AI Pro",
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            {
              bucketId: "gemini",
              displayName: "Gemini",
              remainingFraction: 0.4,
            },
          ],
        },
      ],
    },
  },
  {
    index: 2,
    accountId: "b@example.com",
    label: "b@example.com",
    active: false,
    error: "refresh failed",
  },
]);
expect(comparison).toContain("* 1. a@example.com");
expect(comparison).toContain("Google AI Pro");
expect(comparison).toContain("40% left");
expect(comparison).toContain("2. b@example.com");
expect(comparison).toContain("refresh failed");
expect(accountSwitchLabel({
  index: 1,
  accountId: "a@example.com",
  label: "a@example.com",
  active: true,
  usage: {
    ...baseUsage,
    planLabel: "Google AI Pro",
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          { bucketId: "gemini", displayName: "Gemini", remainingFraction: 0.4 },
        ],
      },
    ],
  },
})).toBe("* 1. a@example.com · Google AI Pro · Gemini 40%");

console.log("Usage formatter tests passed!");
