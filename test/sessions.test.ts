import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { copy } from "../src/messages.ts";
import {
  type AcpSession,
  applyConfig,
  branchContains,
  buildContextBlock,
  loadMcpServers,
  openProbe,
  SESSION_ENTRY,
  SessionStore,
  sessionMeta,
  shouldCancelCompaction,
  skillsFromCommands,
} from "../src/sessions.ts";
import { FakeConnection } from "./fake-connection.ts";

const ASK = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
const MCP: McpServer[] = [{ name: "engram", command: "engram", args: ["mcp"], env: [] }];
const anyBranch = () => true;

function store() {
  const observed: unknown[] = [];
  const s = new SessionStore({
    mcpServers: async () => MCP,
    contextBlock: async (cwd) => `contexto de ${cwd}`,
    onConfig: (configOptions) => observed.push(configOptions),
    mode: () => "default",
  });
  return { store: s, observed };
}

function recordEntry(acpSessionId: string, leafId: string | null, piSessionId = "pi-1"): SessionEntry {
  return {
    type: "custom",
    customType: SESSION_ENTRY,
    data: { acpSessionId, leafId, piSessionId },
    id: "e1",
    parentId: null,
    timestamp: new Date().toISOString(),
  } as SessionEntry;
}

function hookCommandOutput(meta: unknown): unknown {
  const options = (meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;
  const settings = options.settings as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const [entry] = settings.hooks.PreToolUse;
  const command = entry?.hooks[0]?.command ?? "";
  return { matcher: entry?.matcher, output: JSON.parse(command.slice(command.indexOf("{"), -1)) };
}

describe("SessionStore.ensure", () => {
  it("C9/C26: creates every session in the Pi cwd with no setting sources and the PreToolUse ask hook", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    await s.ensure(conn, "pi-1", "/work", anyBranch);
    await s.ephemeral(conn, "/work");
    for (const params of conn.callsOf("newSession")) {
      const options = (params._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode
        .options;
      expect(options.settingSources).toEqual([]);
      expect(options.allowDangerouslySkipPermissions).toBe(false);
      expect(hookCommandOutput(params._meta)).toEqual({ matcher: "*", output: ASK });
      expect(params.cwd).toBe("/work");
      expect(params.mcpServers).toEqual(MCP);
    }
    expect(conn.callsOf("newSession")).toHaveLength(2);
  });

  it("C27: switches every created or resumed session to the default mode", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    s.load("pi-2", [recordEntry("acp-old", null, "pi-2")]);
    await s.ensure(conn, "pi-2", "/work", anyBranch);
    expect(conn.callsOf("setSessionMode")).toEqual([
      { sessionId: session.id, modeId: "default" },
      { sessionId: "acp-old", modeId: "default" },
    ]);
  });

  it("reuses the live session of the same Pi session on the same connection", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    const first = await s.ensure(conn, "pi-1", "/work", anyBranch);
    const second = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(second.session).toBe(first.session);
    expect(conn.callsOf("newSession")).toHaveLength(1);
  });

  it("C6: resumes the ACP session saved in the Pi session entries", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    s.load("pi-1", [recordEntry("acp-saved", "leaf-1")]);
    const { session, notices } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(session.id).toBe("acp-saved");
    expect(notices).toEqual([]);
    expect(conn.callsOf("resumeSession")[0]).toMatchObject({
      sessionId: "acp-saved",
      cwd: "/work",
      mcpServers: MCP,
    });
    expect(conn.callsOf("newSession")).toEqual([]);
  });

  it("C7: resumes the session on a new connection after the adapter restarts", async () => {
    const first = new FakeConnection();
    const { store: s } = store();
    const { session } = await s.ensure(first, "pi-1", "/work", anyBranch);
    s.commit("pi-1", "leaf-1");
    first.close();
    const second = new FakeConnection();
    const reopened = await s.ensure(second, "pi-1", "/work", anyBranch);
    expect(reopened.session.id).toBe(session.id);
    expect(reopened.session.conn).toBe(second);
  });

  it("C6: opens a new session and warns that the history is lost when resuming fails", async () => {
    const conn = new FakeConnection();
    conn.resumeFails = true;
    const { store: s } = store();
    s.load("pi-1", [recordEntry("acp-gone", null)]);
    const { session, notices } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(session.id).not.toBe("acp-gone");
    expect(notices).toEqual([copy.resumeFailed]);
  });

  it("C7: opens a new session with a notice for a Pi fork, which copies the parent's record", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    s.load("pi-fork", [recordEntry("acp-parent", null, "pi-parent")]);
    const { session, notices } = await s.ensure(conn, "pi-fork", "/work", anyBranch);
    expect(session.id).not.toBe("acp-parent");
    expect(conn.callsOf("resumeSession")).toEqual([]);
    expect(notices).toEqual([copy.branchDiverged]);
  });

  it("ignores a persisted record without the expected shape", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    s.load("pi-1", [{ ...recordEntry("x", null), data: { acpSessionId: 42 } } as SessionEntry]);
    await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(conn.callsOf("resumeSession")).toEqual([]);
  });

  it("closes the live session it replaces when the branch diverges", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    s.commit("pi-1", "leaf-old");
    await s.ensure(conn, "pi-1", "/work", (leafId) => leafId !== "leaf-old");
    expect(conn.callsOf("closeSession")).toEqual([{ sessionId: session.id }]);
  });

  it("C7: opens a new session with a notice when the saved leaf is no longer on the branch", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    s.load("pi-1", [recordEntry("acp-saved", "leaf-old")]);
    const { session, notices } = await s.ensure(conn, "pi-1", "/work", (leafId) => leafId !== "leaf-old");
    expect(session.id).not.toBe("acp-saved");
    expect(notices).toEqual([copy.branchDiverged]);
    expect(conn.callsOf("resumeSession")).toEqual([]);
  });

  it("C32 hook: reports the config of every created or resumed session to the catalog", async () => {
    const conn = new FakeConnection();
    const { store: s, observed } = store();
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    s.load("pi-2", [recordEntry("acp-old", null, "pi-2")]);
    await s.ensure(conn, "pi-2", "/work", anyBranch);
    expect(observed).toEqual([session.configOptions, expect.any(Array)]);
  });
});

