import type * as acp from "@agentclientprotocol/sdk";
import { generateDiffString } from "@earendil-works/pi-coding-agent";

/** Where a tool is, or how it ended. `awaiting`, `rejected` and `interrupted` come from Pi, not from ACP. */
export type ToolStatus =
  | "pending"
  | "in_progress"
  | "awaiting"
  | "completed"
  | "failed"
  | "rejected"
  | "interrupted";

/** One tool the agent ran, as the transcript shows it. Plain JSON: Pi persists it in the session. */
export interface ToolEntry {
  id: string;
  /** The tool's own name: "Read", "Bash", "Edit". */
  name: string;
  /** ACP tool kind: read, edit, execute, search, fetch, think, other. */
  kind: string;
  /** What the tool acts on: a path, a command, a quoted pattern. */
  target: string;
  /** Where a search looks, when it names a place. */
  scope?: string;
  status: ToolStatus;
  /** Text output: the command output, the content read, the error. */
  output: string;
  /** On a tool a subagent runs: the id of its Task tool. */
  parentId?: string;
  /** On a Task tool: the text its subagent wrote. */
  subagentText?: string;
  /** On Edit and Write: the change to the file. */
  change?: FileChange;
  /** On ExitPlanMode: the plan the agent asks to carry out, in Markdown. */
  plan?: string;
}

/** A file change as display lines: "+12 text", "-12 text", " 12 text", and "   ..." between hunks. */
export interface FileChange {
  /** The first lines of the change. The rest only count, so the session file stays small. */
  lines: string[];
  /** Lines left out of `lines`. */
  hidden: number;
  added: number;
  removed: number;
  /** Every diff created its file: there was no old text. */
  created: boolean;
}

/** The details of the activity tool result: the tools of one burst, in the order they started. */
export interface BurstDetails {
  tools: ToolEntry[];
}

type ToolReport = acp.ToolCall | acp.ToolCallUpdate;

