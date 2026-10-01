import { describe, expect, it } from "vitest";
import { activityLines, type Painter } from "../src/activity-view.ts";
import type { ToolEntry } from "../src/burst.ts";

/** Colors vanish; a chip reads as [label] and italics as _text_, so the shape stays testable. */
const plain: Painter = {
  fg: (_color, text) => text,
  bold: (text) => text,
  inverse: (text) => `[${text.trim()}]`,
  italic: (text) => `_${text}_`,
};

/** Keeps the color names, for the assertions about which token paints what. */
const tagged: Painter = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => text,
  inverse: (text) => `[${text}]`,
  italic: (text) => text,
};

function tool(fields: Partial<ToolEntry> & Pick<ToolEntry, "id" | "name">): ToolEntry {
  return { kind: "other", target: "", status: "completed", output: "", ...fields };
}

const read = tool({ id: "r", name: "Read", kind: "read", target: "src/x.ts", output: "a\nb\nc" });
const lines = (count: number) => Array.from({ length: count }, (_, index) => `l${index + 1}`).join("\n");

describe("activityLines", () => {
  it("opens with a summary that counts the tools by what they do, failures last", () => {
    const bash = tool({ id: "b", name: "Bash", kind: "execute", target: "ls", status: "failed" });
    const [summary] = activityLines({ tools: [read, bash] }, false, plain);
    expect(summary).toBe("● 2 herramientas · 1 lectura · 1 comando · ✗ 1 falló");
  });

  it("shows a read as one muted line without a chip, with the lines it read", () => {
    const [, branch] = activityLines({ tools: [read] }, false, tagged);
    expect(branch).toBe("<dim>└</dim> <muted>Read src/x.ts</muted> <dim>· 3 líneas</dim>");
  });

  it("gives a chip only to tools that change something, and tree branches to every tool", () => {
    const edit = tool({ id: "e", name: "Edit", kind: "edit", target: "src/x.ts" });
    const write = tool({ id: "w", name: "Write", kind: "edit", target: "src/new.ts" });
    expect(activityLines({ tools: [read, edit, write] }, false, plain).slice(1)).toEqual([
      "├ Read src/x.ts · 3 líneas",
      "├ [EDIT] src/x.ts",
      "└ [CREATE] src/new.ts",
    ]);
  });

  it("shows the search pattern and where it looks, with the results it found", () => {
    const grep = tool({
      id: "g",
      name: "Grep",
      kind: "search",
      target: '"TODO"',
      scope: "src/",
      output: "a:1\nb:2",
    });
    expect(activityLines({ tools: [grep] }, false, plain)[1]).toBe('└ Grep "TODO" en src/ · 2 resultados');
  });

  it("shows the first 5 lines of a command while contracted and counts the rest", () => {
    const bash = tool({ id: "b", name: "Bash", kind: "execute", target: "ls", output: lines(8) });
    expect(activityLines({ tools: [bash] }, false, plain).slice(1)).toEqual([
      "└ [BASH] ls",
      "   l1",
      "   l2",
      "   l3",
      "   l4",
      "   l5",
      "   … (+3 líneas)",
    ]);
  });

  it("always shows the output of a failure, under a rail when more branches follow", () => {
    const failed = tool({
      id: "f",
      name: "Read",
      kind: "read",
      target: "x",
      status: "failed",
      output: "ENOENT",
    });
    expect(activityLines({ tools: [failed, read] }, false, plain).slice(1, 3)).toEqual([
      "├ Read x [FALLÓ]",
      "│  ENOENT",
    ]);
  });

  it("hides what a read returned until the detail is expanded, then shows up to 20 lines", () => {
    const long = { ...read, output: lines(25) };
    expect(activityLines({ tools: [long] }, false, plain)).toHaveLength(2);
    const expanded = activityLines({ tools: [long] }, true, plain);
    expect(expanded).toHaveLength(2 + 20 + 1);
    expect(expanded.at(-1)).toBe("   … (+5 líneas)");
  });

  it.each([
    ["awaiting", "? esperando aprobación"],
    ["rejected", "✗ rechazada"],
    ["interrupted", "■ interrumpida"],
    ["in_progress", "…"],
  ] as const)("names the %s status with its own mark", (status, text) => {
    const bash = tool({ id: "b", name: "Bash", kind: "execute", target: "rm -rf dist", status });
    expect(activityLines({ tools: [bash] }, false, plain)[1]).toBe(`└ [BASH] rm -rf dist ${text}`);
  });

  it("shows a subagent as one line while contracted and as a nested tree with its text when expanded", () => {
    const task = tool({
      id: "task",
      name: "Task",
      kind: "think",
      target: "buscar tests",
      subagentText: "C12 en a.ts",
    });
    const child = { ...read, id: "c", parentId: "task" };
    const details = { tools: [task, child] };
    expect(activityLines(details, false, plain)).toEqual([
      "● 1 herramienta · 1 subagente",
      "└ [TASK] buscar tests · 1 herramienta",
    ]);
    expect(activityLines(details, true, plain).slice(2)).toEqual([
      "   └ Read src/x.ts · 3 líneas",
      "      a",
      "      b",
      "      c",
      "   _C12 en a.ts_",
    ]);
  });

  it("names a tool once when its title is its own name", () => {
    const search = tool({ id: "s", name: "ToolSearch", target: "ToolSearch" });
    expect(activityLines({ tools: [search] }, false, plain)[1]).toBe("└ ToolSearch");
  });

  it("cuts a long output line at 200 characters", () => {
    const bash = tool({ id: "b", name: "Bash", kind: "execute", target: "cat", output: "x".repeat(300) });
    expect(activityLines({ tools: [bash] }, false, plain)[2]).toBe(`   ${"x".repeat(200)}…`);
  });

  it("shows the diff of an edit even contracted, up to 12 lines, and its stats on the branch and the summary", () => {
    const lines = [" 1 a", "-2 b", "+2 B", ...Array.from({ length: 12 }, (_, index) => ` ${index + 3} c`)];
    const change = { lines, hidden: 0, added: 1, removed: 1, created: false };
    const edit = tool({ id: "e", name: "Edit", kind: "edit", target: "a.ts", change });
    const shown = activityLines({ tools: [edit] }, false, plain);
    expect(shown[0]).toBe("● 1 herramienta · 1 edición · +1 −1");
    expect(shown[1]).toBe("└ [EDIT] a.ts +1 −1");
    expect(shown.slice(2, 5)).toEqual(["    1 a", "   -2 b", "   +2 B"]);
    expect(shown).toHaveLength(2 + 12 + 1);
    expect(shown.at(-1)).toBe("   … (+3 líneas)");
  });

  it("paints added, removed and context lines with the theme diff colors", () => {
    const change = { lines: [" 1 a", "-2 b", "+2 B"], hidden: 0, added: 1, removed: 1, created: false };
    const edit = tool({ id: "e", name: "Edit", kind: "edit", target: "a.ts", change });
    expect(activityLines({ tools: [edit] }, false, tagged).slice(2)).toEqual([
      "   <toolDiffContext> 1 a</toolDiffContext>",
      "   <toolDiffRemoved>-2 b</toolDiffRemoved>",
      "   <toolDiffAdded>+2 B</toolDiffAdded>",
    ]);
  });

  it("keeps a new file contracted to one line and shows its content when expanded", () => {
    const change = { lines: ["+1 x", "+2 y"], hidden: 0, added: 2, removed: 0, created: true };
    const write = tool({ id: "w", name: "Write", kind: "edit", target: "n.ts", change });
    expect(activityLines({ tools: [write] }, false, plain).slice(1)).toEqual(["└ [CREATE] n.ts +2"]);
    expect(activityLines({ tools: [write] }, true, plain).slice(2)).toEqual(["   +1 x", "   +2 y"]);
  });

  it("shows a Write over an existing file as an edit", () => {
    const change = { lines: ["-1 x", "+1 y"], hidden: 0, added: 1, removed: 1, created: false };
    const write = tool({ id: "w", name: "Write", kind: "edit", target: "a.ts", change });
    expect(activityLines({ tools: [write] }, false, plain)[1]).toBe("└ [EDIT] a.ts +1 −1");
  });

  it("shows the error of a failed edit instead of the change it asked for", () => {
    const change = { lines: ["-1 x", "+1 y"], hidden: 0, added: 1, removed: 1, created: false };
    const edit = tool({
      id: "e",
      name: "Edit",
      kind: "edit",
      target: "a.ts",
      status: "failed",
      output: "old_string not found",
      change,
    });
    expect(activityLines({ tools: [edit] }, false, plain).slice(2)).toEqual(["   old_string not found"]);
  });
});