describe("SessionStore.ephemeral", () => {
  it("C10: opens a disposable session that Claude Code does not persist", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    const session = await s.ephemeral(conn, "/work");
    const [params] = conn.callsOf("newSession");
    expect(params?._meta).toMatchObject({ claudeCode: { options: { persistSession: false } } });
    expect(session.needsContext).toBe(false);
  });
});

describe("SessionStore.commit", () => {
  it("returns the record to persist after a turn, and nothing when no turn ran", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    expect(s.commit("pi-1", "leaf-1")).toBeUndefined();
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(s.commit("pi-1", "leaf-1")).toEqual({
      acpSessionId: session.id,
      leafId: "leaf-1",
      piSessionId: "pi-1",
    });
    expect(s.commit("pi-1", "leaf-2")).toBeUndefined();
  });

  it("reads the latest record when a Pi session loads", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    s.load("pi-1", [recordEntry("acp-a", null), recordEntry("acp-b", null)]);
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(session.id).toBe("acp-b");
  });
});

describe("SessionStore.promptBlocks", () => {
  const user = [{ type: "text" as const, text: "hola" }];

  it("C28: sends the context block only with the first prompt of a session", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(await s.promptBlocks(session, user, "/work")).toEqual([
      { type: "text", text: "contexto de /work" },
      ...user,
    ]);
    expect(await s.promptBlocks(session, user, "/work")).toEqual(user);
  });

  it("C28: sends the context block again after a resume and after Claude Code compacts", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    s.load("pi-1", [recordEntry("acp-saved", null)]);
    const { session } = await s.ensure(conn, "pi-1", "/work", anyBranch);
    expect(await s.promptBlocks(session, user, "/work")).toHaveLength(2);
    s.noteCompaction(session, { compactionId: "c1", status: "in_progress" });
    expect(await s.promptBlocks(session, user, "/work")).toHaveLength(1);
    s.noteCompaction(session, { compactionId: "c1", status: "completed" });
    expect(await s.promptBlocks(session, user, "/work")).toHaveLength(2);
  });
});