/** Statuses Pi decides. ACP status reports never replace them. */
const PI_SETTLED = new Set<ToolStatus>(["rejected", "interrupted"]);
const OPEN = new Set<ToolStatus>(["pending", "in_progress", "awaiting"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
/** Context lines around each change, as the adapter's own patches use (diff.js:24). */
const DIFF_CONTEXT_LINES = 3;
/** Change lines kept in the session. The expanded detail shows at most this many. */
const MAX_CHANGE_LINES = 80;
const DIFF_LINE = /^([+\- ])(\s*)(\d+) /;
const HUNK_GAP = "   ...";
/** claude-agent-acp already wraps command output in a fence (renderer.js:206). */
const OUTER_FENCE = /^(`{3,})[^\n`]*\n([\s\S]*)\n\1$/;

/** Every tool of one turn, updated the moment ACP or Pi reports on it. */
export class ToolBook {
  readonly #tools = new Map<string, ToolEntry>();

  constructor(private readonly onChange: () => void) {}

  report(report: ToolReport): void {
    const entry = this.#entry(report.toolCallId);
    Object.assign(entry, reportedFields(entry, report));
    this.onChange();
  }

  mark(toolCallId: string, status: ToolStatus): void {
    this.#entry(toolCallId).status = status;
    this.onChange();
  }

  addSubagentText(parentId: string, text: string): void {
    const entry = this.#entry(parentId);
    entry.subagentText = (entry.subagentText ?? "") + text;
    this.onChange();
  }

  /** Marks every open tool as interrupted. */
  interruptOpen(): void {
    for (const entry of this.#tools.values()) if (OPEN.has(entry.status)) entry.status = "interrupted";
    this.onChange();
  }

  get(toolCallId: string): ToolEntry {
    return this.#entry(toolCallId);
  }

  /** Copies of every tool, in the order they were first reported. */
  all(): ToolEntry[] {
    return [...this.#tools.values()].map((entry) => structuredClone(entry));
  }

  #entry(id: string): ToolEntry {
    const entry = this.#tools.get(id) ?? emptyEntry(id);
    this.#tools.set(id, entry);
    return entry;
  }
}

/** The tools the agent runs between two texts of the model. The activity tool waits on `done`. */
export class Burst {
  readonly #ids: string[] = [];
  readonly #listeners = new Set<(details: BurstDetails) => void>();
  readonly done: Promise<BurstDetails>;
  #resolve: (details: BurstDetails) => void = () => {};

  constructor(
    readonly id: string,
    private readonly book: ToolBook,
  ) {
    this.done = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  add(toolCallId: string): void {
    if (!this.#ids.includes(toolCallId)) this.#ids.push(toolCallId);
    this.changed();
  }

  changed(): void {
    const details = this.details();
    for (const listener of this.#listeners) listener(details);
  }

  details(): BurstDetails {
    return { tools: this.#ids.map((id) => structuredClone(this.book.get(id))) };
  }

  /** Takes the tools that still run out of this burst and returns their ids. */
  releaseOpen(): string[] {
    const open = this.#ids.filter((id) => OPEN.has(this.book.get(id).status));
    this.#ids.splice(0, this.#ids.length, ...this.#ids.filter((id) => !open.includes(id)));
    return open;
  }

  subscribe(listener: (details: BurstDetails) => void): () => void {
    this.#listeners.add(listener);
    listener(this.details());
    return () => this.#listeners.delete(listener);
  }

  finish(): void {
    this.#listeners.clear();
    this.#resolve(this.details());
  }
}

function emptyEntry(id: string): ToolEntry {
  return { id, name: "", kind: "other", target: "", status: "pending", output: "" };
}

/** The fields `report` carries, merged over what `entry` already knows. */
function reportedFields(entry: ToolEntry, report: ToolReport): ToolEntry {
  const name = textOr(claudeCodeMeta(report).toolName, entry.name);
  const named = { ...entry, name, kind: textOr(report.kind, entry.kind) };
  return {
    ...named,
    ...targetFields(named, report),
    status: statusAfter(entry.status, report.status),
    output: textOr(outputOf(report), entry.output),
    parentId: keep(optionalText(claudeCodeMeta(report).parentToolUseId), entry.parentId),
    change: keep(changeOf(report), entry.change),
    plan: keep(optionalText(Object(report.rawInput).plan), entry.plan),
  };
}

type Diff = Extract<acp.ToolCallContent, { type: "diff" }>;

/**
 * Before a tool runs, the adapter sends the requested text change; after it runs, one diff per hunk
 * whose location line is the hunk start in the new file (diff.js:214-240).
 */
function changeOf(report: ToolReport): FileChange | undefined {
  const diffs = diffsOf(report);
  if (diffs.length === 0) return undefined;
  const starts = startLines(report);
  const lines = diffs.flatMap((diff, index) => hunkLines(diff, starts[index] ?? 1, index));
  return {
    lines: lines.slice(0, MAX_CHANGE_LINES),
    hidden: Math.max(lines.length - MAX_CHANGE_LINES, 0),
    added: lines.filter((line) => line.startsWith("+")).length,
    removed: lines.filter((line) => line.startsWith("-")).length,
    created: diffs.every((diff) => diff.oldText === null || diff.oldText === undefined),
  };
}

function diffsOf(report: ToolReport): Diff[] {
  return (report.content ?? []).filter((content): content is Diff => content.type === "diff");
}

/** The adapter pairs each hunk diff with a location at the same index. */
function startLines(report: ToolReport): number[] {
  return (report.locations ?? []).map((location) => location.line ?? 1);
}

/** The diff of one hunk, numbered from its place in the file, after a gap line when it is not the first. */
function hunkLines(diff: Diff, startLine: number, index: number): string[] {
  const { diff: text } = generateDiffString(diff.oldText ?? "", diff.newText, DIFF_CONTEXT_LINES);
  const offset = startLine - 1;
  const lines = text.split("\n").map((line) => shiftLine(line, offset));
  return index === 0 ? lines : [HUNK_GAP, ...lines];
}

function shiftLine(line: string, offset: number): string {
  return line.replace(DIFF_LINE, (_match, sign: string, pad: string, number: string) => {
    return `${sign}${pad}${Number(number) + offset} `;
  });
}

function claudeCodeMeta(report: ToolReport): { toolName?: unknown; parentToolUseId?: unknown } {
  return Object(Object(report._meta).claudeCode);
}

/** Search tools show their pattern and where they look; the rest show what their title names. */
function targetFields(entry: ToolEntry, report: ToolReport): Pick<ToolEntry, "target" | "scope"> {
  const input = Object(report.rawInput) as { pattern?: unknown; path?: unknown };
  if (SEARCH_TOOLS.has(entry.name) && typeof input.pattern === "string") {
    return { target: `"${input.pattern}"`, scope: optionalText(input.path) };
  }
  return { target: textOr(titleTarget(entry.name, report.title), entry.target), scope: entry.scope };
}

/** The adapter titles most tools "<Name> <target>" (tool-calls/reporters/*); Bash and Task title only the target. */
function titleTarget(name: string, title: string | null | undefined): string {
  const prefix = `${name} `;
  const text = title ?? "";
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function statusAfter(current: ToolStatus, reported: acp.ToolCallStatus | null | undefined): ToolStatus {
  return PI_SETTLED.has(current) ? current : (reported ?? current);
}

function outputOf(report: ToolReport): string {
  const text = (report.content ?? []).flatMap(contentText).join("\n") || rawText(report.rawOutput);
  return unfence(text);
}

function contentText(content: acp.ToolCallContent): string[] {
  return content.type === "content" && content.content.type === "text" ? [content.content.text] : [];
}

function rawText(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function unfence(text: string): string {
  return OUTER_FENCE.exec(text.trim())?.[2] ?? text;
}

/** A newly reported value, or the one already known. */
function keep<T>(reported: T | undefined, known: T | undefined): T | undefined {
  return reported ?? known;
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
