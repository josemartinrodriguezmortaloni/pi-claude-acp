import type { Theme } from "@earendil-works/pi-coding-agent";
import { type BurstDetails, childrenOf, type FileChange, type ToolEntry, type ToolStatus } from "./burst.ts";
import { type ChipCategory, copy, type ToolCategory } from "./messages.ts";
import type { ReasoningEntry } from "./reasoning.ts";
import type { ActivityDetails } from "./turn.ts";

/** The theme operations the view uses. Tests pass a painter that marks colors as text. */
export type Painter = Pick<Theme, "fg" | "bold" | "inverse" | "italic">;

/** Output lines a branch shows while the detail is contracted, for commands and failures. */
const COLLAPSED_LINES = 5;
/** Output lines a branch shows with the detail expanded. The session keeps no more (burst.ts). */
const EXPANDED_LINES = 20;
const MAX_LINE_CHARS = 200;
/** Diff lines an edit shows while the detail is contracted. A new file shows none until expanded. */
const COLLAPSED_CHANGE_LINES = 12;
const EXPANDED_CHANGE_LINES = 80;
const DIFF_COLORS: Record<string, Parameters<Painter["fg"]>[0]> = {
  "+": "toolDiffAdded",
  "-": "toolDiffRemoved",
};

/** What a tool does, for the summary, the chip and the detail. "other" is shown but not counted. */
type Category = ToolCategory | "other";

const NAME_CATEGORY: Record<string, ToolCategory> = {
  ExitPlanMode: "plan",
  Write: "create",
  Task: "subagent",
  Agent: "subagent",
  Bash: "command",
};
const KIND_CATEGORY: Record<string, ToolCategory> = {
  read: "read",
  search: "search",
  edit: "edit",
  execute: "command",
  fetch: "fetch",
  think: "subagent",
};
const SUMMARY_ORDER: ToolCategory[] = [
  "read",
  "search",
  "fetch",
  "subagent",
  "plan",
  "edit",
  "create",
  "command",
];
/** Plan lines kept on screen. A plan never collapses: it is what the user approves. */
const MAX_PLAN_LINES = 80;

/** Only tools that change the repo or run something carry a chip (PRODUCT.md, principle 2). */
const CHIP_COLORS: Record<ChipCategory, Parameters<Painter["fg"]>[0]> = {
  plan: "success",
  edit: "accent",
  create: "success",
  command: "warning",
  subagent: "mdLink",
};
/** Every chip is as wide as the widest label, so the targets line up. */
const CHIP_WIDTH = Math.max(...Object.values(copy.chipLabel).map((label) => label.length));

interface Branch {
  last: boolean;
  all: ToolEntry[];
  expanded: boolean;
  paint: Painter;
}

/** Blink frames of the reasoning mark, one per half second. */
const REASONING_FRAMES = ["•", " "];
const BLINK_MS = 500;
const MAX_LIVE_CHARS = 120;

/** The entry of one activity: a run of reasoning or a burst of tools. `now` drives the live clock. */
export function activityLines(
  details: ActivityDetails,
  expanded: boolean,
  paint: Painter,
  now = Date.now(),
): string[] {
  if ("reasoning" in details) return reasoningLines(details.reasoning, expanded, paint, now);
  return burstLines(details, expanded, paint);
}

/**
 * While the model reasons: a blinking mark, the seconds so far and the last line it wrote. Then one
 * line with how long it took; the text shows when the detail is expanded. Everything in the accent color.
 */
function reasoningLines(entry: ReasoningEntry, expanded: boolean, paint: Painter, now: number): string[] {
  const seconds = elapsedSeconds(entry, now);
  if (entry.endedAt === undefined) return liveReasoning(entry, seconds, paint, now);
  return finishedReasoning(entry, seconds, expanded, paint);
}

function elapsedSeconds(entry: ReasoningEntry, now: number): number {
  return Math.max(1, Math.round(((entry.endedAt ?? now) - entry.startedAt) / 1000));
}

function finishedReasoning(
  entry: ReasoningEntry,
  seconds: number,
  expanded: boolean,
  paint: Painter,
): string[] {
  const head = paint.fg("accent", `• ${copy.thoughtFor(seconds)}`);
  if (!expanded) return [head];
  return [head, ...reasoningText(entry.text).map((line) => `  ${paint.italic(paint.fg("accent", line))}`)];
}

function liveReasoning(entry: ReasoningEntry, seconds: number, paint: Painter, now: number): string[] {
  const mark = REASONING_FRAMES[Math.floor(now / BLINK_MS) % REASONING_FRAMES.length];
  const last = reasoningText(entry.text).at(-1) ?? "";
  const head = paint.fg("accent", `${mark} ${copy.thinkingFor(seconds)}`);
  return last ? [head, `  ${paint.italic(paint.fg("accent", clipTo(last, MAX_LIVE_CHARS)))}`] : [head];
}

function reasoningText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The entry of one burst: a summary line, then one branch per tool the main agent ran. */
function burstLines(details: BurstDetails, expanded: boolean, paint: Painter): string[] {
  const top = details.tools.filter((tool) => tool.parentId === undefined);
  return [summaryLine(top, paint), ...branches(top, { last: false, all: details.tools, expanded, paint })];
}

