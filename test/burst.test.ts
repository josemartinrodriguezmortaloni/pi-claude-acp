import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { Burst, type BurstDetails, ToolBook } from "../src/burst.ts";

type Report = Parameters<ToolBook["report"]>[0];

const named = (toolName: string, report: Report): Report => ({
  ...report,
  _meta: { claudeCode: { toolName } },
});

function book() {
  let changes = 0;
  const tools = new ToolBook(() => changes++);
  return { tools, changes: () => changes };
}

describe("ToolBook", () => {
  it("names the tool from the adapter meta and takes the target from the title", () => {
    const { tools } = book();
    tools.report(named("Read", { toolCallId: "t1", title: "Read src/x.ts", kind: "read" }));
    expect(tools.get("t1")).toMatchObject({
      name: "Read",
      kind: "read",
      target: "src/x.ts",
      status: "pending",
    });
  });

  it("uses the whole title as the target of tools titled by their command", () => {
    const { tools } = book();
    tools.report(named("Bash", { toolCallId: "t1", title: "bun run test", kind: "execute" }));
    expect(tools.get("t1").target).toBe("bun run test");
  });

  it("shows the pattern and the place of a search instead of the synthesized grep command", () => {
    const { tools } = book();
    tools.report(
      named("Grep", {
        toolCallId: "t1",
        title: 'grep -n "Claude Code" src',
        kind: "search",
        rawInput: { pattern: "Claude Code", path: "src/" },
      }),
    );
    expect(tools.get("t1")).toMatchObject({ target: '"Claude Code"', scope: "src/" });
  });

  it("keeps what earlier reports said when an update omits it", () => {
    const { tools } = book();
    tools.report(named("Read", { toolCallId: "t1", title: "Read a.ts", kind: "read" }));
    tools.report({ toolCallId: "t1", status: "completed" });
    expect(tools.get("t1")).toMatchObject({ name: "Read", target: "a.ts", status: "completed" });
  });

  it("drops the fence the adapter puts around command output", () => {
    const { tools } = book();
    const fenced = "```console\n.gitignore\nTASKS.md\n```";
    tools.report({
      toolCallId: "t1",
      content: [{ type: "content", content: { type: "text", text: fenced } }],
    });
    expect(tools.get("t1").output).toBe(".gitignore\nTASKS.md");
  });

  it("reads the output from rawOutput when there is no text content", () => {
    const { tools } = book();
    tools.report({ toolCallId: "t1", status: "failed", rawOutput: "no such file" });
    expect(tools.get("t1").output).toBe("no such file");
  });

  it("keeps a rejection when ACP later reports the tool as failed", () => {
    const { tools } = book();
    tools.mark("t1", "rejected");
    tools.report({ toolCallId: "t1", status: "failed" });
    expect(tools.get("t1").status).toBe("rejected");
  });

  it("marks only open tools as interrupted", () => {
    const { tools } = book();
    tools.report({ toolCallId: "done", status: "completed" });
    tools.report({ toolCallId: "running", status: "in_progress" });
    tools.mark("asking", "awaiting");
    tools.interruptOpen();
    expect(["done", "running", "asking"].map((id) => tools.get(id).status)).toEqual([
      "completed",
      "interrupted",
      "interrupted",
    ]);
  });

  it("records the Task tool a subagent tool belongs to and what the subagent writes", () => {
    const { tools } = book();
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read a.ts",
      _meta: { claudeCode: { toolName: "Read", parentToolUseId: "task" } },
    };
    tools.report(update);
    tools.addSubagentText("task", "encontré ");
    tools.addSubagentText("task", "C12");
    expect(tools.get("t1").parentId).toBe("task");
    expect(tools.get("task").subagentText).toBe("encontré C12");
  });

  it("calls back on every change", () => {
    const { tools, changes } = book();
    tools.report({ toolCallId: "t1" });
    tools.mark("t1", "awaiting");
    expect(changes()).toBe(2);
  });
});

