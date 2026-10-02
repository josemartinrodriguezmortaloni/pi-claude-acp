import { mkdtemp, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { autoApproves, MODE_ENTRY, nextMode, savedMode } from "../src/modes.ts";

const edit = (file_path: string, toolName = "Edit"): ToolCallUpdate => ({
  toolCallId: "t1",
  rawInput: { file_path },
  _meta: { claudeCode: { toolName } },
});

const modeEntry = (mode: string, id: string): SessionEntry =>
  ({
    type: "custom",
    customType: MODE_ENTRY,
    data: { mode },
    id,
    parentId: null,
    timestamp: "",
  }) as SessionEntry;

describe("modes", () => {
  it("cycles manual → auto-accept edits → plan → auto → manual", () => {
    expect([nextMode("default"), nextMode("acceptEdits"), nextMode("plan"), nextMode("auto")]).toEqual([
      "acceptEdits",
      "plan",
      "auto",
      "default",
    ]);
  });

  it("restores the last recorded mode of a session and starts a new one in Manual", () => {
    expect(savedMode([modeEntry("plan", "a"), modeEntry("acceptEdits", "b")])).toBe("acceptEdits");
    expect(savedMode([])).toBe("default");
    expect(savedMode([modeEntry("bypassPermissions", "a")])).toBe("default");
  });
});

describe("autoApproves", () => {
  it("approves edits of files inside the working directory in auto-accept edits", () => {
    expect(autoApproves("acceptEdits", edit("/work/src/a.ts"), "/work")).toBe(true);
    expect(autoApproves("acceptEdits", edit("src/a.ts", "Write"), "/work")).toBe(true);
  });

  it("asks for files outside the working directory", () => {
    expect(autoApproves("acceptEdits", edit("/etc/hosts"), "/work")).toBe(false);
    expect(autoApproves("acceptEdits", edit("../other/a.ts"), "/work")).toBe(false);
  });

  it("asks for tools that are not file edits, and in every other mode", () => {
    const bash = {
      toolCallId: "t1",
      rawInput: { command: "ls" },
      _meta: { claudeCode: { toolName: "Bash" } },
    };
    expect(autoApproves("acceptEdits", bash, "/work")).toBe(false);
    expect(autoApproves("default", edit("/work/a.ts"), "/work")).toBe(false);
    expect(autoApproves("plan", edit("/work/a.ts"), "/work")).toBe(false);
    expect(autoApproves("auto", edit("/work/a.ts"), "/work")).toBe(false);
  });

  it("follows symlinks: an edit through a link that leaves the working directory asks", async () => {
    const work = await mkdtemp(join(tmpdir(), "claude-acp-work-"));
    const outside = await mkdtemp(join(tmpdir(), "claude-acp-outside-"));
    await symlink(outside, join(work, "docs"));
    await symlink(join(outside, "not-yet"), join(work, "dangling"));
    expect(autoApproves("acceptEdits", edit(join(work, "docs", "authorized_keys"), "Write"), work)).toBe(
      false,
    );
    expect(autoApproves("acceptEdits", edit("dangling", "Write"), work)).toBe(false);
    expect(autoApproves("acceptEdits", edit("src/new.ts", "Write"), work)).toBe(true);
  });

  it("checks every location the edit names", () => {
    const tool = { ...edit("/work/a.ts"), locations: [{ path: "/elsewhere/b.ts" }] };
    expect(autoApproves("acceptEdits", tool, "/work")).toBe(false);
  });

  it("approves the agent's internal tools in every mode", () => {
    const toolSearch = { toolCallId: "t1", _meta: { claudeCode: { toolName: "ToolSearch" } } };
    expect(autoApproves("default", toolSearch, "/work")).toBe(true);
  });

  it("approves only the plan file in plan mode", () => {
    const planFile = edit(join(homedir(), ".claude", "plans", "plan.md"), "Write");
    expect(autoApproves("plan", planFile, "/work")).toBe(true);
    expect(autoApproves("plan", edit("/work/a.ts", "Write"), "/work")).toBe(false);
    expect(autoApproves("default", planFile, "/work")).toBe(false);
  });
});
