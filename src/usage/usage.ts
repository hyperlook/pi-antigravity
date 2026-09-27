import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  antigravityHeaders,
  endpointCandidates,
  extractProjectId,
  fetchAvailableModelsCatalog,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  setLastEndpoint,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { isRecord } from "../utils/util.js";
import { safeError } from "../utils/security.js";
import { antigravityFetch } from "../utils/http.js";
import type {
  AccountUsage,
  ApiErrorBody,
  AvailableModelsRaw,
  LoadCodeAssistRaw,
  ModelQuotaRow,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryRaw,
  TierInfo,
  TierRaw,
} from "../types/types.js";

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining?: number): number | undefined {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function progressBar(remaining?: number, width = 20): string {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "n/a";
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return resetTime;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

async function postJson(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ endpoint: string; status: number; data: unknown }> {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });
      setLastEndpoint(endpoint);
      setLastStatus(res.status);
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { raw: text } satisfies ApiErrorBody;
      }
      if (!res.ok) {
        const errorBody = isRecord(data) ? (data as ApiErrorBody) : undefined;
        lastErrorText =
          typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) {
          throw new Error(`${path} failed (${String(res.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: res.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

function parseQuotaSummary(data: unknown): { groups: QuotaGroup[]; description?: string } {
  const summary = (isRecord(data) ? data : {}) as QuotaSummaryRaw;
  const groups: QuotaGroup[] = [];
  for (const group of summary.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data: unknown): {
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
} {
  const raw = (isRecord(data) ? data : {}) as AvailableModelsRaw;
  const modelsObj = raw.models && isRecord(raw.models) ? raw.models : {};
  const models: ModelQuotaRow[] = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function parseTier(value: unknown): TierInfo | undefined {
  if (!isRecord(value)) return undefined;
  const tier = value as TierRaw;
  if (!tier.id && !tier.name) return undefined;
  return {
    id: tier.id ? String(tier.id) : undefined,
    name: tier.name ? String(tier.name) : undefined,
    description: tier.description ? String(tier.description) : undefined,
  };
}

async function loadCodeAssistSafe(token: string) {
  try {
    return await postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });
  } catch {
    return null;
  }
}

/**
 * The user-quota-summary RPC is gated behind a paid subscription: free-tier
 * accounts get 403 SUBSCRIPTION_REQUIRED (#3501). It is best-effort diagnostics
 * only — never let it block the rest of the account data (models, tier, project).
 */
async function fetchQuotaSummarySafe(token: string): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: unknown } }
  | {
      ok: false;
      error: string;
    }
> {
  try {
    return { ok: true, result: await postJson("/v1internal:retrieveUserQuotaSummary", token, {}) };
  } catch (error) {
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg };
  }
}

export async function fetchAccountUsage(apiKeyRaw?: string): Promise<AccountUsage> {
  const creds = parseApiKey(apiKeyRaw);
  const initialProjectId =
    creds.projectId ||
    resolveProjectId({
      token: creds.token,
      credentialProjectId: creds.projectId,
    });

  // Fetch loadCodeAssist, quota summary, and available models all in parallel
  // to minimize command execution latency.
  const [assistResult, summaryRes, available] = await Promise.all([
    loadCodeAssistSafe(creds.token),
    fetchQuotaSummarySafe(creds.token),
    fetchAvailableModelsCatalog(creds.token, initialProjectId),
  ]);

  // Derive project ID from the loadCodeAssist response or stored project ID.
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    token: creds.token,
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId,
  });
  setLastProjectId(projectId);

  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? undefined : summaryRes.error;
  const { groups, description } = summary
    ? parseQuotaSummary(summary.data)
    : { groups: [], description: undefined };
  const { models, defaultAgentModelId } = parseModels(available.data);

  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);

  // Google returns currentTier=free-tier even for Google AI Pro accounts.
  // The real subscription lives in paidTier (e.g. g1-pro-tier / Google AI Pro).
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    projectId,
    endpoint: summary?.endpoint ?? available.endpoint ?? assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    quotaSummaryError,
    models,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };
}

function quotaErrorNote(msg: string): string {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription (free-tier can't use that endpoint). Per-model usage is still available via /antigravity.models.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}

export type WindowQuota = {
  remainingFraction: number;
  resetTime?: string;
};

export type ModelQuotaPair = {
  shortWindow?: WindowQuota;
  weeklyWindow?: WindowQuota;
};

export type DashboardModelQuotas = {
  gemini: ModelQuotaPair;
  claude: ModelQuotaPair;
};

export type DashboardAccountRow = {
  index: number;
  accountId: string;
  email?: string;
  shortLabel: string;
  active: boolean;
  loading?: boolean;
  usage?: AccountUsage;
  error?: string;
};

export type DashboardColorizer = {
  activeMarker: (text: string) => string;
  accountName: (text: string, active?: boolean) => string;
  modelName: (text: string) => string;
  bar: (fraction: number | undefined, barText: string) => string;
  percent: (fraction: number | undefined, text: string) => string;
  countdown: (text: string, isAlert?: boolean) => string;
  dim: (text: string) => string;
  cursor: (text: string) => string;
};

export const plainDashboardColorizer: DashboardColorizer = {
  activeMarker: (text) => text,
  accountName: (text) => text,
  modelName: (text) => text,
  bar: (_fraction, text) => text,
  percent: (_fraction, text) => text,
  countdown: (text) => text,
  dim: (text) => text,
  cursor: (text) => text,
};

export type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export function createThemeColorizer(theme: ThemeLike): DashboardColorizer {
  return {
    activeMarker: (text) => theme.bold(theme.fg("accent", text)),
    accountName: (text, active) =>
      active ? theme.bold(theme.fg("accent", text)) : theme.fg("text", text),
    modelName: (text) => theme.fg("muted", text),
    bar: (fraction, barText) => {
      if (fraction === undefined) return theme.fg("dim", barText);
      if (fraction >= 0.5) return theme.fg("success", barText);
      if (fraction >= 0.2) return theme.fg("warning", barText);
      return theme.fg("error", barText);
    },
    percent: (fraction, text) => {
      if (fraction === undefined) return theme.fg("dim", text);
      if (fraction >= 0.5) return theme.fg("text", text);
      if (fraction >= 0.2) return theme.fg("warning", text);
      return theme.fg("error", text);
    },
    countdown: (text, isAlert) => (isAlert ? theme.fg("warning", text) : theme.fg("dim", text)),
    dim: (text) => theme.fg("dim", text),
    cursor: (text) => theme.fg("accent", text),
  };
}

export function deriveUniqueShortLabels(
  accounts: Array<{ email?: string; accountId: string }>,
): Map<string, string> {
  const result = new Map<string, string>();
  const parsed = accounts.map((acc) => {
    let username: string;
    let domain = "";
    if (acc.email && acc.email.includes("@")) {
      const parts = acc.email.split("@");
      username = parts[0];
      const host = parts[1] || "";
      domain = host.split(".")[0] || host;
    } else {
      username = acc.accountId.length > 8 ? acc.accountId.slice(0, 8) : acc.accountId;
    }
    return { accountId: acc.accountId, username, domain };
  });

  const counts = new Map<string, number>();
  for (const item of parsed) {
    counts.set(item.username, (counts.get(item.username) || 0) + 1);
  }

  for (const item of parsed) {
    if ((counts.get(item.username) || 0) > 1 && item.domain) {
      result.set(item.accountId, `${item.username} (${item.domain})`);
    } else {
      result.set(item.accountId, item.username);
    }
  }
  return result;
}

/**
 * Format reset countdown:
 * - When remaining is 100% (or no resetTime): returns 3 spaces "   "
 * - Short window (5h): >=1h -> " Xh" (e.g. " 2h"), <1h -> "XXm" (e.g. "45m", " 8m"), <=0 -> " 0m"
 * - Weekly window: >=24h -> " Xd" (e.g. " 4d"), <24h -> " Xh" (e.g. "18h"), <1h -> "XXm"
 * Always returns exactly 3 visible characters.
 */
export function formatQuotaCountdown(
  windowType: "5h" | "week",
  resetTime?: string,
  remainingFraction?: number,
  now = Date.now(),
): string {
  if (
    remainingFraction !== undefined &&
    Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100) >= 100
  ) {
    return "   ";
  }
  if (!resetTime) {
    return "   ";
  }
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) {
    return "   ";
  }
  const diffMs = ts - now;
  if (diffMs <= 0) {
    return " 0m";
  }
  const totalMin = Math.round(diffMs / 60000);
  const totalHours = Math.floor(totalMin / 60);
  const days = Math.floor(totalHours / 24);

  if (windowType === "week") {
    if (days >= 1) {
      return `${days}d`.padStart(3);
    }
    if (totalHours >= 1) {
      return `${totalHours}h`.padStart(3);
    }
    return `${Math.max(1, totalMin)}m`.padStart(3);
  }

  // 5h window
  if (totalHours >= 1) {
    return `${totalHours}h`.padStart(3);
  }
  return `${Math.max(1, totalMin)}m`.padStart(3);
}

export function formatQuotaBar(remainingFraction?: number, width = 8): string {
  if (remainingFraction === undefined) {
    return "▱".repeat(width);
  }
  const clamped = Math.max(0, Math.min(1, remainingFraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "▰".repeat(filled) + "▱".repeat(empty);
}

export function formatQuotaPercent(remainingFraction?: number): string {
  if (remainingFraction === undefined) return "  ?%";
  const pct = Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100);
  return `${pct}%`.padStart(4);
}

export function extractDashboardModelQuotas(usage?: AccountUsage): DashboardModelQuotas {
  const result: DashboardModelQuotas = {
    gemini: {},
    claude: {},
  };
  if (!usage) return result;

  let geminiGroup: QuotaGroup | undefined;
  let claudeGroup: QuotaGroup | undefined;

  for (const g of usage.groups || []) {
    const name = (g.displayName || "").toLowerCase();
    if (/claude|gpt|anthropic/.test(name)) {
      claudeGroup = g;
    } else if (/gemini|google/.test(name)) {
      geminiGroup = g;
    }
  }

  const groups = usage.groups || [];
  if (!geminiGroup && !claudeGroup && groups.length > 0) {
    geminiGroup = groups[0];
    claudeGroup = groups[1];
  } else if (!geminiGroup && groups.length > 0 && claudeGroup !== groups[0]) {
    geminiGroup = groups[0];
  } else if (!claudeGroup && groups.length > 1) {
    claudeGroup = groups.find((g) => g !== geminiGroup);
  }

  function resolveBuckets(group?: QuotaGroup): ModelQuotaPair {
    if (!group || !group.buckets || group.buckets.length === 0) return {};
    const pair: ModelQuotaPair = {};
    for (const b of group.buckets) {
      const bName = `${b.displayName || ""} ${b.window || ""} ${b.bucketId || ""}`.toLowerCase();
      const quota: WindowQuota = {
        remainingFraction: b.remainingFraction ?? 0,
        resetTime: b.resetTime,
      };
      if (/week/.test(bName)) {
        pair.weeklyWindow = quota;
      } else if (/5|hour|slide/.test(bName)) {
        pair.shortWindow = quota;
      } else if (b.resetTime) {
        const diff = Date.parse(b.resetTime) - Date.now();
        if (diff > 24 * 3600 * 1000) {
          pair.weeklyWindow = quota;
        } else {
          pair.shortWindow = quota;
        }
      } else {
        if (!pair.shortWindow) pair.shortWindow = quota;
        else if (!pair.weeklyWindow) pair.weeklyWindow = quota;
      }
    }
    return pair;
  }

  result.gemini = resolveBuckets(geminiGroup);
  result.claude = resolveBuckets(claudeGroup);

  // Fallback to per-model quotaInfo if groups were empty (e.g. subscription-required free-tier)
  if (!result.gemini.shortWindow && usage.models && usage.models.length > 0) {
    const geminiModel = usage.models.find(
      (m) => /gemini/i.test(m.modelId) && m.remainingFraction !== undefined,
    );
    if (geminiModel && geminiModel.remainingFraction !== undefined) {
      result.gemini.shortWindow = {
        remainingFraction: geminiModel.remainingFraction,
        resetTime: geminiModel.resetTime,
      };
    }
  }
  if (!result.claude.shortWindow && usage.models && usage.models.length > 0) {
    const claudeModel = usage.models.find(
      (m) => /claude/i.test(m.modelId) && m.remainingFraction !== undefined,
    );
    if (claudeModel && claudeModel.remainingFraction !== undefined) {
      result.claude.shortWindow = {
        remainingFraction: claudeModel.remainingFraction,
        resetTime: claudeModel.resetTime,
      };
    }
  }

  return result;
}

export function renderQuotaCell(
  windowType: "5h" | "week",
  quota?: WindowQuota,
  colorizer: DashboardColorizer = plainDashboardColorizer,
  now = Date.now(),
): string {
  if (!quota) {
    const bar = colorizer.bar(undefined, "▱".repeat(8));
    const pct = colorizer.percent(undefined, "   -");
    const cd = colorizer.countdown("   ");
    return `${bar} ${pct} ${cd}`;
  }
  const frac = quota.remainingFraction;
  const bar = colorizer.bar(frac, formatQuotaBar(frac, 8));
  const pct = colorizer.percent(frac, formatQuotaPercent(frac));
  const isAlert = (windowType === "week" && frac < 0.25) || (windowType === "5h" && frac < 0.2);
  const cd = colorizer.countdown(
    formatQuotaCountdown(windowType, quota.resetTime, frac, now),
    isAlert,
  );
  return `${bar} ${pct} ${cd}`;
}

export function renderAccountDashboardLines(
  row: DashboardAccountRow,
  options?: {
    isSelected?: boolean;
    colorizer?: DashboardColorizer;
    now?: number;
  },
): [string, string] {
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const now = options?.now || Date.now();

  const cursorStr = options?.isSelected ? "> " : "  ";
  const styledCursor = colorizer.cursor(cursorStr);
  const cursorEmpty = "  ";

  // Account column: 13 chars width + 2 spacing spaces to prevent collision with model name
  const nameLabel = row.shortLabel.length > 13 ? `${row.shortLabel.slice(0, 12)}…` : row.shortLabel;
  const styledName = colorizer.accountName(nameLabel.padEnd(13), row.active);
  const accountSpacing = "  ";

  const line1Prefix = `${styledCursor}${styledName}${accountSpacing}`;
  const line2Prefix = `${cursorEmpty}${" ".repeat(13)}${accountSpacing}`;

  const geminiLabel = colorizer.modelName("Gemini  ");
  const claudeLabel = colorizer.modelName("Claude  ");

  const activeBadge = row.active ? `  ${colorizer.activeMarker("● active")}` : "";

  if (row.loading) {
    const loadingText = colorizer.dim("[   fetching quota...    ]");
    return [
      `${line1Prefix}${geminiLabel}${loadingText}${activeBadge}`,
      `${line2Prefix}${claudeLabel}${loadingText}`,
    ];
  }

  if (row.error) {
    const errText = colorizer.countdown(`[ ${oneLine(row.error, 36)} ]`, true);
    return [
      `${line1Prefix}${geminiLabel}${errText}${activeBadge}`,
      `${line2Prefix}${claudeLabel}${colorizer.dim("[                      ]")}`,
    ];
  }

  const quotas = extractDashboardModelQuotas(row.usage);
  const g5h = renderQuotaCell("5h", quotas.gemini.shortWindow, colorizer, now);
  const gWk = renderQuotaCell("week", quotas.gemini.weeklyWindow, colorizer, now);
  const c5h = renderQuotaCell("5h", quotas.claude.shortWindow, colorizer, now);
  const cWk = renderQuotaCell("week", quotas.claude.weeklyWindow, colorizer, now);

  const line1 = `${line1Prefix}${geminiLabel}${g5h}   ${gWk}${activeBadge}`;
  const line2 = `${line2Prefix}${claudeLabel}${c5h}   ${cWk}`;
  return [line1, line2];
}

export function formatAccountsDashboard(
  rows: DashboardAccountRow[],
  options?: {
    selectedIndex?: number;
    colorizer?: DashboardColorizer;
    now?: number;
  },
): string {
  const lines: string[] = [];
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const now = options?.now || Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isSelected = options?.selectedIndex !== undefined && options.selectedIndex === i;
    const [l1, l2] = renderAccountDashboardLines(row, {
      isSelected,
      colorizer,
      now,
    });
    if (lines.length > 0) lines.push("");
    lines.push(l1);
    lines.push(l2);
  }
  return lines.join("\n");
}

export type UsageCommandArgs =
  | { action: "compare" }
  | { action: "current" }
  | { action: "switch"; selector: string }
  | { action: "remove"; selector: string }
  | { action: "invalid"; message: string };

const USAGE_HELP = "Usage: /antigravity.usage [current | <index|email> | remove <index|email>]";

export function parseUsageCommand(args: string): UsageCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "compare" };
  const [head, ...rest] = tokens;
  const keyword = head.toLowerCase();
  if (keyword === "current") {
    return rest.length === 0 ? { action: "current" } : { action: "invalid", message: USAGE_HELP };
  }
  if (keyword === "remove") {
    const selector = rest.join(" ").trim();
    return selector
      ? { action: "remove", selector }
      : { action: "invalid", message: "Usage: /antigravity.usage remove <index|email>" };
  }
  if (rest.length > 0) return { action: "invalid", message: USAGE_HELP };
  return { action: "switch", selector: head };
}

export type AccountUsageView = {
  index: number;
  accountId: string;
  label: string;
  active: boolean;
  usage?: AccountUsage;
  error?: string;
};

export function compactQuotaLabel(usage: AccountUsage): string {
  const parts: string[] = [];
  if (usage.planLabel) parts.push(usage.planLabel);
  for (const group of usage.groups) {
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      parts.push(`${bucket.displayName} ${rem ?? "?"}%`);
    }
  }
  if (parts.length === 0) return usage.quotaSummaryError ? "quota n/a" : "no quota groups";
  const shown = parts.slice(0, 4);
  return parts.length > 4 ? `${shown.join(" · ")} · …` : shown.join(" · ");
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function accountSwitchLabel(row: AccountUsageView): string {
  const detail = row.error
    ? oneLine(row.error)
    : row.usage
      ? compactQuotaLabel(row.usage)
      : "no usage";
  return `${row.active ? "* " : "  "}${row.index}. ${row.label} · ${detail}`;
}

function indentBlock(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

export function formatAccountsUsage(rows: AccountUsageView[]): string {
  const lines = ["Antigravity accounts"];
  for (const row of rows) {
    if (lines.length > 1) lines.push("");
    lines.push(`${row.active ? "*" : " "} ${row.index}. ${row.label}`);
    if (row.error) {
      lines.push(`    ${oneLine(row.error, 200)}`);
      continue;
    }
    if (!row.usage) {
      lines.push("    No usage.");
      continue;
    }
    lines.push(indentBlock(formatUsageSummary(row.usage)));
  }
  return lines.join("\n");
}

export function formatUsageSummary(usage: AccountUsage): string {
  const lines: string[] = [];

  if (usage.planLabel) lines.push(usage.planLabel);

  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    return lines.join("\n");
  }

  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}

export function formatModelsList(usage: AccountUsage, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");

  const rows = opts?.all
    ? usage.models
    : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));

  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }

  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const rem = remainingPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : "",
    ]
      .filter(Boolean)
      .join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  rem ${rem === undefined ? "  ?" : String(rem).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`,
    );
  }
  lines.push("");
  lines.push("Note: remaining % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}

export async function resolveApiKeyFromContext(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider("antigravity");
  } catch {
    return undefined;
  }
}
