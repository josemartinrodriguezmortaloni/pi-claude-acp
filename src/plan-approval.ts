import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { oneAtATime } from "./dialogs.ts";
import { copy } from "./messages.ts";

/** Option ids of claude-agent-acp's ExitPlanMode request (permissions/options/shared.js:6-12). */
const ACCEPT_EDITS = "exit-plan-accept-edits";
const MANUAL = "exit-plan-default";

export interface PlanContext {
  /** Undefined when Pi has no dialog UI. */
  ui: Pick<ExtensionUIContext, "select" | "input"> | undefined;
  /** Aborts when the turn is cancelled. */
  signal?: AbortSignal;
  /** Switches the session to auto-accept edits once the adapter has applied a manual approval. */
  acceptEditsAfterApproval(): void;
  /** Sends what the user wants changed in the plan as their next message. */
  sendFeedback(text: string): void;
}

type Choice = "edits" | "manual" | "keep";

/** The request the agent makes to leave plan mode and start working. */
export function isPlanApproval(request: RequestPermissionRequest): boolean {
  return Object(Object(request.toolCall._meta).claudeCode).toolName === "ExitPlanMode";
}

/**
 * Asks the user with Claude Code's three answers. Options that reset the context are never offered:
 * they would detach the ACP session from the Pi session.
 */
export async function approvePlan(
  request: RequestPermissionRequest,
  ctx: PlanContext,
): Promise<RequestPermissionResponse> {
  const ui = ctx.ui;
  if (!ui) return answer(request, "keep", ctx);
  const choice = await oneAtATime(() => askChoice(ui, ctx));
  return answer(request, choice, ctx);
}

const LABELS: Record<Choice, () => string> = {
  edits: () => copy.planAcceptEdits,
  manual: () => copy.planManual,
  keep: () => copy.planKeep,
};

/** A dismissed dialog keeps planning, as Escape does in Claude Code. */
async function askChoice(ui: NonNullable<PlanContext["ui"]>, ctx: PlanContext): Promise<Choice> {
  const choices = Object.keys(LABELS) as Choice[];
  const label = await ui.select(
    copy.planQuestion,
    choices.map((choice) => LABELS[choice]()),
    { signal: ctx.signal },
  );
  const choice = choices.find((candidate) => LABELS[candidate]() === label) ?? "keep";
  if (choice === "keep") await askFeedback(ui, ctx);
  return choice;
}

async function askFeedback(ui: NonNullable<PlanContext["ui"]>, ctx: PlanContext): Promise<void> {
  const text = (await ui.input(copy.planFeedback, undefined, { signal: ctx.signal }))?.trim();
  if (text) ctx.sendFeedback(text);
}

const ANSWERS: Record<
  Choice,
  (options: PermissionOption[], ctx: PlanContext) => PermissionOption | undefined
> = {
  edits: (options, ctx) => byId(options, ACCEPT_EDITS) ?? manualThenEdits(options, ctx),
  manual: (options) => byId(options, MANUAL),
  keep: (options) => options.find((option) => option.kind === "reject_once"),
};

function answer(
  request: RequestPermissionRequest,
  choice: Choice,
  ctx: PlanContext,
): RequestPermissionResponse {
  const option = ANSWERS[choice](request.options, ctx);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/** The adapter offers auto-accept edits only when the model has no Auto mode (options/tools.js:83-89). */
function manualThenEdits(options: PermissionOption[], ctx: PlanContext): PermissionOption | undefined {
  const manual = byId(options, MANUAL);
  if (manual) ctx.acceptEditsAfterApproval();
  return manual;
}

function byId(options: PermissionOption[], optionId: string): PermissionOption | undefined {
  return options.find((option) => option.optionId === optionId);
}