describe("SessionStore.serialize", () => {
  it("C8: runs the second prompt of a Pi session after the first one finishes", async () => {
    const { store: s } = store();
    const order: string[] = [];
    let release = () => {};
    const first = s.serialize("pi-1", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first:end");
    });
    const second = s.serialize("pi-1", async () => {
      order.push("second");
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("keeps serving the queue after a task fails", async () => {
    const { store: s } = store();
    await expect(s.serialize("pi-1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(s.serialize("pi-1", async () => "ok")).resolves.toBe("ok");
  });
});

describe("applyConfig", () => {
  async function session(conn: FakeConnection): Promise<AcpSession> {
    return (await store().store.ensure(conn, "pi-1", "/work", anyBranch)).session;
  }

  it("C14: sets the model and the mapped effort level on the existing session", async () => {
    const conn = new FakeConnection();
    const s = await session(conn);
    await applyConfig(s, "opus", "xhigh");
    expect(conn.callsOf("setSessionConfigOption")).toEqual([
      { sessionId: s.id, configId: "effort", value: "xhigh" },
    ]);
  });

  it("skips calls when model and effort already match", async () => {
    const conn = new FakeConnection();
    const s = await session(conn);
    await applyConfig(s, "opus", "high");
    await applyConfig(s, "opus", "high");
    expect(conn.callsOf("setSessionConfigOption")).toHaveLength(1);
  });

  it("C12: switches the model and sends no effort to a model without effort", async () => {
    const conn = new FakeConnection();
    const s = await session(conn);
    await applyConfig(s, "haiku", "high");
    expect(conn.callsOf("setSessionConfigOption")).toEqual([
      { sessionId: s.id, configId: "model", value: "haiku" },
    ]);
  });
});

describe("applyConfig failures", () => {
  async function session(conn: FakeConnection): Promise<AcpSession> {
    return (await store().store.ensure(conn, "pi-1", "/work", anyBranch)).session;
  }

  it("C14: fails visibly when the adapter rejects the change", async () => {
    const conn = new FakeConnection();
    const s = await session(conn);
    conn.configError = new Error("invalid value");
    await expect(applyConfig(s, "haiku", undefined)).rejects.toThrow("invalid value");
  });

  it("C14: fails instead of continuing with another model when the adapter keeps the old one", async () => {
    const conn = new FakeConnection();
    const s = await session(conn);
    conn.ignoresModelSwitch = true;
    await expect(applyConfig(s, "haiku", undefined)).rejects.toThrow("haiku");
  });

  it("C15: names the binary and the available models when the model is no longer offered", async () => {
    const conn = new FakeConnection();
    const s = await session(conn);
    const error = (await applyConfig(s, "claude-opus-5-5", undefined).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("claude-opus-5-5");
    expect(error.message).toContain("2.1.285");
    expect(error.message).toContain("/opt/claude");
    expect(error.message).toContain("opus, haiku");
    expect(error.message).not.toContain("Claude Code");
    expect(conn.callsOf("setSessionConfigOption")).toEqual([]);
  });
});

describe("C29: shouldCancelCompaction", () => {
  it("cancels Pi compaction for claude-acp models only", () => {
    expect(shouldCancelCompaction({ provider: "claude-acp" })).toBe(true);
    expect(shouldCancelCompaction({ provider: "anthropic" })).toBe(false);
    expect(shouldCancelCompaction(undefined)).toBe(false);
  });
});

describe("loadMcpServers", () => {
  async function file(content: string): Promise<string> {
    const path = join(await mkdtemp(join(tmpdir(), "claude-acp-")), "mcp.json");
    await writeFile(path, content);
    return path;
  }

  it("maps stdio and http servers from the Pi mcp.json and skips disabled ones", async () => {
    const path = await file(
      JSON.stringify({
        mcpServers: {
          engram: { command: "engram", args: ["mcp"], env: { A: "1" } },
          docs: { url: "https://x.test/mcp", headers: { Authorization: "k" } },
          off: { command: "off", enabled: false },
        },
      }),
    );
    expect(await loadMcpServers(path)).toEqual([
      { name: "engram", command: "engram", args: ["mcp"], env: [{ name: "A", value: "1" }] },
      {
        type: "http",
        name: "docs",
        url: "https://x.test/mcp",
        headers: [{ name: "Authorization", value: "k" }],
      },
    ]);
  });

  it("fails naming a server that has neither command nor url", async () => {
    const path = await file(JSON.stringify({ mcpServers: { broken: { args: [] } } }));
    await expect(loadMcpServers(path)).rejects.toThrow("broken");
  });

  it("returns no servers when the file does not exist", async () => {
    await expect(loadMcpServers("/nonexistent/mcp.json")).resolves.toEqual([]);
  });

  it("fails with the path, never the file content, when the file is not valid JSON", async () => {
    const path = await file('{"headers": {"Authorization": "secret-token"');
    const error = (await loadMcpServers(path).catch((e: unknown) => e)) as Error;
    expect(error?.message).toContain(path);
    expect(error?.message).not.toContain("secret-token");
  });
});

describe("buildContextBlock", () => {
  it("joins the global and project AGENTS.md with the Pi skills list", () => {
    const block = buildContextBlock({
      globalAgents: "reglas globales",
      projectAgents: "reglas del proyecto",
      skills: [{ name: "tdd", description: "Test first", path: "/skills/tdd/SKILL.md" }],
    });
    expect(block).toContain("reglas globales");
    expect(block).toContain("reglas del proyecto");
    expect(block).toContain("tdd: Test first (/skills/tdd/SKILL.md)");
  });

  it("omits the sections that have no content", () => {
    const block = buildContextBlock({ skills: [] });
    expect(block).not.toContain("AGENTS.md");
    expect(block).not.toContain("Skills");
  });
});

describe("openProbe", () => {
  it("opens a non-persisted session with its config options, and closes it", async () => {
    const conn = new FakeConnection();
    const { store: s } = store();
    const probe = await openProbe(s, conn, "/work");
    expect(probe.configOptions.find((o) => o.id === "model")?.currentValue).toBe("opus");
    await probe.close();
    const [created] = conn.callsOf("newSession");
    expect(created?._meta).toMatchObject({ claudeCode: { options: { persistSession: false } } });
    expect(conn.callsOf("closeSession")).toHaveLength(1);
  });
});

describe("skillsFromCommands", () => {
  it("lists the Pi skills with their SKILL.md path", () => {
    const source = { source: "local", scope: "user", origin: "top-level" } as const;
    expect(
      skillsFromCommands([
        {
          name: "skill:tdd",
          description: "Test first",
          source: "skill",
          sourceInfo: { ...source, path: "/s/SKILL.md" },
        },
        { name: "review", source: "prompt", sourceInfo: { ...source, path: "/p.md" } },
      ]),
    ).toEqual([{ name: "tdd", description: "Test first", path: "/s/SKILL.md" }]);
  });
});

describe("branchContains", () => {
  it("accepts a null leaf and leaves on the current branch only", () => {
    const has = branchContains({ getBranch: () => [{ id: "a" }, { id: "b" }] as SessionEntry[] });
    expect(has(null)).toBe(true);
    expect(has("b")).toBe(true);
    expect(has("z")).toBe(false);
  });
});

describe("permission hook", () => {
  const hookCommand = () =>
    sessionMeta(true).claudeCode.options.settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
  const runHook = (input: object) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile("sh", ["-c", hookCommand()], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
      child.stdin?.end(JSON.stringify(input));
    });

  it("sends every tool call to the permission request outside auto mode", async () => {
    for (const permission_mode of ["default", "acceptEdits", "plan"]) {
      const out = JSON.parse(
        await runHook({ hook_event_name: "PreToolUse", permission_mode, tool_name: "Bash" }),
      );
      expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    }
  });

  it("lets Claude Code's classifier decide in auto mode", async () => {
    await expect(
      runHook({ hook_event_name: "PreToolUse", permission_mode: "auto", tool_name: "Bash" }),
    ).resolves.toBe("");
  });
});
