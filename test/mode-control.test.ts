import { describe, expect, it } from "vitest";
import { copy } from "../src/messages.ts";
import { ModeControl } from "../src/mode-control.ts";
import type { ModeId } from "../src/modes.ts";

function setup(provider = "claude-acp", dialogAnswer?: string) {
  const applied: ModeId[] = [];
  const persisted: ModeId[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  const control = new ModeControl({
    applyMode: async (_piSessionId, mode) => {
      applied.push(mode);
    },
    persist: (mode) => persisted.push(mode),
  });
  const ctx = {
    model: { provider },
    sessionManager: { getSessionId: () => "pi-1" },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (message: string) => notes.push(message),
      select: async () => dialogAnswer,
    },
  } as never;
  return { control, ctx, applied, persisted, statuses, notes };
}

describe("ModeControl", () => {
  it("applies, records and shows the mode the user picks", async () => {
    const { control, ctx, applied, persisted, statuses } = setup();
    await control.choose(ctx, "plan");
    expect(control.get("pi-1")).toBe("plan");
    expect(applied).toEqual(["plan"]);
    expect(persisted).toEqual(["plan"]);
    expect(statuses.at(-1)).toBe(`${copy.modeLabel.plan} (alt+m)`);
  });

  it("cycles with alt+m only while a claude-acp model is active", async () => {
    const acp = setup();
    await acp.control.cycle(acp.ctx);
    expect(acp.control.get("pi-1")).toBe("acceptEdits");
    const other = setup("anthropic");
    await other.control.cycle(other.ctx);
    expect(other.applied).toEqual([]);
  });

  it("hides the indicator for other providers", () => {
    const { control, ctx, statuses } = setup("anthropic");
    control.showStatus(ctx);
    expect(statuses).toEqual([undefined]);
  });

  it("takes a mode name in /mode, or asks for one", async () => {
    const named = setup();
    await named.control.command("edits", named.ctx);
    expect(named.control.get("pi-1")).toBe("acceptEdits");
    const asked = setup("claude-acp", copy.modeLabel.plan);
    await asked.control.command("", asked.ctx);
    expect(asked.control.get("pi-1")).toBe("plan");
  });

  it("accepts auto in /mode and paints it as a risk", async () => {
    const { control, ctx, statuses } = setup();
    await control.command("auto", ctx);
    expect(control.get("pi-1")).toBe("auto");
    expect(statuses.at(-1)).toBe(`${copy.modeLabel.auto} (alt+m)`);
  });

  it("reports an unknown mode name and keeps the mode", async () => {
    const { control, ctx, notes, applied } = setup();
    await control.command("yolo", ctx);
    expect(notes).toEqual([copy.modeUnknown("yolo")]);
    expect(applied).toEqual([]);
  });

  it("follows the agent into a mode without applying it back", async () => {
    const { control, ctx, applied } = setup();
    await control.agentChanged(ctx, "plan");
    expect(control.get("pi-1")).toBe("plan");
    expect(applied).toEqual([]);
  });

  it("ignores modes the extension does not offer", async () => {
    const { control, ctx, persisted } = setup();
    await control.agentChanged(ctx, "bypassPermissions");
    expect(persisted).toEqual([]);
  });

  it("switches to auto-accept edits when an approved plan lands in Manual and the user chose edits", async () => {
    const { control, ctx, applied } = setup();
    control.acceptEditsAfterPlan("pi-1");
    await control.agentChanged(ctx, "default");
    expect(control.get("pi-1")).toBe("acceptEdits");
    expect(applied).toEqual(["acceptEdits"]);
    await control.agentChanged(ctx, "default");
    expect(control.get("pi-1")).toBe("default");
  });
});
