import type * as acp from "@agentclientprotocol/sdk";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { categoryOf } from "./activity-view.ts";
import { childrenOf, isOpen, nameAndTarget, type ToolEntry } from "./burst.ts";
import { copy } from "./messages.ts";
import { printable } from "./terminal-text.ts";

/** Done reads struck through, the active row stands out, pending waits; each has its own mark. */
export type ProgressState = "done" | "active" | "pending";

export interface ProgressItem {
  text: string;
  state: ProgressState;
}

export type ProgressPainter = Pick<Theme, "fg" | "bold" | "strikethrough">;

/** Rows a widget shows while the detail is contracted. Ctrl+O shows them all. */
const VISIBLE_ROWS = 4;
const PLAN_STATES: Record<acp.PlanEntryStatus, ProgressState> = {
  completed: "done",
  in_progress: "active",
  pending: "pending",
};

const ROWS: Record<ProgressState, (text: string, paint: ProgressPainter) => string> = {
  done: (text, paint) => paint.fg("dim", `✓ ${paint.strikethrough(text)}`),
  active: (text, paint) => paint.bold(`● ${text}`),
  pending: (text, paint) => paint.fg("dim", `○ ${text}`),
};

/**
 * A progress list above the editor: the title with how many rows are done, then the rows under a
 * rail. Contracted, it shows a window of rows that starts just before the first unfinished one.
 */
export function progressLines(
  title: string,
  items: ProgressItem[],
  expanded: boolean,
  paint: ProgressPainter,
): string[] {
  const done = items.filter((item) => item.state === "done").length;
  const shown = expanded ? items : visibleWindow(items);
  const rail = paint.fg("dim", "│");
  const rows = shown.map((item) => `${rail} ${ROWS[item.state](printable(item.text), paint)}`);
  const hidden = items.length - shown.length;
  const more = hidden > 0 ? [`${rail} ${paint.fg("dim", copy.moreRows(hidden))}`] : [];
  return [`  ${paint.bold(title)} ${paint.fg("dim", `· ${done}/${items.length}`)}`, ...rows, ...more];
}

function visibleWindow(items: ProgressItem[]): ProgressItem[] {
  const firstOpen = items.findIndex((item) => item.state !== "done");
  const start = Math.max(0, Math.min(firstOpen - 1, items.length - VISIBLE_ROWS));
  return items.slice(start, start + VISIBLE_ROWS);
}

/** The plan while work remains; undefined once every entry is done. */
export function planItems(entries: acp.PlanEntry[]): ProgressItem[] | undefined {
  if (entries.every((entry) => entry.status === "completed")) return undefined;
  return entries.map((entry) => ({ text: entry.content, state: PLAN_STATES[entry.status] }));
}

/** The subagents of the turn while one still runs; undefined once all are done. */
export function subagentItems(tools: ToolEntry[]): ProgressItem[] | undefined {
  const subagents = tools.filter((tool) => categoryOf(tool) === "subagent");
  if (!subagents.some(isOpen)) return undefined;
  return subagents.map((tool) => subagentItem(tool, tools));
}

/** A running subagent shows the tool it runs now; a finished one, how many it ran. */
function subagentItem(tool: ToolEntry, tools: ToolEntry[]): ProgressItem {
  const children = childrenOf(tool, tools);
  const running = isOpen(tool);
  const detail = running ? currentTool(children) : copy.toolCount(children.length);
  return { text: [tool.target, detail].filter(Boolean).join(" · "), state: running ? "active" : "done" };
}

function currentTool(children: ToolEntry[]): string {
  const current = children.at(-1);
  return current ? nameAndTarget(current) : "";
}

/** A widget component that redraws with the current Ctrl+O state each time Pi renders it. */
export function progressWidget(
  title: string,
  items: ProgressItem[],
  expanded: () => boolean,
): (tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => {
    const text = new Text("", 0, 0);
    return {
      render: (width) => {
        text.setText(progressLines(title, items, expanded(), theme).join("\n"));
        return text.render(width);
      },
      invalidate: () => text.invalidate(),
    };
  };
}
