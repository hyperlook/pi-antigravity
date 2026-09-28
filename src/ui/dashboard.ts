import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { activateAccount, readAccountApiKeys, removeAccount } from "../auth/index.js";
import { runWithDiagnostics } from "../diagnostics/index.js";
import { redactSecrets } from "../utils/index.js";
import type { AccountUsage } from "../types/types.js";
import {
  createThemeColorizer,
  deriveUniqueShortLabels,
  fetchAccountUsage,
  formatAccountsDashboard,
  type DashboardAccountRow,
  type ThemeLike,
} from "../usage/index.js";
import { emitCommandOutput } from "./output.js";

export type DashboardResult =
  | { action: "switch"; target: DashboardAccountRow }
  | { action: "remove"; target: DashboardAccountRow }
  | { action: "close" };

/**
 * Terminal component for the control center. Owns selection state, delete
 * confirmation, and render caching; the driver below owns data fetching.
 */
class AntigravityDashboardComponent {
  private rows: DashboardAccountRow[];
  private selectedIndex: number;
  private confirmDeleteIndex?: number;
  private theme: ThemeLike;
  private keybindings: KeybindingsManager;
  private onDone: (result: DashboardResult) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private settled = false;

  constructor(
    rows: DashboardAccountRow[],
    initialIndex: number,
    theme: ThemeLike,
    keybindings: KeybindingsManager,
    onDone: (result: DashboardResult) => void,
  ) {
    this.rows = rows;
    this.selectedIndex = Math.max(0, Math.min(initialIndex, rows.length - 1));
    this.theme = theme;
    this.keybindings = keybindings;
    this.onDone = onDone;
  }

  updateRowUsage(index: number, usage: AccountUsage): void {
    if (this.settled || !this.rows[index]) return;
    this.rows[index].loading = false;
    this.rows[index].usage = usage;
    this.invalidate();
  }

  setRowError(index: number, error: string): void {
    if (this.settled || !this.rows[index]) return;
    this.rows[index].loading = false;
    this.rows[index].error = error;
    this.invalidate();
  }

  private finish(result: DashboardResult): void {
    if (this.settled) return;
    this.settled = true;
    this.onDone(result);
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (this.rows.length === 0) {
      this.finish({ action: "close" });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.confirmDeleteIndex !== undefined) {
        this.confirmDeleteIndex = undefined;
        this.invalidate();
        return;
      }
      this.finish({ action: "close" });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.confirmDeleteIndex = undefined;
      this.selectedIndex = (this.selectedIndex - 1 + this.rows.length) % this.rows.length;
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.confirmDeleteIndex = undefined;
      this.selectedIndex = (this.selectedIndex + 1) % this.rows.length;
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.rows[this.selectedIndex];
      if (selected) this.finish({ action: "switch", target: selected });
      return;
    }

