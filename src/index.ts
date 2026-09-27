import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  activateAccount,
  getApiKey,
  listAccounts,
  loginAntigravity,
  readAccountApiKeys,
  refreshAntigravityToken,
  rememberAccount,
  removeAccount,
  updateRememberedAccount,
} from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import {
  DEFAULT_IMAGE_MODEL,
  generateAntigravityImage,
  IMAGE_ASPECT_RATIOS,
  parseImageCommandArgs,
} from "./image/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
  resolvedCatalog,
} from "./models/index.js";
import {
  executeUrlContext,
  executeWebSearch,
  UrlContextSchema,
  WebSearchSchema,
} from "./search/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AccountUsage } from "./types/types.js";
import {
  createThemeColorizer,
  deriveUniqueShortLabels,
  fetchAccountUsage,
  formatAccountsDashboard,
  formatModelsList,
  formatUsageSummary,
  parseUsageCommand,
  resolveApiKeyFromContext,
  type DashboardAccountRow,
  type ThemeLike,
} from "./usage/index.js";
import { maskEmail, redactSecrets } from "./utils/index.js";

/**
 * Pi's interactive `notify` writes into the chat transcript. `console.log` in that
 * mode prints to the raw terminal and paints over the TUI. Use one channel only.
 */
function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

async function loginAndRemember(
  callbacks: Parameters<typeof loginAntigravity>[0],
): ReturnType<typeof loginAntigravity> {
  const credentials = await loginAntigravity(callbacks);
  rememberAccount(credentials);
  return credentials;
}

async function refreshAndRemember(
  credentials: Parameters<typeof refreshAntigravityToken>[0],
): ReturnType<typeof refreshAntigravityToken> {
  const refreshed = await refreshAntigravityToken(credentials);
  updateRememberedAccount(credentials, refreshed);
  return refreshed;
}

