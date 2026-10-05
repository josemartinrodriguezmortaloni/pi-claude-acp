import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copy } from "./messages.ts";
import { usesClaudeAcp } from "./sessions.ts";

export const COMPACT_COMMAND = "claude-compact";
/** Claude Code's own command. Pi's `/compact` is cancelled for claude-acp: Claude Code owns the history. */
const CLAUDE_COMPACT = "/compact";

/** Asks the agent to compact its history, with the user's instructions for the summary. */
export async function compact(
  args: string,
  ctx: ExtensionCommandContext,
  send: (text: string) => void,
): Promise<void> {
  if (!usesClaudeAcp(ctx.model)) return ctx.ui.notify(copy.compactOtherProvider, "warning");
  await ctx.waitForIdle();
  send([CLAUDE_COMPACT, args.trim()].filter(Boolean).join(" "));
}
