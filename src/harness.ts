import type * as acp from "@agentclientprotocol/sdk";
import { getCurrentTools, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { ACTIVITY_TOOL } from "./activity.ts";
import { HARNESS_SERVER } from "./harness-server.ts";

/**
 * Pi tools the agent already has as its own (Read, Edit, Write, Bash, Grep, Glob, LS). Offering them
 * too would give the agent two tools with the same name and different behavior (docs/adr/0002).
 */
const AGENT_NATIVE = new Set(["read", "edit", "write", "bash", "grep", "find", "ls"]);
/** How claude-agent-acp names a tool of the harness MCP server in its reports. */
const REPORT_PREFIX = `mcp__${HARNESS_SERVER}__`;

/** The harness tools of a request: the Pi tools the agent can call through the harness. */
export function harnessTools(context: TranscriptContext): Tool[] {
  return getCurrentTools(context.messages).filter(
    (tool) => !AGENT_NATIVE.has(tool.name) && tool.name !== ACTIVITY_TOOL,
  );
}

/** A tool report of a harness tool. Pi shows that call as its own tool, so no burst shows it. */
export function isHarnessReport(update: acp.SessionUpdate): boolean {
  const name = Object(Object(Object(update)._meta).claudeCode).toolName;
  return update.sessionUpdate === "tool_call" && String(name).startsWith(REPORT_PREFIX);
}
