import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { compact } from "../src/compact.ts";
import { copy } from "../src/messages.ts";

function commandCtx(provider: string, calls: string[]) {
  return {
    model: { provider },
    ui: { notify: (message: string, type?: string) => calls.push(`notify ${type} ${message}`) },
    waitForIdle: async () => {
      calls.push("idle");
    },
  } as unknown as ExtensionCommandContext;
}

describe("compact", () => {
  it("C40: waits for the turn, then sends Claude Code's /compact with the user's instructions", async () => {
    const calls: string[] = [];
    await compact("  keep the decisions ", commandCtx("claude-acp", calls), (text) =>
      calls.push(`send ${text}`),
    );
    expect(calls).toEqual(["idle", "send /compact keep the decisions"]);
  });

  it("C40: sends a bare /compact without instructions", async () => {
    const calls: string[] = [];
    await compact("", commandCtx("claude-acp", calls), (text) => calls.push(`send ${text}`));
    expect(calls).toEqual(["idle", "send /compact"]);
  });

  it("C40: with another provider, sends nothing and points to Pi's /compact", async () => {
    const calls: string[] = [];
    await compact("", commandCtx("anthropic", calls), (text) => calls.push(`send ${text}`));
    expect(calls).toEqual([`notify warning ${copy.compactOtherProvider}`]);
  });
});