async function withUsage(
  ctx: ExtensionCommandContext,
  fn: (usage: Awaited<ReturnType<typeof fetchAccountUsage>>) => string,
  apiKeyOverride?: string,
): Promise<void> {
  try {
    const apiKey = apiKeyOverride ?? (await resolveApiKeyFromContext(ctx));
    if (!apiKey) {
      emitCommandOutput(
        ctx,
        "No Antigravity credentials. Run /login antigravity first.",
        "warning",
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage…", "info");
    const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
    emitCommandOutput(ctx, fn(usage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, `Antigravity usage failed: ${redactSecrets(msg)}`, "warning");
  }
}

function usageArgumentCompletions(prefix: string) {
  const allAccounts = listAccounts();
  const shortLabels = deriveUniqueShortLabels(allAccounts);
  const accounts = allAccounts.map((account, index) => {
    const selector = account.email || String(index + 1);
    const short = shortLabels.get(account.accountId) || account.email || account.accountId;
    return {
      selector,
      label: `${account.active ? "* " : ""}${index + 1}. ${short}`,
    };
  });
  const text = prefix.trimStart();
  const removeMatch = /^remove\s+(.*)$/i.exec(text);
  if (removeMatch) {
    const rest = removeMatch[1].trim().toLowerCase();
    return accounts
      .filter(
        (account) =>
          account.selector.toLowerCase().includes(rest) ||
          account.label.toLowerCase().includes(rest),
      )
      .map((account) => ({
        value: `remove ${account.selector}`,
        label: account.label,
        description: "Unlink this account",
      }));
  }
  const needle = text.toLowerCase();
  return [
    { value: "current", label: "current", description: "Active account only, no switch" },
    { value: "remove", label: "remove", description: "Unlink an account" },
    ...accounts.map((account) => ({
      value: account.selector,
      label: account.label,
      description: "Switch to this account",
    })),
  ].filter(
    (item) =>
      item.value.toLowerCase().startsWith(needle) ||
      item.label.toLowerCase().includes(needle) ||
      item.description.toLowerCase().includes(needle),
  );
}

async function removeLinkedAccount(ctx: ExtensionCommandContext, selector: string): Promise<void> {
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Remove Antigravity account",
      `Unlink ${selector}? This does not revoke the Google token.`,
    );
    if (!ok) {
      emitCommandOutput(ctx, "Account removal cancelled.");
      return;
    }
  }
  const remaining = await removeAccount(selector);
  const next = remaining ? ` Active account is now ${remaining.email || remaining.accountId}.` : "";
  emitCommandOutput(ctx, `Antigravity account removed.${next}`);
}

async function switchAndShowUsage(ctx: ExtensionCommandContext, selector: string): Promise<void> {
  const account = await activateAccount(selector);
  const label = account.email || account.accountId;
  await withUsage(
    ctx,
    (usage) => `Active Antigravity account: ${label}\n\n${formatUsageSummary(usage)}`,
    getApiKey(account),
  );
}

type DashboardResult =
  | { action: "switch"; target: DashboardAccountRow }
  | { action: "remove"; target: DashboardAccountRow }
  | { action: "close" };

class AntigravityDashboardComponent {
  private rows: DashboardAccountRow[];
  private selectedIndex: number;
  private confirmDeleteIndex?: number;
  private theme: ThemeLike;
  private onDone: (result: DashboardResult) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    rows: DashboardAccountRow[],
    initialIndex: number,
    theme: ThemeLike,
    onDone: (result: DashboardResult) => void,
  ) {
    this.rows = rows;
    this.selectedIndex = Math.max(0, Math.min(initialIndex, rows.length - 1));
    this.theme = theme;
    this.onDone = onDone;
  }

  updateRowUsage(index: number, usage: AccountUsage): void {
    if (this.rows[index]) {
      this.rows[index].loading = false;
      this.rows[index].usage = usage;
      this.invalidate();
    }
  }

  setRowError(index: number, error: string): void {
    if (this.rows[index]) {
      this.rows[index].loading = false;
      this.rows[index].error = error;
      this.invalidate();
    }
  }

  handleInput(data: string): void {
    if (this.rows.length === 0) {
      this.onDone({ action: "close" });
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.confirmDeleteIndex !== undefined) {
        this.confirmDeleteIndex = undefined;
        this.invalidate();
        return;
      }
      this.onDone({ action: "close" });
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.confirmDeleteIndex = undefined;
      this.selectedIndex = (this.selectedIndex - 1 + this.rows.length) % this.rows.length;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.confirmDeleteIndex = undefined;
      this.selectedIndex = (this.selectedIndex + 1) % this.rows.length;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "return")) {
      const selected = this.rows[this.selectedIndex];
      if (selected) {
        this.onDone({ action: "switch", target: selected });
      }
      return;
    }

    if (matchesKey(data, "d") || matchesKey(data, "x")) {
      if (this.confirmDeleteIndex === this.selectedIndex) {
        const selected = this.rows[this.selectedIndex];
        if (selected) {
          this.onDone({ action: "remove", target: selected });
        }
      } else {
        this.confirmDeleteIndex = this.selectedIndex;
        this.invalidate();
      }
      return;
    }

    // Any other key resets delete confirmation
    if (this.confirmDeleteIndex !== undefined) {
      this.confirmDeleteIndex = undefined;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;
    const colorizer = createThemeColorizer(th);

    // Header
    const title = th.bold(th.fg("accent", "Antigravity 控制中心"));
    const hr = th.fg("borderMuted", "─".repeat(Math.max(10, width - 4)));
    lines.push("");
    lines.push(`  ${title}`);
    lines.push(`  ${hr}`);
    lines.push("");

    // Body: Two-row per account
    const body = formatAccountsDashboard(this.rows, {
      selectedIndex: this.selectedIndex,
      colorizer,
      now: Date.now(),
    });
    for (const line of body.split("\n")) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }

    // Footer
    lines.push("");
    lines.push(`  ${hr}`);
    if (this.confirmDeleteIndex !== undefined) {
      const target = this.rows[this.confirmDeleteIndex];
      const targetName = target ? target.shortLabel : "该账号";
      lines.push(
        truncateToWidth(
          `  ${th.bold(th.fg("warning", `⚠️  确定要解绑 [${targetName}] 吗？再次按 d 确认，按 Esc 取消`))}`,
          width,
        ),
      );
    } else {
      const hint = th.fg("dim", "↑↓ 移动 · Enter 切换 · d 删除 · Esc 退出");
      lines.push(truncateToWidth(`  ${hint}`, width));
    }
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

