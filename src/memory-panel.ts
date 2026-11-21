import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Inventory, ScopedInventory } from "./memory-store.ts";

const key = "smart-mem";
const infoTimeoutMs = 5_000;
const barFrames = ["━╸··", "·━╸·", "··━╸", "··╺━", "·╺━·", "╺━··"];
const frameIntervalMs = 120;
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
  #queued: readonly string[] = [];
  #latest?: Notice;
  #noticeTimer?: ReturnType<typeof setTimeout>;
  #animation?: ReturnType<typeof setInterval>;
  #frame = 0;

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

  setQueued(titles: readonly string[]) {
    this.#queued = titles;
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

  clearError() {
    if (this.#latest?.level !== "error") return;
    this.#clearNotice();
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
    this.#animation ??= setInterval(() => {
      this.#frame = (this.#frame + 1) % barFrames.length;
      this.#tui?.requestRender();
    }, frameIntervalMs).unref();
    this.#tui?.requestRender();
    const remove = () => {
      if (!this.#running.delete(id)) return false;
      if (!this.#running.size) this.#stopAnimation();
      return true;
    };
    return {
      update: (detail) => {
        if (!this.#running.has(id)) return;
        activity.detail = detail;
        this.#tui?.requestRender();
      },
      finish: (summary, level, detail, timeoutMs) => {
        if (remove()) this.notice(summary, level, detail, timeoutMs);
      },
      clear: () => {
        if (remove()) this.#tui?.requestRender();
      },
    };
  }

  #stopAnimation() {
    clearInterval(this.#animation);
    this.#animation = undefined;
    this.#frame = 0;
  }

  dispose() {
    this.#ui?.setWidget(key, undefined);
    this.#ui = undefined;
    this.#tui = undefined;
    this.#expanded = false;
    this.#running.clear();
    this.#queued = [];
    this.#stopAnimation();
    this.#clearNotice();
    this.#counts = undefined;
  }

  #render(width: number, theme: Theme): string[] {
    const [current, ...additional] = this.#running.values();
    const status = current ? (current.detail ?? current.title) : this.#active ? "Active" : "Not set up";
    const bar = current ? barFrames[this.#frame] : this.#active ? "━━━━" : "····";
    const hint = this.#latest?.detail ? ` · Alt+U ${this.#expanded ? "hide" : "details"}` : "";
    const line = (text: string) => truncateToWidth(clean(text).replaceAll("\n", " "), width);
    const rows = [theme.fg(current || this.#active ? "accent" : "warning", line(`🧠 ${bar}  ${status}${hint}`))];
    if (this.#active && this.#counts) {
      const { project, global } = this.#counts;
      const left = `Project: ${project ? tally(project) : "—"}`;
      const right = `Global: ${tally(global)}`;
      const combined = `  ${left}  │  ${right}`;
      const counts = combined.length <= width ? [combined] : [`  ${left}`, `  ${right}`];
      rows.push(...counts.map((count) => theme.fg("muted", line(count))));
    }
    for (const { title, detail } of additional.slice(0, 3)) {
      rows.push(theme.fg("muted", line(`  ↻ ${title}${detail ? ` · ${detail}` : ""}`)));
    }
    if (additional.length > 3) rows.push(theme.fg("muted", line(`  +${additional.length - 3} more running`)));
    for (const title of this.#queued.slice(0, 3)) rows.push(theme.fg("muted", line(`  Queued: ${title}`)));
    if (this.#queued.length > 3) rows.push(theme.fg("muted", line(`  +${this.#queued.length - 3} more queued`)));
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
