import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../src/burst.ts";
import { type ProgressPainter, planItems, progressLines, subagentItems } from "../src/progress-widget.ts";

const plain: ProgressPainter = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => `~${text}~`,
};

const items = (states: ("done" | "active" | "pending")[]) =>
  states.map((state, index) => ({ text: `paso ${index + 1}`, state }));

describe("progressLines", () => {
  it("shows the title with the done count, then each row under a rail with its own mark", () => {
    expect(progressLines("Plan", items(["done", "active", "pending"]), false, plain)).toEqual([
      "  Plan · 1/3",
      "│ ✓ ~paso 1~",
      "│ ● paso 2",
      "│ ○ paso 3",
    ]);
  });

  it("shows 4 rows from just before the first unfinished one and counts the rest", () => {
    const lines = progressLines(
      "Plan",
      items(["done", "done", "done", "active", "pending", "pending", "pending"]),
      false,
      plain,
    );
    expect(lines).toEqual([
      "  Plan · 3/7",
      "│ ✓ ~paso 3~",
      "│ ● paso 4",
      "│ ○ paso 5",
      "│ ○ paso 6",
      "│ … 3 más, Ctrl+O para ver todo",
    ]);
  });

  it("shows every row when the detail is expanded", () => {
    expect(
      progressLines("Plan", items(["active", "pending", "pending", "pending", "pending"]), true, plain),
    ).toHaveLength(6);
  });
});

describe("planItems", () => {
  it("maps plan statuses and disappears once everything is done", () => {
    expect(
      planItems([
        { content: "Leer", priority: "high", status: "completed" },
        { content: "Editar", priority: "high", status: "in_progress" },
      ]),
    ).toEqual([
      { text: "Leer", state: "done" },
      { text: "Editar", state: "active" },
    ]);
    expect(planItems([{ content: "Leer", priority: "high", status: "completed" }])).toBeUndefined();
  });
});

describe("subagentItems", () => {
  const entry = (fields: Partial<ToolEntry> & Pick<ToolEntry, "id" | "name">): ToolEntry => ({
    kind: "other",
    target: "",
    status: "completed",
    output: "",
    ...fields,
  });

  it("shows a running subagent with the tool it runs now and a finished one with how many it ran", () => {
    const tools = [
      entry({ id: "a", name: "Task", kind: "think", target: "revisar copy" }),
      entry({ id: "a1", name: "Grep", target: '"Claude"', parentId: "a" }),
      entry({ id: "b", name: "Task", kind: "think", target: "buscar tests", status: "in_progress" }),
      entry({ id: "b1", name: "Read", target: "tests/a.ts", parentId: "b", status: "in_progress" }),
    ];
    expect(subagentItems(tools)).toEqual([
      { text: "revisar copy · 1 herramienta", state: "done" },
      { text: "buscar tests · Read tests/a.ts", state: "active" },
    ]);
  });

  it("disappears when no subagent is running", () => {
    expect(subagentItems([entry({ id: "a", name: "Task", kind: "think" })])).toBeUndefined();
    expect(
      subagentItems([entry({ id: "r", name: "Read", kind: "read", status: "in_progress" })]),
    ).toBeUndefined();
  });
});