    // Arm with d/x. Confirm with y so key-repeat cannot unlink.
    if (matchesKey(data, "d") || matchesKey(data, "x")) {
      if (isKeyRepeat(data) || this.confirmDeleteIndex === this.selectedIndex) return;
      this.confirmDeleteIndex = this.selectedIndex;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "y") || matchesKey(data, "shift+y")) {
      if (isKeyRepeat(data)) return;
      if (this.confirmDeleteIndex === this.selectedIndex) {
        const selected = this.rows[this.selectedIndex];
        if (selected) this.finish({ action: "remove", target: selected });
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
    const safeWidth = Math.max(0, width);

    // Header. Keep the previous inset on normal widths, but never exceed the viewport.
    const title = th.bold(th.fg("accent", "Antigravity 控制中心"));
    const inner = Math.max(0, safeWidth - 2);
    const ruleChars = Math.min(inner, Math.max(10, safeWidth - 4));
    const hr = th.fg("borderMuted", "─".repeat(ruleChars));
    lines.push("");
    lines.push(truncateToWidth(`  ${title}`, safeWidth));
    lines.push(truncateToWidth(`  ${hr}`, safeWidth));
    lines.push("");

    // Body: Two-row per account
    const body = formatAccountsDashboard(this.rows, {
      selectedIndex: this.selectedIndex,
      colorizer,
      now: Date.now(),
    });
    for (const line of body.split("\n")) {
      lines.push(truncateToWidth(`  ${line}`, safeWidth));
    }

    // Footer
    lines.push("");
    lines.push(`  ${hr}`);
    if (this.confirmDeleteIndex !== undefined) {
      const target = this.rows[this.confirmDeleteIndex];
      const targetName = target ? target.shortLabel : "该账号";
      lines.push(
        truncateToWidth(
          `  ${th.bold(th.fg("warning", `⚠️  确定要解绑 [${targetName}] 吗？按 y 确认，按 Esc 取消`))}`,
          safeWidth,
        ),
      );
    } else {
      const hint = th.fg("dim", "↑↓ 移动 · Enter 切换 · d 删除 · Esc 退出");
      lines.push(truncateToWidth(`  ${hint}`, safeWidth));
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

async function runInteractiveDashboard(
  ctx: ExtensionCommandContext,
  access: Awaited<ReturnType<typeof readAccountApiKeys>>,
  rows: DashboardAccountRow[],
  initialIndex: number,
): Promise<void> {
  let component: AntigravityDashboardComponent | undefined;
  let closed = false;

  // Start background fetch for all accounts in parallel immediately
  const fetchPromises = access.map(async (account, index) => {
    if (!account.apiKey) {
      const errMsg = redactSecrets(account.error || "No credentials");
      if (closed) return;
      rows[index].loading = false;
      rows[index].error = errMsg;
      component?.setRowError(index, errMsg);
      return;
    }
    try {
      const usage = await runWithDiagnostics(() => fetchAccountUsage(account.apiKey), {
        commit: account.active,
      });
      if (closed) return;
      rows[index].loading = false;
      rows[index].usage = usage;
      component?.updateRowUsage(index, usage);
    } catch (error) {
      if (closed) return;
      const msg = redactSecrets(error instanceof Error ? error.message : String(error));
      rows[index].loading = false;
      rows[index].error = msg;
      component?.setRowError(index, msg);
    }
  });

  const result = await ctx.ui.custom<DashboardResult>((tui, theme, kb, done) => {
    component = new AntigravityDashboardComponent(rows, initialIndex, theme, kb, (res) => {
      closed = true;
      done(res);
    });
    // Trigger render when fetch updates arrive. Ignore completions after the dialog closes.
    fetchPromises.forEach((p) => {
      void p.then(() => {
        if (!closed) tui.requestRender();
      });
    });
    return component;
  });
  closed = true;

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

  const remaining = await removeAccount(String(result.target.index));
  const next = remaining ? ` Active account is now ${remaining.email || remaining.accountId}.` : "";
  emitCommandOutput(ctx, `Antigravity account [${result.target.shortLabel}] unlinked.${next}`);
}

async function runHeadlessDashboard(
  ctx: ExtensionCommandContext,
  access: Awaited<ReturnType<typeof readAccountApiKeys>>,
  rows: DashboardAccountRow[],
): Promise<void> {
  // RPC can forward select(), but not custom() terminal components.
  if (ctx.hasUI) {
    ctx.ui.notify(
      `Fetching usage for ${access.length} account${access.length === 1 ? "" : "s"}…`,
      "info",
    );
  }
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

  const dashboardOutput = formatAccountsDashboard(rows, { now: Date.now() });
  const hint = "Switch or unlink accounts from the interactive TUI: /antigravity";
  emitCommandOutput(ctx, `Antigravity accounts\n\n${dashboardOutput}\n\n${hint}`);

  if (!ctx.hasUI || rows.length < 2) return;
  const choices = rows.map((row) => ({
    row,
    label: `${row.active ? "* " : ""}${row.index}. ${row.shortLabel}`,
  }));
  const selected = await ctx.ui.select(
    "Switch Antigravity account",
    choices.map((choice) => choice.label),
  );
  const chosen = choices.find((choice) => choice.label === selected)?.row;
  if (!chosen || chosen.active) return;
  const account = await activateAccount(String(chosen.index));
  emitCommandOutput(ctx, `Switched to ${account.email || account.accountId}`);
}

/**
 * Entry point for the control center: builds the account rows, then either runs
 * the zero-latency TUI (interactive) or a fully resolved text dashboard.
 */
export async function runAccountsDashboard(ctx: ExtensionCommandContext): Promise<void> {
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

  if (ctx.hasUI && ctx.mode === "tui") {
    await runInteractiveDashboard(ctx, access, rows, initialIndex);
    return;
  }
  await runHeadlessDashboard(ctx, access, rows);
}