export function categoryOf(tool: ToolEntry): Category {
  return knownCategory(tool) ?? "other";
}

function knownCategory(tool: ToolEntry): ToolCategory | undefined {
  return writeCategory(tool) ?? NAME_CATEGORY[tool.name] ?? KIND_CATEGORY[tool.kind];
}

/** A Write over an existing file is an edit; the adapter only knows after it runs. */
function writeCategory(tool: ToolEntry): ToolCategory | undefined {
  return tool.name === "Write" && overwrote(tool) ? "edit" : undefined;
}

function overwrote(tool: ToolEntry): boolean {
  return tool.change?.created === false;
}

function summaryLine(top: ToolEntry[], paint: Painter): string {
  const counts = SUMMARY_ORDER.map((category) => countText(category, top)).filter(Boolean);
  const failed = top.filter((tool) => tool.status === "failed").length;
  const failure = failed > 0 ? paint.fg("error", `✗ ${copy.failedCount(failed)}`) : "";
  const head = `${paint.fg("accent", "●")} ${paint.bold(copy.toolCount(top.length))}`;
  return [
    head,
    ...counts.map((text) => paint.fg("muted", text)),
    changeStats(totalChange(top), paint),
    failure,
  ]
    .filter(Boolean)
    .join(paint.fg("muted", " · "));
}

/** Lines added and removed by every tool of the burst. */
function totalChange(tools: ToolEntry[]): Pick<FileChange, "added" | "removed"> {
  const changes = tools.flatMap((tool) => (tool.change ? [tool.change] : []));
  return {
    added: changes.reduce((sum, change) => sum + change.added, 0),
    removed: changes.reduce((sum, change) => sum + change.removed, 0),
  };
}

const NO_CHANGE = { added: 0, removed: 0 };

/** "+12 −3", leaving out a zero side. */
function changeStats(change: Pick<FileChange, "added" | "removed">, paint: Painter): string {
  return [signed(change.added, "+", "success", paint), signed(change.removed, "−", "error", paint)]
    .filter(Boolean)
    .join(" ");
}

function signed(count: number, sign: string, color: Parameters<Painter["fg"]>[0], paint: Painter): string {
  return count > 0 ? paint.fg(color, `${sign}${count}`) : "";
}

function countText(category: ToolCategory, tools: ToolEntry[]): string {
  const count = tools.filter((tool) => categoryOf(tool) === category).length;
  return count > 0 ? copy.categoryCount[category](count) : "";
}

function branches(tools: ToolEntry[], branch: Branch): string[] {
  return tools.flatMap((tool, index) => branchLines(tool, { ...branch, last: index === tools.length - 1 }));
}

function branchLines(tool: ToolEntry, branch: Branch): string[] {
  const { paint, last } = branch;
  const head = `${paint.fg("dim", last ? "└" : "├")} ${label(tool, branch)}`;
  const rail = last ? "  " : `${paint.fg("dim", "│")} `;
  return [head, ...detailLines(tool, branch).map((line) => `${rail} ${line}`)];
}

function label(tool: ToolEntry, branch: Branch): string {
  const head = labelHead(tool, branch.paint);
  const stats = changeStats(tool.change ?? NO_CHANGE, branch.paint);
  return [...head, stats, infoText(tool, branch), statusText(tool, branch.paint)].filter(Boolean).join(" ");
}

/** A chip and the target, or the whole label muted for tools that only look. */
function labelHead(tool: ToolEntry, paint: Painter): string[] {
  const chip = chipOf(tool);
  if (!chip) return [paint.fg("muted", distinct([tool.name, targetText(tool)]).join(" "))];
  const label = copy.chipLabel[chip].padEnd(CHIP_WIDTH);
  return [paint.inverse(paint.fg(CHIP_COLORS[chip], ` ${label} `)), targetText(tool)];
}

/** Tools the adapter titles with their own name show it once. */
function distinct(parts: string[]): string[] {
  return [...new Set(parts.filter(Boolean))];
}

function chipOf(tool: ToolEntry): ChipCategory | undefined {
  const category = categoryOf(tool);
  return category in CHIP_COLORS ? (category as ChipCategory) : undefined;
}

/** A plan shows its text below instead of the adapter's title. */
function targetText(tool: ToolEntry): string {
  if (categoryOf(tool) === "plan") return "";
  return tool.scope ? `${tool.target} ${copy.inScope(tool.scope)}` : tool.target;
}

/** What the tool produced, counted: lines read, results found, tools of a subagent. */
function infoText(tool: ToolEntry, branch: Branch): string {
  const text = infoOf(tool, branch.all);
  return text ? branch.paint.fg("dim", `· ${text}`) : "";
}

function infoOf(tool: ToolEntry, all: ToolEntry[]): string {
  const count = INFO[categoryOf(tool)];
  return count ? count(tool, all) : "";
}

