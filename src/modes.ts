import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { toolNameOf } from "./claude-code-meta.ts";

/**
 * The modes the extension offers, in `alt+m` order. They are claude-agent-acp mode ids
 * (session-mode.js:204-248). Bypass is not offered: it skips the validators. In auto, Claude Code's
 * classifier approves what it judges safe, so validators only see what it escalates.
 */
export const MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export type ModeId = (typeof MODES)[number];

/** Custom entry that records each mode change of a Pi session. */
export const MODE_ENTRY = "claude-acp-mode";

/** Tools whose only effect is a file change, the ones "auto-accept edits" approves. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** The agent's own machinery: loading deferred tools changes nothing the user owns. */
const INTERNAL_TOOLS = new Set(["ToolSearch"]);
/** Where Claude Code writes the plan in plan mode, with `settingSources: []` (no `plansDirectory`). */
const PLANS_DIR = join(homedir(), ".claude", "plans");

/** What each mode approves without a dialog, beyond the agent's internal tools. */
const MODE_RULES: Record<ModeId, (toolCall: ToolCallUpdate, cwd: string) => boolean> = {
  default: () => false,
  acceptEdits: (toolCall, cwd) => isEdit(toolCall) && editsInside(toolCall, cwd),
  plan: (toolCall) => isEdit(toolCall) && editsInside(toolCall, PLANS_DIR),
  // What reaches Pi in auto is what the classifier escalated: the user decides.
  auto: () => false,
};

export function isModeId(value: unknown): value is ModeId {
  return MODES.includes(value as ModeId);
}

export function nextMode(mode: ModeId): ModeId {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length] as ModeId;
}

/** The mode recorded last in `entries`. A new session starts in Manual. */
export function savedMode(entries: SessionEntry[]): ModeId {
  const data = entries.findLast((entry) => entry.type === "custom" && entry.customType === MODE_ENTRY);
  const mode = Object(Object(data).data).mode;
  return isModeId(mode) ? mode : "default";
}

/**
 * Whether a tool call needs no dialog: an internal tool in any mode, an edit inside the working
 * directory in auto-accept edits, the plan file in plan mode.
 */
export function autoApproves(mode: ModeId, toolCall: ToolCallUpdate, cwd: string): boolean {
  return INTERNAL_TOOLS.has(toolNameOf(toolCall)) || MODE_RULES[mode](toolCall, cwd);
}

function isEdit(toolCall: ToolCallUpdate): boolean {
  return EDIT_TOOLS.has(toolNameOf(toolCall));
}

function editsInside(toolCall: ToolCallUpdate, cwd: string): boolean {
  const paths = editedPaths(toolCall);
  return paths.length > 0 && paths.every((path) => isInside(path, cwd));
}

function editedPaths(toolCall: ToolCallUpdate): string[] {
  const input = Object(toolCall.rawInput) as { file_path?: unknown; notebook_path?: unknown };
  const named = [input.file_path, input.notebook_path].filter(
    (path): path is string => typeof path === "string",
  );
  return [...named, ...(toolCall.locations ?? []).map((location) => location.path)];
}

/** Compares real paths: a symlink inside `dir` can point anywhere, and the edit follows it. */
function isInside(path: string, dir: string): boolean {
  const real = realPath(resolve(dir, path));
  const root = realPath(dir);
  return real !== undefined && root !== undefined && isBelow(real, root);
}

function isBelow(path: string, dir: string): boolean {
  const fromDir = relative(dir, path);
  return fromDir !== "" && !fromDir.startsWith("..") && !isAbsolute(fromDir);
}

/**
 * `path` with every symlink resolved. A file not created yet resolves through its closest existing
 * parent. A symlink whose target does not exist yet has no real path: writing creates the target.
 */
function realPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return isLink(path) ? undefined : realChild(path);
  }
}

function realChild(path: string): string | undefined {
  const parent = dirname(path);
  if (parent === path) return path;
  const realParent = realPath(parent);
  return realParent && join(realParent, basename(path));
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
