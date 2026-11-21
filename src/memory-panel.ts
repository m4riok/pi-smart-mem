import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Inventory, ScopedInventory } from "./memory-store.ts";

const key = "smart-mem";
const infoTimeoutMs = 5_000;
export const memoryPanelShortcut = "alt+u";
export type Level = "info" | "warning" | "error";
export type Activity = {
  update(detail: string): void;
  finish(summary: string, level?: Level, detail?: string, timeoutMs?: number): void;
  clear(): void;
};
type Notice = { summary: string; level: Level; detail?: string };
const tally = ({ memories, skills, pins }: Inventory) => `${memories} mem · ${skills} skills · ${pins} pins`;
const clean = (text: string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");

export class MemoryPanel {
  #ui?: ExtensionUIContext;
  #tui?: TUI;
  #active = false;
  #counts?: ScopedInventory;
  #expanded = false;
  #running = new Map<symbol, { title: string; detail?: string }>();
  #latest?: Notice;
  #noticeTimer?: ReturnType<typeof setTimeout>;

  mount(ui: ExtensionUIContext, active: boolean) {
    this.#ui = ui;
    this.#active = active;
    ui.setWidget(key, (tui, theme) => {
      this.#tui = tui;
      return { render: (width) => this.#render(width, theme), invalidate: () => {} };
    }, { placement: "aboveEditor" });
  }

  get mounted() { return this.#ui !== undefined; }

  setCounts(counts: ScopedInventory) {
    if (!this.mounted) return;
    this.#counts = counts;
    this.#tui?.requestRender();
  }

  setActive(active: boolean) {
    this.#active = active;
    this.#tui?.requestRender();
  }

  toggle() {
    this.#expanded = !this.#expanded;
    this.#tui?.requestRender(true);
  }

  notice(summary: string, level: Level = "info", detail?: string, timeoutMs = level === "info" ? infoTimeoutMs : 0) {
    this.#clearNotice();
    this.#latest = { summary, level, detail: detail?.slice(0, 4096) };
    if (timeoutMs > 0) this.#noticeTimer = setTimeout(() => {
      this.#clearNotice();
      this.#tui?.requestRender();
    }, timeoutMs).unref();
    this.#tui?.requestRender();
  }

  #clearNotice() {
    clearTimeout(this.#noticeTimer);
    this.#noticeTimer = undefined;
    this.#latest = undefined;
  }

  begin(title: string): Activity {
    const id = Symbol();
    const activity = { title, detail: undefined as string | undefined };
    this.#running.set(id, activity);
    this.#tui?.requestRender();
    return {
      update: (detail) => {
        if (!this.#running.has(id)) return;
        activity.detail = detail;
        this.#tui?.requestRender();
      },
      finish: (summary, level, detail, timeoutMs) => {
        if (this.#running.delete(id)) this.notice(summary, level, detail, timeoutMs);
      },
      clear: () => {
        if (this.#running.delete(id)) this.#tui?.requestRender();
      },
    };
  }

  dispose() {
    this.#ui?.setWidget(key, undefined);
    this.#ui = undefined;
    this.#tui = undefined;
    this.#expanded = false;
    this.#running.clear();
    this.#clearNotice();
    this.#counts = undefined;
  }

  #render(width: number, theme: Theme): string[] {
    const header = `🧠 Memory · ${this.#active ? "Active" : "Not set up"}`;
    const hint = this.#latest?.detail ? ` · Alt+U ${this.#expanded ? "hide" : "details"}` : "";
    const line = (text: string) => truncateToWidth(clean(text).replaceAll("\n", " "), width);
    const rows = [theme.fg(this.#active ? "accent" : "warning", line(header + hint))];
    if (this.#active && this.#counts) {
      const { project, global } = this.#counts;
      const left = `Project: ${project ? tally(project) : "—"}`;
      const right = `Global: ${tally(global)}`;
      const combined = `  ${left}  │  ${right}`;
      const counts = combined.length <= width ? [combined] : [`  ${left}`, `  ${right}`];
      rows.push(...counts.map((count) => theme.fg("muted", line(count))));
    }
    const running = [...this.#running.values()];
    for (const { title, detail } of running.slice(0, 4)) {
      rows.push(theme.fg("muted", line(`  ↻ ${title}${detail ? ` · ${detail}` : ""}`)));
    }
    if (running.length > 4) rows.push(theme.fg("muted", line(`  +${running.length - 4} more running`)));
    const latest = this.#latest;
    if (latest) {
      rows.push(theme.fg(latest.level === "info" ? "muted" : latest.level, line(`  ${latest.summary}`)));
      if (this.#expanded && latest.detail) {
        const details = wrapTextWithAnsi(clean(latest.detail), Math.max(1, width - 4));
        for (const detail of details.slice(0, 6)) rows.push(theme.fg("dim", line(`    ${detail}`)));
        if (details.length > 6) rows.push(theme.fg("dim", line("    …")));
      }
    }
    return rows;
  }
}
