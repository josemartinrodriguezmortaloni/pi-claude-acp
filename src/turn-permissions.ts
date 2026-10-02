import type * as acp from "@agentclientprotocol/sdk";
import { claudeCodeMeta, toolNameOf } from "./claude-code-meta.ts";
import type { Log } from "./connection.ts";
import type { LiveTurn } from "./turn.ts";

/** What answering a permission request of a turn needs. */
export interface PermissionDeps {
  decide(request: acp.RequestPermissionRequest, signal?: AbortSignal): Promise<acp.RequestPermissionResponse>;
  log: Log;
}

/** The book shows the tool as awaiting while the dialog is open, and as rejected when the answer is no. */
export async function decideFor(
  turn: LiveTurn,
  request: acp.RequestPermissionRequest,
  deps: PermissionDeps,
): Promise<acp.RequestPermissionResponse> {
  const id = request.toolCall.toolCallId;
  turn.tools.mark(id, "awaiting");
  const response = await decideLogged(withToolName(request, turn.tools.get(id).name), turn.signal, deps);
  turn.tools.mark(id, rejects(request, response) ? "rejected" : "pending");
  return response;
}

/**
 * The adapter's permission request carries no tool name (only the title, which for Bash is the command
 * itself); the dialog takes it from the tool_call report.
 */
function withToolName(request: acp.RequestPermissionRequest, toolName: string): acp.RequestPermissionRequest {
  const meta = Object(request.toolCall._meta) as Record<string, unknown>;
  const claudeCode = { toolName, ...claudeCodeMeta(request.toolCall) };
  return { ...request, toolCall: { ...request.toolCall, _meta: { ...meta, claudeCode } } };
}

function rejects(request: acp.RequestPermissionRequest, response: acp.RequestPermissionResponse): boolean {
  const outcome = response.outcome;
  const optionId = outcome.outcome === "selected" ? outcome.optionId : undefined;
  return request.options.some((option) => option.optionId === optionId && option.kind.startsWith("reject"));
}

/**
 * Every permission request and its answer go to the log: a pending one is what hangs a turn. The log
 * names the tool and its id, never the title: for Bash the title is the command, which can hold a secret.
 */
async function decideLogged(
  request: acp.RequestPermissionRequest,
  signal: AbortSignal,
  deps: PermissionDeps,
): Promise<acp.RequestPermissionResponse> {
  const tool = `${toolNameOf(request.toolCall)} ${request.toolCall.toolCallId}`.trim();
  deps.log(`permiso pedido: ${tool}`);
  const response = await deps.decide(request, signal);
  const outcome = response.outcome;
  deps.log(
    `permiso respondido: ${tool} → ${outcome.outcome === "selected" ? outcome.optionId : "cancelled"}`,
  );
  return response;
}