describe("activityLines: reasoning", () => {
  const live = { text: "Primero leo el diálogo.\nDespués corro los tests.", startedAt: 0 };

  it("shows the seconds so far and the last line while the model reasons, in the accent color", () => {
    expect(activityLines({ reasoning: live }, false, tagged, 3_200)).toEqual([
      "<accent>• Pensando 3 s</accent>",
      "  <accent>Después corro los tests.</accent>",
    ]);
  });

  it("blinks the mark every half second", () => {
    expect(activityLines({ reasoning: live }, false, plain, 3_700)[0]).toBe("  Pensando 4 s");
  });

  it("collapses to how long it took once done, and shows the whole text when expanded", () => {
    const done = { ...live, endedAt: 6_000 };
    expect(activityLines({ reasoning: done }, false, plain)).toEqual(["• Pensó 6 s"]);
    expect(activityLines({ reasoning: done }, true, plain)).toEqual([
      "• Pensó 6 s",
      "  _Primero leo el diálogo._",
      "  _Después corro los tests._",
    ]);
  });

  it("counts at least one second", () => {
    expect(activityLines({ reasoning: { text: "", startedAt: 0, endedAt: 100 } }, false, plain)).toEqual([
      "• Pensó 1 s",
    ]);
  });
});

describe("activityLines: plan", () => {
  it("shows the plan with a chip and its whole text, never collapsed, and the approval", () => {
    const plan = tool({
      id: "p",
      name: "ExitPlanMode",
      kind: "switch_mode",
      target: "Approve Plan",
      status: "awaiting",
      plan: "1. Leer\n2. Editar",
    });
    expect(activityLines({ tools: [plan] }, false, plain)).toEqual([
      "● 1 herramienta · 1 plan",
      "└ [PLAN] ? esperando aprobación",
      "   1. Leer",
      "   2. Editar",
    ]);
    expect(activityLines({ tools: [{ ...plan, status: "completed" }] }, false, plain)[1]).toBe(
      "└ [PLAN] · ✓ aprobado",
    );
  });
});
