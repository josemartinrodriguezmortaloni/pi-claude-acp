/** What claude-agent-acp adds under `_meta.claudeCode` to its reports and requests (acp-agent.js:483-491). */
export interface ClaudeCodeMeta {
  /** The tool's own name: "Bash", "Edit", "mcp__pi__eval". */
  toolName?: unknown;
  /** On everything a subagent emits: the id of its Task tool. */
  parentToolUseId?: unknown;
}

/** The `_meta.claudeCode` of an ACP report or tool call, empty when it has none. */
export function claudeCodeMeta(value: unknown): ClaudeCodeMeta {
  return Object(Object(Object(value)._meta).claudeCode);
}

/** The tool name the adapter reports, or "" when it reports none. */
export function toolNameOf(value: unknown): string {
  const name = claudeCodeMeta(value).toolName;
  return typeof name === "string" ? name : "";
}