describe("ToolBook: file changes", () => {
  it("numbers each hunk from the line the adapter reports and counts what it adds and removes", () => {
    const { tools } = book();
    tools.report({
      toolCallId: "t1",
      content: [{ type: "diff", path: "/w/a.ts", oldText: "uno\ndos\ntres", newText: "uno\nDOS\ntres" }],
      locations: [{ path: "/w/a.ts", line: 40 }],
    });
    expect(tools.get("t1").change).toEqual({
      lines: [" 40 uno", "-41 dos", "+41 DOS", " 42 tres"],
      hidden: 0,
      added: 1,
      removed: 1,
      created: false,
    });
  });

  it("separates hunks with a gap line", () => {
    const { tools } = book();
    tools.report({
      toolCallId: "t1",
      content: [
        { type: "diff", path: "a", oldText: "a", newText: "b" },
        { type: "diff", path: "a", oldText: "c", newText: "d" },
      ],
      locations: [
        { path: "a", line: 1 },
        { path: "a", line: 90 },
      ],
    });
    expect(tools.get("t1").change?.lines).toEqual(["-1 a", "+1 b", "   ...", "-90 c", "+90 d"]);
  });

  it("marks a change without old text as a created file", () => {
    const { tools } = book();
    tools.report({
      toolCallId: "t1",
      content: [{ type: "diff", path: "n.ts", oldText: null, newText: "x\ny" }],
    });
    expect(tools.get("t1").change).toMatchObject({
      lines: ["+1 x", "+2 y"],
      added: 2,
      removed: 0,
      created: true,
    });
  });

  it("keeps 80 lines of a long change and counts the rest", () => {
    const { tools } = book();
    const content = Array.from({ length: 100 }, (_, index) => `l${index}`).join("\n");
    tools.report({
      toolCallId: "t1",
      content: [{ type: "diff", path: "n.ts", oldText: null, newText: content }],
    });
    expect(tools.get("t1").change).toMatchObject({ hidden: 20, added: 100 });
    expect(tools.get("t1").change?.lines).toHaveLength(80);
  });

  it("replaces the requested change with the one the tool made", () => {
    const { tools } = book();
    tools.report({ toolCallId: "t1", content: [{ type: "diff", path: "a", oldText: "x", newText: "y" }] });
    tools.report({ toolCallId: "t1", status: "completed" });
    expect(tools.get("t1").change?.lines).toEqual(["-1 x", "+1 y"]);
    tools.report({
      toolCallId: "t1",
      content: [{ type: "diff", path: "a", oldText: "x", newText: "y" }],
      locations: [{ path: "a", line: 7 }],
    });
    expect(tools.get("t1").change?.lines).toEqual(["-7 x", "+7 y"]);
  });
});

describe("Burst", () => {
  it("sends its tools to a subscriber at once and on every change, in the order they started", () => {
    let burst: Burst | undefined;
    const tools = new ToolBook(() => burst?.changed());
    burst = new Burst("t1", tools);
    const seen: BurstDetails[] = [];
    burst.add("t1");
    burst.subscribe((details) => seen.push(details));
    burst.add("t2");
    tools.report({ toolCallId: "t2", status: "completed" });
    expect(seen.map((details) => details.tools.map((tool) => `${tool.id}:${tool.status}`))).toEqual([
      ["t1:pending"],
      ["t1:pending", "t2:pending"],
      ["t1:pending", "t2:completed"],
    ]);
  });

  it("resolves done with its tools once finished, and later changes reach no one", async () => {
    let burst: Burst | undefined;
    const tools = new ToolBook(() => burst?.changed());
    burst = new Burst("t1", tools);
    burst.add("t1");
    const seen: BurstDetails[] = [];
    burst.subscribe((details) => seen.push(details));
    burst.finish();
    tools.report({ toolCallId: "t1", status: "completed" });
    await expect(burst.done).resolves.toEqual({
      tools: [expect.objectContaining({ id: "t1", status: "pending" })],
    });
    expect(seen).toHaveLength(1);
  });

  it("hands out copies, so a later report does not change details already sent", () => {
    const tools = new ToolBook(() => {});
    const burst = new Burst("t1", tools);
    burst.add("t1");
    const before = burst.details();
    tools.report({ toolCallId: "t1", status: "completed" });
    expect(before.tools[0]?.status).toBe("pending");
  });
});
