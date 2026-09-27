import {
  accountSwitchLabel,
  deriveUniqueShortLabels,
  formatAccountsDashboard,
  formatAccountsUsage,
  extractDashboardModelQuotas,
  formatQuotaBar,
  formatQuotaCountdown,
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

// Test short label derivation
const labelMap = deriveUniqueShortLabels([
  { accountId: "1", email: "look@gmail.com" },
  { accountId: "2", email: "work@company.com" },
  { accountId: "3", email: "look@qq.com" },
]);
expect(labelMap.get("1")).toBe("look (gmail)");
expect(labelMap.get("2")).toBe("work");
expect(labelMap.get("3")).toBe("look (qq)");

const sameOrg = deriveUniqueShortLabels([
  { accountId: "a", email: "user@company.com" },
  { accountId: "b", email: "user@company.org" },
]);
expect(sameOrg.get("a")).toBe("user (com)");
expect(sameOrg.get("b")).toBe("user (org)");
expect(new Set(sameOrg.values()).size).toBe(2);

// Test quota bar
expect(formatQuotaBar(1.0, 8)).toBe("▰▰▰▰▰▰▰▰");
expect(formatQuotaBar(0.5, 8)).toBe("▰▰▰▰▱▱▱▱");
expect(formatQuotaBar(0.0, 8)).toBe("▱▱▱▱▱▱▱▱");

// Test countdown format
const testNow = Date.now();
// 100% full: blank 3 spaces (including near-1.0 floats like 0.9995)
expect(formatQuotaCountdown("5h", new Date(testNow + 7200000).toISOString(), 1.0, testNow)).toBe("   ");
expect(formatQuotaCountdown("5h", new Date(testNow + 7200000).toISOString(), 0.9995, testNow)).toBe("   ");
// 5h window: >=1h -> " Xh"
expect(formatQuotaCountdown("5h", new Date(testNow + 7200000).toISOString(), 0.8, testNow)).toBe(" 2h");
// 5h window: <1h -> "XXm"
expect(formatQuotaCountdown("5h", new Date(testNow + 2700000).toISOString(), 0.8, testNow)).toBe("45m");
// Weekly window: >=24h -> " Xd"
expect(formatQuotaCountdown("week", new Date(testNow + 4 * 86400000).toISOString(), 0.8, testNow)).toBe(" 4d");
// Weekly window: <24h -> " Xh"
expect(formatQuotaCountdown("week", new Date(testNow + 18 * 3600000).toISOString(), 0.8, testNow)).toBe("18h");

// Test two-row dashboard formatting
const dashboardText = formatAccountsDashboard([
  {
    index: 1,
    accountId: "1",
    shortLabel: "look",
    active: true,
    usage: {
      ...baseUsage,
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            { displayName: "5-hour window", remainingFraction: 0.85, resetTime: new Date(testNow + 7200000).toISOString() },
            { displayName: "Weekly limit", remainingFraction: 1.0, resetTime: new Date(testNow + 4 * 86400000).toISOString() },
          ],
        },
        {
          displayName: "Claude & GPT",
          buckets: [
            { displayName: "5-hour window", remainingFraction: 0.40, resetTime: new Date(testNow + 2700000).toISOString() },
            { displayName: "Weekly limit", remainingFraction: 0.90, resetTime: new Date(testNow + 2 * 86400000).toISOString() },
          ],
        },
      ],
    },
  },
  {
    index: 2,
    accountId: "2",
    shortLabel: "work",
    active: false,
    loading: true,
  },
], { now: testNow });

expect(dashboardText).toContain("look");
expect(dashboardText).toContain("● active");
expect(dashboardText).toContain("Gemini");
expect(dashboardText).toContain("Claude");
expect(dashboardText).toContain("85%");
expect(dashboardText).toContain("100%");
expect(dashboardText).toContain("fetching quota");
expect(dashboardText).not.toContain("> ");

const longNames = formatAccountsDashboard([
  {
    index: 1,
    accountId: "1",
    shortLabel: "christopher (gmail)",
    active: false,
    loading: true,
  },
  {
    index: 2,
    accountId: "2",
    shortLabel: "christopher (qq)",
    active: false,
    loading: true,
  },
]);
expect(longNames).toContain("(gmail)");
expect(longNames).toContain("(qq)");
expect(longNames).not.toContain("christopher (gmail)");

const named = extractDashboardModelQuotas(
  {
    ...baseUsage,
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          {
            bucketId: "bucket-5",
            displayName: "Limit",
            remainingFraction: 0.2,
            resetTime: new Date(testNow + 4 * 86400000).toISOString(),
          },
          {
            bucketId: "weekly-5",
            displayName: "Weekly limit",
            remainingFraction: 0.8,
            resetTime: new Date(testNow + 3 * 86400000).toISOString(),
          },
          {
            bucketId: "slide",
            displayName: "5-hour window",
            remainingFraction: 0.4,
            resetTime: new Date(testNow + 7200000).toISOString(),
          },
        ],
      },
      {
        displayName: "Image generation",
        buckets: [
          {
            bucketId: "img",
            displayName: "5-hour window",
            remainingFraction: 0.1,
          },
        ],
      },
    ],
  },
  testNow,
);
expect(named.gemini.weeklyWindow?.remainingFraction).toBe(0.8);
expect(named.gemini.shortWindow?.remainingFraction).toBe(0.4);
expect(named.claude.shortWindow).toBeUndefined();

const unnamed = extractDashboardModelQuotas(
  {
    ...baseUsage,
    groups: [
      {
        displayName: "Quota group",
        buckets: [{ bucketId: "a", displayName: "Limit", remainingFraction: 0.6 }],
      },
      {
        displayName: "",
        buckets: [{ bucketId: "b", displayName: "Limit", remainingFraction: 0.3 }],
      },
    ],
  },
  testNow,
);
expect(unnamed.gemini.shortWindow?.remainingFraction).toBe(0.6);
expect(unnamed.claude.shortWindow?.remainingFraction).toBe(0.3);

console.log("Usage formatter tests passed!");
