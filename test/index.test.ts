import { normalizeContext } from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AcpConnection, SharedConnection } from "../src/connection.ts";
import { registerClaudeAcp } from "../src/index.ts";
import { FakeConnection } from "./fake-connection.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(authStatus = '{"loggedIn": true}') {
  const providers: ProviderConfig[] = [];
  const handlers = new Map<string, Handler>();
  const entries: { customType: string; data: unknown }[] = [];
  const commands = new Map<string, { description?: string }>();
  const executed: string[] = [];
  const pi = {
    registerProvider: (_name: string, config: ProviderConfig) => providers.push(config),
    registerCommand: (name: string, options: { description?: string }) => commands.set(name, options),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    getCommands: () => [],
    exec: async (command: string, args: string[]) => {
      executed.push(`${command} ${args.join(" ")}`);
      return { stdout: authStatus, stderr: "", code: 0, killed: false };
    },
    events: createEventBus(),
  } as unknown as ExtensionAPI;
  return { pi, providers, handlers, entries, commands, executed };
}

function fakeCtx(notified: string[] = []) {
  return {
    cwd: "/work",
    hasUI: false,
    model: { provider: "claude-acp" },
    ui: { notify: (message: string) => notified.push(message), setWidget: () => {} },
    sessionManager: {
      getSessionId: () => "pi-1",
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "leaf-9",
    },
  };
}

function adapter(conn: AcpConnection | Error): SharedConnection & { closes: number } {
  return {
    closes: 0,
    get: async () => {
      if (conn instanceof Error) throw conn;
      return conn;
    },
    close() {
      this.closes++;
    },
  };
}

async function setup(conn: AcpConnection | Error = new FakeConnection(), authStatus?: string) {
  const fake = fakePi(authStatus);
  const shared = adapter(conn);
  await registerClaudeAcp(fake.pi, { adapter: shared, agentDir: "/nonexistent", log: () => {} });
  return { ...fake, shared };
}

describe("registerClaudeAcp", () => {
  it("C11: registers the provider with the models of a non-persisted bootstrap session and closes it", async () => {
    const conn = new FakeConnection();
    const { providers } = await setup(conn);
    expect(providers.at(-1)?.models?.map((m) => m.id)).toEqual(["opus", "haiku"]);
    expect(conn.callsOf("newSession")[0]?._meta).toMatchObject({
      claudeCode: { options: { persistSession: false } },
    });
    expect(conn.callsOf("closeSession")).toHaveLength(1);
  });

  it("registers an empty catalog when bootstrap fails and notifies on session start", async () => {
    const { providers, handlers } = await setup(new Error("sin claude"));
    expect(providers.at(-1)?.models).toEqual([]);
    const notified: string[] = [];
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, fakeCtx(notified));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notified[0]).toContain("sin claude");
  });

  it("C34: warns on session start when Claude Code has no login", async () => {
    const { handlers, executed } = await setup(new FakeConnection(), '{"loggedIn": false}');
    const notified: string[] = [];
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, fakeCtx(notified));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual(["/opt/claude auth status --json"]);
    expect(notified).toEqual([expect.stringContaining("/claude-login")]);
  });

  it("registers /claude-login", async () => {
    const { commands } = await setup();
    expect(commands.get("claude-login")?.description).toContain("Claude Code");
  });

  it("C6: persists the ACP session after each turn", async () => {
    const conn = new FakeConnection();
    const { providers, handlers, entries } = await setup(conn);
    const ctx = fakeCtx();
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const provider = providers.at(-1);
    const model = { ...provider?.models?.[0], provider: "claude-acp", api: "claude-acp" } as never;
    const messages = [{ role: "user" as const, content: "hola", timestamp: 0 }];
    const stream = provider?.streamSimple?.(model, normalizeContext({ messages }), { sessionId: "pi-1" });
    const last = await stream?.result();
    expect(last?.stopReason).toBe("stop");
    handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
    const [created] = conn.callsOf("newSession").slice(-1);
    expect(created?._meta).toMatchObject({ claudeCode: { options: { settingSources: [] } } });
    expect(entries).toEqual([
      {
        customType: "claude-acp-session",
        data: { acpSessionId: expect.any(String), leafId: "leaf-9", piSessionId: "pi-1" },
      },
    ]);
  });

  it("C29: cancels Pi compaction while a claude-acp model is active", async () => {
    const { handlers } = await setup();
    const compact = handlers.get("session_before_compact");
    expect(compact?.({}, fakeCtx())).toEqual({ cancel: true });
    expect(compact?.({}, { ...fakeCtx(), model: { provider: "anthropic" } })).toBeUndefined();
  });

  it("closes the adapter when Pi quits or reloads, not when it switches sessions", async () => {
    const { handlers, shared } = await setup();
    handlers.get("session_shutdown")?.({ reason: "new" }, fakeCtx());
    expect(shared.closes).toBe(0);
    handlers.get("session_shutdown")?.({ reason: "quit" }, fakeCtx());
    expect(shared.closes).toBe(1);
  });
});