const INFO: Partial<Record<Category, (tool: ToolEntry, all: ToolEntry[]) => string>> = {
  plan: (tool) => (tool.status === "completed" ? `✓ ${copy.planApproved}` : ""),
  read: (tool) => (producedOutput(tool) ? copy.lineCount(tool.outputLines) : ""),
  search: (tool) => (producedOutput(tool) ? copy.resultCount(tool.outputLines) : ""),
  subagent: (tool, all) => copy.toolCount(childrenOf(tool, all).length),
};

/** Only a completed tool's output is what it found; a failure's output is the error. */
function producedOutput(tool: ToolEntry): boolean {
  return tool.status === "completed" && tool.output !== "";
}

const STATUS_TEXT: Record<ToolStatus, (paint: Painter) => string> = {
  pending: (paint) => paint.fg("dim", "…"),
  in_progress: (paint) => paint.fg("dim", "…"),
  awaiting: (paint) => paint.fg("warning", `? ${copy.awaitingApproval}`),
  completed: () => "",
  failed: (paint) => paint.inverse(paint.fg("error", ` ${copy.failedChip} `)),
  rejected: (paint) => paint.fg("error", `✗ ${copy.rejected}`),
  interrupted: (paint) => paint.fg("muted", `■ ${copy.interrupted}`),
};

function statusText(tool: ToolEntry, paint: Painter): string {
  return STATUS_TEXT[tool.status](paint);
}

type DetailKind = "subagent" | "plan" | "change" | "output";

/** Tools whose detail is not their output or their change. */
const CATEGORY_DETAIL: Partial<Record<Category, DetailKind>> = { subagent: "subagent", plan: "plan" };

function detailLines(tool: ToolEntry, branch: Branch): string[] {
  return DETAILS[detailKind(tool)](tool, branch);
}

function detailKind(tool: ToolEntry): DetailKind {
  return CATEGORY_DETAIL[categoryOf(tool)] ?? (showsChange(tool) ? "change" : "output");
}

/** A failed edit shows its error, not the change it asked for. */
function showsChange(tool: ToolEntry): boolean {
  return tool.change !== undefined && tool.status !== "failed";
}

const DETAILS: Record<DetailKind, (tool: ToolEntry, branch: Branch) => string[]> = {
  subagent: (tool, branch) => (branch.expanded ? subagentLines(tool, branch) : []),
  plan: (tool, branch) => planLines(tool.plan ?? "", branch.paint),
  change: (tool, branch) => changeLines(tool, branch),
  output: (tool, branch) => outputLines(tool, outputLimit(tool, branch.expanded), branch.paint),
};

function planLines(plan: string, paint: Painter): string[] {
  const lines = splitLines(plan);
  const shown = lines.slice(0, MAX_PLAN_LINES).map((line) => paint.fg("text", clip(line)));
  return withHidden(shown, lines.length - shown.length, paint);
}

function changeLines(tool: ToolEntry, branch: Branch): string[] {
  const change = tool.change as FileChange;
  const limit = changeLimit(tool, branch.expanded);
  if (limit === 0) return [];
  const shown = change.lines.slice(0, limit).map((line) => paintDiffLine(line, branch.paint));
  return withHidden(shown, change.lines.length - shown.length + change.hidden, branch.paint);
}

/** An edit shows its diff even contracted; a new file shows its content only expanded. */
function changeLimit(tool: ToolEntry, expanded: boolean): number {
  if (expanded) return EXPANDED_CHANGE_LINES;
  return categoryOf(tool) === "create" ? 0 : COLLAPSED_CHANGE_LINES;
}

function paintDiffLine(line: string, paint: Painter): string {
  return paint.fg(DIFF_COLORS[line.charAt(0)] ?? "toolDiffContext", clip(line));
}

/** The subagent's tools as a nested tree, then what it wrote. */
function subagentLines(tool: ToolEntry, branch: Branch): string[] {
  const children = childrenOf(tool, branch.all);
  const written = (tool.subagentText ?? "").trim();
  const text = written ? written.split("\n").map((line) => branch.paint.italic(line)) : [];
  return [...branches(children, branch), ...text];
}

function outputLimit(tool: ToolEntry, expanded: boolean): number {
  if (expanded) return EXPANDED_LINES;
  return showsOutputContracted(tool) ? COLLAPSED_LINES : 0;
}

/** Command output and failures change decisions, so they show even with the detail contracted. */
function showsOutputContracted(tool: ToolEntry): boolean {
  return tool.status === "failed" || categoryOf(tool) === "command";
}

function outputLines(tool: ToolEntry, limit: number, paint: Painter): string[] {
  if (limit === 0) return [];
  const shown = splitLines(tool.output)
    .slice(0, limit)
    .map((line) => paint.fg("toolOutput", clip(line)));
  return withHidden(shown, tool.outputLines - shown.length, paint);
}

/** `shown`, then how many lines it leaves out. */
function withHidden(shown: string[], hidden: number, paint: Painter): string[] {
  return hidden > 0 ? [...shown, paint.fg("dim", copy.hiddenLines(hidden))] : shown;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

function clip(line: string): string {
  return clipTo(line, MAX_LINE_CHARS);
}

function clipTo(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
