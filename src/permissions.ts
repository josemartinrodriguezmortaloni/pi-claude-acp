import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { EventBus, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Channel on `pi.events` where validator plugins vote on each Claude Code tool call. */
export const TOOL_REQUEST_EVENT = "claude-acp:tool-request";
/**
 * With the PreToolUse "ask" hook Claude Code ignores the rule this option writes, so offering it misleads.
 * (claude-agent-acp/dist/permissions/options/shared.js:3)
 */
const ALLOW_WITH_UPDATES = "allow-with-updates";
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

export type Vote = "allow" | "deny" | "ask";

/** Payload of TOOL_REQUEST_EVENT. A validator calls `vote` synchronously inside its handler. */
export interface ToolRequest {
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  vote(decision: Promise<Vote>): void;
}

export interface DecideContext {
  events: Pick<EventBus, "emit">;
  /** Undefined when Pi has no dialog UI (`ctx.hasUI === false`). */
  ui: Pick<ExtensionUIContext, "select"> | undefined;
  /** Aborts when the turn is cancelled. */
  signal?: AbortSignal;
}

type Verdict = (
  ctx: DecideContext,
  toolCall: ToolCallUpdate,
  options: PermissionOption[],
) => Promise<RequestPermissionResponse>;

const VERDICTS: Record<Vote, Verdict> = {
  allow: async (_ctx, _toolCall, options) => choose(options, "allow_once"),
  deny: async (_ctx, _toolCall, options) => choose(options, "reject_once"),
  ask: (ctx, toolCall, options) => askUser(ctx, toolCall, options),
};

/** Answers a Claude Code permission request. Only validators or the user can approve. */
export async function decide(
  request: RequestPermissionRequest,
  ctx: DecideContext,
): Promise<RequestPermissionResponse> {
  if (isAborted(ctx.signal)) return CANCELLED;
  const options = request.options.filter(offerable);
  const votes = await collectVotes(ctx, request.toolCall, options);
  if (isAborted(ctx.signal)) return CANCELLED;
  return VERDICTS[combine(votes)](ctx, request.toolCall, options);
}

function offerable(option: PermissionOption): boolean {
  return option.optionId !== ALLOW_WITH_UPDATES && option.kind !== "allow_always";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function collectVotes(ctx: DecideContext, toolCall: ToolCallUpdate, options: PermissionOption[]) {
  const votes: Promise<Vote>[] = [];
  const request: ToolRequest = {
    toolCall,
    options,
    vote: (decision) => votes.push(decision.catch((): Vote => "deny")),
  };
  ctx.events.emit(TOOL_REQUEST_EVENT, request);
  return Promise.race([Promise.all(votes), untilAbort(ctx.signal)]);
}

/** Stops waiting for validators when the turn is cancelled. */
function untilAbort(signal: AbortSignal | undefined): Promise<Vote[]> {
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
}

/** Any deny wins; approval needs every validator to allow; anything else asks the user. */
function combine(votes: Vote[]): Vote {
  if (votes.some(isDeny)) return "deny";
  return unanimousAllow(votes) ? "allow" : "ask";
}

/** Anything that is not an explicit allow or ask counts as a deny. */
function isDeny(vote: Vote): boolean {
  return !["allow", "ask"].includes(vote);
}

function unanimousAllow(votes: Vote[]): boolean {
  return votes.length > 0 && votes.every((vote) => vote === "allow");
}

/**
 * Pi keeps one dialog: a new `select` replaces the open one and never resolves it
 * (pi-coding-agent/dist/modes/interactive/interactive-mode.js:2034). Parallel tool calls would orphan a
 * permission request and hang the turn, so dialogs wait for each other.
 */
let openDialog: Promise<unknown> = Promise.resolve();

async function askUser(
  ctx: DecideContext,
  toolCall: ToolCallUpdate,
  options: PermissionOption[],
): Promise<RequestPermissionResponse> {
  const ui = ctx.ui;
  if (!ui) return choose(options, "reject_once");
  const label = openDialog.then(() =>
    ui.select(
      dialogTitle(toolCall),
      options.map((option) => option.name),
      { signal: ctx.signal },
    ),
  );
  openDialog = label.catch(() => undefined);
  return answerFor(ctx, options, await label);
}

function answerFor(ctx: DecideContext, options: PermissionOption[], label: string | undefined) {
  if (isAborted(ctx.signal)) return CANCELLED;
  const option = options.find((candidate) => candidate.name === label);
  return option ? selected(option) : choose(options, "reject_once");
}

function choose(options: PermissionOption[], kind: PermissionOptionKind): RequestPermissionResponse {
  const option = options.find((candidate) => candidate.kind === kind);
  return option ? selected(option) : CANCELLED;
}

function selected(option: PermissionOption): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function dialogTitle(toolCall: ToolCallUpdate): string {
  return [`Claude Code quiere usar ${toolName(toolCall)}`, toolDetail(toolCall)].filter(Boolean).join("\n");
}

function toolName(toolCall: ToolCallUpdate): string {
  return toolCall.title || toolCall.name || "una herramienta";
}

/** The command or path the tool acts on. */
function toolDetail(toolCall: ToolCallUpdate): string {
  const input = Object(toolCall.rawInput) as { command?: unknown; file_path?: unknown };
  const paths = (toolCall.locations ?? []).map((location) => location.path);
  return firstString([input.command, input.file_path, ...paths]);
}

function firstString(values: unknown[]): string {
  return String(values.find((value) => typeof value === "string") ?? "");
}
