import type * as acp from "@agentclientprotocol/sdk";
import { getCurrentTools, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { ACTIVITY_TOOL } from "./activity.ts";
import { toolNameOf } from "./claude-code-meta.ts";
import { HARNESS_SERVER } from "./harness-server.ts";

/**
 * Pi tools the agent already has as its own (Read, Edit, Write, Bash, Grep, Glob, LS). Offering them
 * too would give the agent two tools with the same name and different behavior (docs/adr/0002).
 */
const AGENT_NATIVE = new Set(["read", "edit", "write", "bash", "grep", "find", "ls"]);
/** How claude-agent-acp names a tool of the harness MCP server in its reports. */
const REPORT_PREFIX = `mcp__${HARNESS_SERVER}__`;

/** Pi's settings with the key of this extension. */
interface ClaudeAcpSettings {
  claudeAcp?: { hiddenTools?: unknown };
}

/**
 * The harness tools of a request: the Pi tools the agent can call through the harness, except the
 * `hidden` ones. Pi extensions such as gentle-engram and context7-pi register tools with the names
 * of the MCP servers the agent already gets from `mcp.json`; `hidden` leaves those out.
 */
export function harnessTools(context: TranscriptContext, hidden: string[]): Tool[] {
  const isHidden = matcher(hidden);
  return getCurrentTools(context.messages).filter(
    (tool) => !AGENT_NATIVE.has(tool.name) && tool.name !== ACTIVITY_TOOL && !isHidden(tool.name),
  );
}

/** `claudeAcp.hiddenTools` of Pi's settings: tool names, where `*` matches any characters. */
export function hiddenTools(settings: object): string[] {
  const value = (settings as ClaudeAcpSettings).claudeAcp?.hiddenTools;
  return Array.isArray(value) ? value.filter((pattern) => typeof pattern === "string") : [];
}

function matcher(patterns: string[]): (name: string) => boolean {
  const expressions = patterns.map(toRegExp);
  return (name) => expressions.some((expression) => expression.test(name));
}

const toRegExp = (pattern: string) => new RegExp(`^${pattern.split("*").map(literal).join(".*")}$`);
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A tool report of a harness tool. Pi shows that call as its own tool, so no burst shows it. */
export function isHarnessReport(update: acp.SessionUpdate): boolean {
  return update.sessionUpdate === "tool_call" && toolNameOf(update).startsWith(REPORT_PREFIX);
}
