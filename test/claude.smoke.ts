/**
 * Real smoke test against the installed Claude Code binary. It consumes quota, so it never runs in git hooks.
 * Run with: CLAUDE_CODE_EXECUTABLE=<path to claude> bun run smoke
 */
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { type Api, type Model, normalizeContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { Catalog, toEffort } from "../src/catalog.ts";
import { type AcpConnection, openConnection } from "../src/connection.ts";
import { openProbe, SessionStore } from "../src/sessions.ts";
import { type StreamDeps, streamPrompt } from "../src/stream.ts";
import { TurnRegistry } from "../src/turn.ts";

let conn: AcpConnection | undefined;
const permissions: RequestPermissionRequest[] = [];
let published: ProviderModelConfig[] = [];
const catalog = new Catalog((models) => {
  published = models;
});
const store = new SessionStore({
  mcpServers: async () => [],
  contextBlock: async () => "<pi-context>smoke test</pi-context>",
  onConfig: (configOptions) => catalog.observe(configOptions),
  mode: () => "default",
});

async function connection(): Promise<AcpConnection> {
  conn ??= await openConnection(process.env, () => {});
  return conn;
}

const deps: StreamDeps = {
  connect: connection,
  withTurn: (request, task) =>
    store.withTurn({ ...request, piSessionId: "smoke", cwd: process.cwd(), branchHas: () => true }, task),
  decide: async (request) => {
    permissions.push(request);
    const reject = request.options.find((option) => option.kind === "reject_once");
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  },
  elicit: async () => ({ action: "decline" }),
  notify: () => {},
  onModeChange: () => {},
  // The smoke turn runs in one Pi message: it checks the ACP path, not the activity tool.
  turns: new TurnRegistry(),
  isAgentSession: () => false,
  showPlan: () => {},
  showSubagents: () => {},
  onContextWindow: (modelId, size) => catalog.setContextWindow(modelId, size),
  noteCompaction: (session, update) => store.noteCompaction(session, update),
  log: () => {},
};

function model(id: string): Model<Api> {
  const config = published.find((m) => m.id === id) as Model<Api> | undefined;
  return {
    ...(config as Model<Api>),
    api: "claude-acp",
    provider: "claude-acp",
    baseUrl: "acp://claude-agent-acp",
  };
}

async function ask(modelId: string, text: string, effortLevel: "minimal" | undefined) {
  const messages = [{ role: "user" as const, content: text, timestamp: Date.now() }];
  return streamPrompt(
    model(modelId),
    normalizeContext({ messages }),
    { sessionId: "smoke", reasoning: effortLevel },
    deps,
  ).result();
}

afterAll(() => conn?.close());

describe("smoke: real Claude Code through ACP", () => {
  it("1. opens a real session and lists the models", async () => {
    const error = await catalog.load(async () => openProbe(store, await connection(), process.cwd()), 15_000);
    expect(error).toBeUndefined();
    expect(published.length).toBeGreaterThan(0);
    console.info(`modelos: ${published.map((m) => m.id).join(", ")}`);
  });

  it("2. answers a prompt with the default model and the lowest effort", async () => {
    const message = await ask("default", "Respond with exactly: OK", "minimal");
    const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(message.errorMessage).toBeUndefined();
    expect(message.stopReason).toBe("stop");
    expect(text).toContain("OK");
    console.info(
      `effort enviado: ${toEffort("minimal", ["low", "medium", "high", "xhigh", "max"])}; uso: ${JSON.stringify(message.usage)}`,
    );
  });

  it("3. routes a Read inside the cwd to request_permission and honors the rejection", async () => {
    await ask(
      "default",
      "Use the Read tool to read ./package.json and reply with its name field only.",
      "minimal",
    );
    if (permissions.length === 0) {
      throw new Error(
        'No llegó session/request_permission: el hook PreToolUse "ask" de sessions.ts (§5.3) no se ejecutó con settingSources [].',
      );
    }
    expect(permissions[0]?.options.some((option) => option.kind === "reject_once")).toBe(true);
  });
});
