import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { EventBus, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { oneAtATime } from "./dialogs.ts";
import { copy } from "./messages.ts";
import { approvePlan, isPlanApproval, type PlanContext } from "./plan-approval.ts";

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
  ui: Pick<ExtensionUIContext, "select" | "input"> | undefined;
  /** Aborts when the turn is cancelled. */
  signal?: AbortSignal;
  /** Whether the session mode approves this tool call without a dialog. Validators still vote first. */
  autoApproves(toolCall: ToolCallUpdate): boolean;
  plan: Pick<PlanContext, "acceptEditsAfterApproval" | "sendFeedback">;
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

/** Answers a permission request of the agent. A plan approval is the user's alone. */
export async function decide(
  request: RequestPermissionRequest,
  ctx: DecideContext,
): Promise<RequestPermissionResponse> {
  if (isPlanApproval(request)) return approvePlan(request, { ...ctx.plan, ui: ctx.ui, signal: ctx.signal });
  return decideTool(request, ctx);
}

/** Only validators, the session mode or the user can approve a tool call. */
async function decideTool(
  request: RequestPermissionRequest,
  ctx: DecideContext,
): Promise<RequestPermissionResponse> {
  if (isAborted(ctx.signal)) return CANCELLED;
  const options = request.options.filter(offerable);
  const votes = await collectVotes(ctx, request.toolCall, options);
  if (isAborted(ctx.signal)) return CANCELLED;
  return VERDICTS[verdictFor(votes, ctx, request.toolCall)](ctx, request.toolCall, options);
}

/** A deny always wins; the mode only answers what would otherwise reach the user. */
function verdictFor(votes: Vote[], ctx: DecideContext, toolCall: ToolCallUpdate): Vote {
  const vote = combine(votes);
  return vote === "ask" && ctx.autoApproves(toolCall) ? "allow" : vote;
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

async function askUser(
  ctx: DecideContext,
  toolCall: ToolCallUpdate,
  options: PermissionOption[],
): Promise<RequestPermissionResponse> {
  const ui = ctx.ui;
  if (!ui) return choose(options, "reject_once");
  const label = await oneAtATime(() =>
    ui.select(
      dialogTitle(toolCall),
      options.map((option) => option.name),
      { signal: ctx.signal },
    ),
  );
  return answerFor(ctx, options, label);
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
  return copy.permissionTitle(toolName(toolCall), toolDetail(toolCall));
}

/** The tool's own name ("Bash", "Read"): the adapter's title already repeats the command or path. */
function toolName(toolCall: ToolCallUpdate): string {
  const meta = Object(Object(toolCall._meta).claudeCode) as { toolName?: unknown };
  return firstString([meta.toolName, toolCall.title]) || copy.unknownTool;
}

/** The command or path the tool acts on. */
function toolDetail(toolCall: ToolCallUpdate): string {
  const input = Object(toolCall.rawInput) as { command?: unknown; file_path?: unknown };
  const paths = (toolCall.locations ?? []).map((location) => location.path);
  return firstString([input.command, input.file_path, ...paths]);
}

function firstString(values: unknown[]): string {
  return String(values.find((value) => typeof value === "string" && value !== "") ?? "");
}