async function compareAndMaybeSwitch(ctx: ExtensionCommandContext): Promise<void> {
  const access = await readAccountApiKeys();
  if (access.length === 0) {
    emitCommandOutput(
      ctx,
      "No linked Antigravity accounts. Run /login antigravity to add one.",
      "warning",
    );
    return;
  }

  const shortLabelMap = deriveUniqueShortLabels(access);
  const rows: DashboardAccountRow[] = access.map((acc, index) => ({
    index: index + 1,
    accountId: acc.accountId,
    email: acc.email,
    shortLabel: shortLabelMap.get(acc.accountId) || acc.email || acc.accountId,
    active: acc.active,
    loading: true,
  }));

  const activeIndex = rows.findIndex((r) => r.active);
  const initialIndex = activeIndex >= 0 ? activeIndex : 0;

  // 1. Interactive TUI Mode: Instant zero-latency launch with async progressive loading
  if (ctx.hasUI && ctx.mode === "tui") {
    let component: AntigravityDashboardComponent | undefined;

    // Start background fetch for all accounts in parallel immediately
    const fetchPromises = access.map(async (account, index) => {
      if (!account.apiKey) {
        const errMsg = redactSecrets(account.error || "No credentials");
        rows[index].loading = false;
        rows[index].error = errMsg;
        component?.setRowError(index, errMsg);
        return;
      }
      try {
        const usage = await runWithDiagnostics(() => fetchAccountUsage(account.apiKey), {
          commit: account.active,
        });
        rows[index].loading = false;
        rows[index].usage = usage;
        component?.updateRowUsage(index, usage);
      } catch (error) {
        const msg = redactSecrets(error instanceof Error ? error.message : String(error));
        rows[index].loading = false;
        rows[index].error = msg;
        component?.setRowError(index, msg);
      }
    });

    const result = await ctx.ui.custom<DashboardResult>((tui, theme, _kb, done) => {
      component = new AntigravityDashboardComponent(rows, initialIndex, theme, (res) => done(res));
      // Trigger render when fetch updates arrive
      fetchPromises.forEach((p) => {
        void p.then(() => tui.requestRender());
      });
      return component;
    });

    if (!result || result.action === "close") return;

    if (result.action === "switch") {
      if (result.target.active) {
        emitCommandOutput(ctx, `当前已处于账号 ${result.target.shortLabel}`);
        return;
      }
      const switched = await activateAccount(String(result.target.index));
      emitCommandOutput(
        ctx,
        `Switched to Antigravity account: ${result.target.shortLabel} (${switched.email || switched.accountId})`,
      );
      return;
    }

    if (result.action === "remove") {
      const remaining = await removeAccount(String(result.target.index));
      const next = remaining
        ? ` Active account is now ${remaining.email || remaining.accountId}.`
        : "";
      emitCommandOutput(ctx, `Antigravity account [${result.target.shortLabel}] unlinked.${next}`);
      return;
    }
    return;
  }

  // 2. Non-interactive / Headless / RPC mode: Wait all and print formatted dashboard
  await Promise.all(
    access.map(async (account, index) => {
      if (!account.apiKey) {
        rows[index].loading = false;
        rows[index].error = redactSecrets(account.error || "No credentials");
        return;
      }
      try {
        const usage = await runWithDiagnostics(() => fetchAccountUsage(account.apiKey), {
          commit: account.active,
        });
        rows[index].loading = false;
        rows[index].usage = usage;
      } catch (error) {
        const msg = redactSecrets(error instanceof Error ? error.message : String(error));
        rows[index].loading = false;
        rows[index].error = msg;
      }
    }),
  );

  const dashboardOutput = formatAccountsDashboard(rows, {
    selectedIndex: initialIndex,
    now: Date.now(),
  });
  const hint =
    "Switch: /antigravity.usage <index|email>\nRemove: /antigravity.usage remove <index|email>\nActive only: /antigravity.usage current";
  emitCommandOutput(ctx, `Antigravity accounts\n\n${dashboardOutput}\n\n${hint}`);
}

async function handleUsageCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseUsageCommand(args);
  try {
    if (parsed.action === "invalid") {
      emitCommandOutput(ctx, parsed.message, "warning");
      return;
    }
    if (parsed.action === "current") {
      await withUsage(ctx, formatUsageSummary);
      return;
    }
    if (parsed.action === "remove") {
      await removeLinkedAccount(ctx, parsed.selector);
      return;
    }
    if (parsed.action === "switch") {
      await switchAndShowUsage(ctx, parsed.selector);
      return;
    }
    await compareAndMaybeSwitch(ctx);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, redactSecrets(msg), "error");
  }
}

