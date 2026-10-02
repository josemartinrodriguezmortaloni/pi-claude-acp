import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { activityLines } from "./activity-view.ts";
import { nameAndTarget } from "./burst.ts";
import { copy } from "./messages.ts";
import { printableJson } from "./terminal-text.ts";
import { type ActivityDetails, onAbort, type TurnRegistry } from "./turn.ts";

/**
 * The activity tool (docs/adr/0001). It is not Pi's read, edit or bash: with those names Pi would run
 * the real tool again.
 */
export const ACTIVITY_TOOL = "agent_activity";

const PARAMETERS = Type.Object({});

/**
 * Shows one burst of tools or one run of reasoning as a collapsible entry. It runs nothing: it waits
 * for that part of the turn to end.
 */
export function activityTool(turns: TurnRegistry): ToolDefinition<typeof PARAMETERS, ActivityDetails> {
  return {
    name: ACTIVITY_TOOL,
    label: copy.activityLabel,
    description: "Shows what the agent already did. Only the claude-acp provider calls it.",
    parameters: PARAMETERS,
    renderShell: "self",
    executionMode: "sequential",
    annotations: { readOnlyHint: true },
    // Active so Pi can run it, but never declared to a model.
    prepareLoadout: () => ({ hiddenDeclarations: [ACTIVITY_TOOL] }),
    execute: (toolCallId, _params, signal, onUpdate) => showActivity(turns, toolCallId, signal, onUpdate),
    renderCall: () => new Container(),
    // The details hold what tools printed; a session file written before this version may hold escapes too.
    renderResult: (result, { expanded }, theme) =>
      result.details
        ? new Text(activityLines(printableJson(result.details), expanded, theme).join("\n"), 0, 0)
        : new Container(),
  };
}

async function showActivity(
  turns: TurnRegistry,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ActivityDetails> | undefined,
): Promise<AgentToolResult<ActivityDetails>> {
  const entry = turns.takeActivity(toolCallId);
  if (!entry) return { content: [{ type: "text", text: copy.activityUnavailable }], details: { tools: [] } };
  const stopCancelling = onAbort(signal, () => entry.turn.cancel());
  const unsubscribe = entry.activity.subscribe((details) => onUpdate?.({ content: [], details }));
  try {
    const details = await entry.activity.done;
    return { content: [{ type: "text", text: modelSummary(details) }], details };
  } finally {
    unsubscribe();
    stopCancelling();
  }
}

/** What another provider reads if the user switches models later: the reasoning, or one line per tool. */
export function modelSummary(details: ActivityDetails): string {
  if ("reasoning" in details) return details.reasoning.text;
  return details.tools.map((tool) => `${nameAndTarget(tool)}: ${tool.status}`).join("\n");
}
