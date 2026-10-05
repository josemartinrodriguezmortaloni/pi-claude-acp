import { type AssistantMessage, normalizeContext, Type } from "@earendil-works/pi-ai";
import { createEventBus, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { AcpConnection, SharedConnection } from "../src/connection.ts";
import type { HttpMcpServer } from "../src/harness-server.ts";
import { registerClaudeAcp } from "../src/index.ts";
import { copy } from "../src/messages.ts";
import { FakeConnection } from "./fake-connection.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(authStatus = '{"loggedIn": true}') {
  const providers: ProviderConfig[] = [];
  const handlers = new Map<string, Handler>();
  const entries: { customType: string; data: unknown }[] = [];
  const commands = new Map<string, { description?: string }>();
  const executed: string[] = [];
  const tools: { name: string }[] = [];
  const pi = {
    registerProvider: (_name: string, config: ProviderConfig) => providers.push(config),
    registerCommand: (name: string, options: { description?: string }) => commands.set(name, options),
    registerTool: (tool: { name: string }) => tools.push(tool),
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    getCommands: () => [],
    getSettings: () => ({}),
    exec: async (command: string, args: string[]) => {
      executed.push(`${command} ${args.join(" ")}`);
      return { stdout: authStatus, stderr: "", code: 0, killed: false };
    },
    events: createEventBus(),
  } as unknown as ExtensionAPI;
  return { pi, providers, handlers, entries, commands, executed, tools };
}

function fakeCtx(notified: string[] = []) {
  return {
    cwd: "/work",
    hasUI: false,
    model: { provider: "claude-acp" },
    ui: {
      notify: (message: string) => notified.push(message),
      setWidget: () => {},
      setStatus: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
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
    expect(commands.get("claude-login")?.description).toBe(copy.loginCommandDescription);
  });

  it("registers /claude-compact", async () => {
    const { commands } = await setup();
    expect(commands.get("claude-compact")?.description).toBe(copy.compactCommandDescription);
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

  it("runs a Pi tool the agent calls through the harness MCP server and answers with Pi's result", async () => {
    const conn = new FakeConnection();
    const { providers, handlers } = await setup(conn);
    const ctx = fakeCtx();
    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const provider = providers.at(-1);
    const model = { ...provider?.models?.[0], provider: "claude-acp", api: "claude-acp" } as never;
    const offered: string[] = [];
    const answers: unknown[] = [];
    let refused: unknown;
    // The agent connects to the harness server it got in session/new, as Claude Code does: it expands
    // `${VAR}` in the headers from the environment the session options give it.
    conn.onPrompt = async () => {
      const params = conn.callsOf("newSession").at(-1);
      const meta = params?._meta as { claudeCode: { options: { env: Record<string, string> } } };
      const env = meta.claudeCode.options.env;
      const servers = (params?.mcpServers ?? []) as HttpMcpServer[];
      const server = servers.find((entry) => entry.name === "pi");
      if (!server) throw new Error("no harness server");
      const expand = (value: string) =>
        value.replace(/\$\{(\w+)\}/g, (_match, name: string) => env[name] ?? "");
      const headers = Object.fromEntries(server.headers.map((header) => [header.name, expand(header.value)]));
      const client = new Client({ name: "claude-code", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
      );
      offered.push(...(await client.listTools()).tools.map((tool) => tool.name));
      refused = await client.callTool({ name: "read", arguments: { path: "/etc/passwd" } });
      answers.push(await client.callTool({ name: "eval", arguments: { code: "2 + 2" } }));
      await client.close();
      return { stopReason: "end_turn" };
    };
    const tools = ["read", "eval"].map((name) => ({
      name,
      description: name,
      parameters: Type.Object({ code: Type.String() }),
    }));
    const messages = [{ role: "user" as const, content: "sumá", timestamp: 0 }];
    const first = (await provider
      ?.streamSimple?.(model, normalizeContext({ messages, tools }), {
        sessionId: "pi-1",
      })
      ?.result()) as AssistantMessage;
    const call = first.content.find((block) => block.type === "toolCall");
    expect(call).toMatchObject({ name: "eval", arguments: { code: "2 + 2" } });
    const result = { content: [{ type: "text" as const, text: "4" }], details: {} };
    handlers.get("tool_execution_end")?.(
      { type: "tool_execution_end", toolCallId: call?.id, toolName: "eval", result, isError: false },
      ctx,
    );
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: call?.id ?? "",
      toolName: "eval",
      content: result.content,
      isError: false,
      timestamp: 0,
    };
    const second = await provider
      ?.streamSimple?.(model, normalizeContext({ messages: [...messages, first, toolResult], tools }), {
        sessionId: "pi-1",
      })
      ?.result();
    expect(second?.stopReason).toBe("stop");
    expect(offered).toEqual(["eval"]);
    // Pi's own read runs by name: a call to it never reaches Pi.
    expect(refused).toEqual({
      content: [{ type: "text", text: "The tool read is not offered in this Pi session." }],
      isError: true,
    });
    expect(answers).toEqual([{ content: [{ type: "text", text: "4" }], isError: false }]);
    handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });
});