export default function (pi: ExtensionAPI): void {
  registerApiProvider({
    api: ANTIGRAVITY_API,
    stream: streamAntigravity,
    streamSimple: streamAntigravity,
  });

  const initialCatalog = getCurrentAntigravityCatalog();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: initialCatalog.models,
    refreshModels: refreshAntigravityModels,
    oauth: {
      name: PROVIDER_NAME,
      login: loginAndRemember,
      refreshToken: refreshAndRemember,
      getApiKey,
    },
    streamSimple: streamAntigravity,
  });

  pi.registerCommand("antigravity.usage", {
    description:
      "Compare linked account quota and switch (current | <index|email> | remove <index|email>)",
    getArgumentCompletions: (prefix) => usageArgumentCompletions(prefix),
    handler: handleUsageCommand,
  });

  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withUsage(ctx, (usage) => formatModelsList(usage, { all }));
    },
  });

  pi.registerCommand("antigravity.refresh", {
    description: "Force refresh Antigravity dynamic model catalog",
    handler: async (_args, ctx) => {
      const apiKey = await resolveApiKeyFromContext(ctx);
      if (!apiKey) {
        emitCommandOutput(
          ctx,
          "No Antigravity credentials. Run /login antigravity first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Refreshing Antigravity models…", "info");
      try {
        if (typeof ctx.modelRegistry?.refresh === "function") {
          const result = await ctx.modelRegistry.refresh({
            force: true,
            providers: [PROVIDER_ID],
          });
          if (result?.errors?.has(PROVIDER_ID)) {
            throw result.errors.get(PROVIDER_ID)!;
          }
        } else {
          const discovered = await discoverAntigravityModels(apiKey);
          const next = resolvedCatalog(discovered, getCurrentAntigravityCatalog());
          if (discovered.models.length > 0) {
            applyAntigravityCatalog(next);
          }
        }
        const catalog = getCurrentAntigravityCatalog();
        const count = catalog.models.length;
        const sample = catalog.models
          .slice(0, 4)
          .map((m) => m.name || m.id)
          .join(", ");
        emitCommandOutput(
          ctx,
          `Antigravity models refreshed (${count} available: ${sample}${count > 4 ? ", …" : ""})`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity model refresh failed: ${redactSecrets(msg)}`, "error");
      }
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const accounts = listAccounts();
      const active = accounts.find((account) => account.active);
      const activeLabel = active
        ? maskEmail(active.email) ||
          (active.accountId.includes("@") ? maskEmail(active.accountId) : active.accountId)
        : "none";
      const lines = [
        `provider=${PROVIDER_ID}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        `linkedAccounts=${accounts.length || "none"}`,
        `activeAccount=${activeLabel || "none"}`,
        ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
        `toolSchemaWarnings=${d.toolSchemaWarnings || "none"}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.usage /antigravity.models /antigravity.refresh /antigravity.doctor /antigravity.image /antigravity.search",
      ];
      emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
    },
  });

  pi.registerCommand("antigravity.image", {
    description:
      "Generate an image via Antigravity (usage: /antigravity.image [--ratio 16:9] <prompt>)",
    handler: async (args, ctx) => {
      const parsed = parseImageCommandArgs(args || "");
      if (!parsed.prompt) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.image [--ratio 16:9] [--model gemini-3-pro-image] [--path file.png] <prompt>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Generating Antigravity image…", "info");
        const result = await generateAntigravityImage({
          apiKey,
          cwd: ctx.cwd,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          model: parsed.model,
          path: parsed.path,
        });
        emitCommandOutput(ctx, `Saved image to ${result.savedPaths.join(", ")}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity image failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerCommand("antigravity.search", {
    description:
      "Search the web via Antigravity Google Search (usage: /antigravity.search <query>)",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) {
        emitCommandOutput(ctx, "Usage: /antigravity.search <query>", "warning");
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify(`Searching Google for "${query}"…`, "info");
        const result = await executeWebSearch({
          apiKey,
          query,
        });
        const summary = result.content[0]?.text || "No results found.";
        emitCommandOutput(ctx, summary);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity search failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image via Antigravity using the signed-in Google account. Saves under .pi/generated-images/ unless path is set.",
    promptSnippet: "Generate images via Antigravity OAuth (Gemini image models)",
    promptGuidelines: [
      "Use generate_image when the user asks to create, draw, or generate an image.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description." }),
      aspectRatio: Type.Optional(StringEnum(IMAGE_ASPECT_RATIOS)),
      model: Type.Optional(
        Type.String({
          description: `Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`,
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Project-relative file or directory to save the image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const result = await generateAntigravityImage({
        apiKey,
        cwd: ctx.cwd,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        model: params.model,
        path: params.path,
        signal,
      });
      const notes = result.text.join(" ").trim();
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved image to ${result.savedPaths.join(", ")}${notes ? `. ${notes}` : ""}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: { model: result.model, savedPaths: result.savedPaths },
      };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Google Search via Antigravity for current information, news, and answers. Optionally include URLs to analyze alongside search results.",
    promptSnippet: "Search the web via Google Search (Antigravity)",
    promptGuidelines: [
      "Use web_search to find current information, recent events, news, documentation, or answers on the web.",
    ],
    parameters: WebSearchSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      return executeWebSearch({
        apiKey,
        query: params.query,
        urls: params.urls,
        signal,
        onUpdate,
      });
    },
  });

  pi.registerTool({
    name: "url_context",
    label: "URL Context",
    description:
      "Directly analyze, extract, and summarize content from up to 20 public URLs (articles, documentation, web pages, and YouTube videos) via Antigravity.",
    promptSnippet: "Extract and summarize web pages or YouTube videos via Antigravity",
    promptGuidelines: [
      "Use url_context to read, analyze, and extract content from specific URLs or YouTube videos.",
    ],
    parameters: UrlContextSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      return executeUrlContext({
        apiKey,
        urls: params.urls,
        query: params.query,
        signal,
        onUpdate,
      });
    },
  });
}
