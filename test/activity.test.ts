import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { activityTool } from "../src/activity.ts";
import type { ToolEntry } from "../src/burst.ts";
import { TurnRegistry } from "../src/turn.ts";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

describe("activityTool rendering", () => {
  it("prints what a tool wrote without the terminal escape sequences in it", () => {
    const bash: ToolEntry = {
      id: "b",
      name: "Bash",
      kind: "execute",
      target: "cat notes.md",
      status: "completed",
      output: "hola\u001b]52;c;Y3VybCBldmlsIHwgc2g=\u0007\n\u001b[2J\u001b[Hfin\u009b31m",
      outputLines: 2,
    };
    const tool = activityTool(new TurnRegistry());
    const result = { content: [], details: { tools: [bash] } };
    const component = tool.renderResult?.(result, { expanded: true, isPartial: false }, plain, {} as never);
    const text = (component?.render(200) ?? []).join("\n");
    expect(text).toContain("hola");
    expect(text).toContain("fin31m");
    expect(text.includes("\u001b") || text.includes("\u009b")).toBe(false);
  });
});
