import type { PromptRequest, RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  type Api,
  type AssistantMessageEvent,
  type Message,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions.ts";
import { type StreamDeps, streamPrompt, truncateResult } from "../src/stream.ts";
import { FakeConnection } from "./fake-connection.ts";

const MODEL: Model<Api> = {
  id: "opus",
  name: "Opus",
  api: "claude-acp",
  provider: "claude-acp",
  baseUrl: "acp://claude-agent-acp",
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 16384,
};

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function harness(conn = new FakeConnection(), beforeTask = () => {}) {
  const store = new SessionStore({
    mcpServers: async () => [],
    contextBlock: async () => "<pi-context/>",
    onConfig: () => {},
  });
  const windows: [string, number][] = [];
  const logged: string[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const plans: (string[] | undefined)[] = [];
  const elicitations: { message: string; aborted: boolean }[] = [];
  const deps: StreamDeps = {
    connect: async () => conn,
    withTurn: (request, task) =>
      store.withTurn({ ...request, piSessionId: "pi-1", cwd: "/work", branchHas: () => true }, (turn) => {
        beforeTask();
        return task(turn);
      }),
    decide: (request, signal) => {
      permissions.push(request);
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } })),
      );
    },
    elicit: async (request, signal) => {
      elicitations.push({ message: request.message, aborted: signal?.aborted === true });
      return { action: "accept", content: { question_0: "Postgres" } };
    },
    showPlan: (lines) => plans.push(lines),
    onContextWindow: (modelId, size) => windows.push([modelId, size]),
    noteCompaction: (session, update) => store.noteCompaction(session, update),
    log: (line) => logged.push(line),
  };
  const run = async (messages: Message[], options: SimpleStreamOptions = { sessionId: "pi-1" }) => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamPrompt(MODEL, normalizeContext({ messages }), options, deps))
      events.push(event);
    return events;
  };
  return { conn, store, windows, logged, permissions, plans, elicitations, run, deps };
}

/** Makes the fake agent emit `updates` during the prompt, then stop with `stopReason`. */
function script(
  conn: FakeConnection,
  updates: SessionUpdate[],
  response: Awaited<ReturnType<FakeConnection["onPrompt"]>>,
) {
  conn.onPrompt = async (params: PromptRequest, fake) => {
    for (const update of updates) fake.emit(params.sessionId, update);
    return response;
  };
}

const text = (t: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: t },
});
const thought = (t: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: t },
});
const finalText = (events: AssistantMessageEvent[]) => {
  const last = events.at(-1);
  const message = last?.type === "done" ? last.message : last?.type === "error" ? last.error : undefined;
  return (message?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
};

describe("streamPrompt: content", () => {
  it("C17: streams agent message chunks as one text block and ends with done/stop", async () => {
    const h = harness();
    script(h.conn, [text("Hola "), text("mundo")], { stopReason: "end_turn" });
    const events = await h.run([user("hola")]);
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { stopReason: "stop" } });
    expect(finalText(events)).toBe("Hola mundo");
    expect(events.at(-1)?.type === "done" && events.at(-1)).toMatchObject({
      message: { usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } },
    });
  });

  it("C17: streams thought chunks as thinking and closes the block when text starts", async () => {
    const h = harness();
    script(h.conn, [thought("pienso"), text("respuesta")], { stopReason: "end_turn" });
    const events = await h.run([user("hola")]);
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  it("C17: shows tool calls as text lines, never as Pi tool call events", async () => {
    const h = harness();
    script(
      h.conn,
      [
        text("Leo el archivo."),
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read src/index.ts", status: "pending" },
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "export {}" } }],
        },
        { sessionUpdate: "tool_call", toolCallId: "t2", title: "Bash ls" },
        { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", rawOutput: "no such file" },
      ],
      { stopReason: "end_turn" },
    );
    const events = await h.run([user("leé")]);
    expect(events.some((e) => e.type.startsWith("toolcall"))).toBe(false);
    const output = finalText(events);
    expect(output).toContain("Leo el archivo.\n\n▸ Read src/index.ts");
    expect(output).toContain("✓ completed\n\n```\nexport {}\n```");
    expect(output).toContain("▸ Bash ls");
    expect(output).toContain("✗ failed\n\n```\nno such file\n```");
    expect(output).not.toContain("in_progress");
  });

  it("C17: fences a tool result with more backticks than it contains, so its fences cannot close ours", async () => {
    const h = harness();
    const markdown = "# Doc\n```mermaid\nflowchart LR\n```";
    script(
      h.conn,
      [
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read spec.md" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: markdown } }],
        },
        text("Listo."),
      ],
      { stopReason: "end_turn" },
    );
    const output = finalText(await h.run([user("leé")]));
    expect(output).toContain(`\`\`\`\`\n${markdown}\n\`\`\`\``);
    expect(output).toMatch(/````\n\nListo\.$/);
  });

  it("C17: shows the plan in a live widget, not in the transcript, and clears it when everything is done", async () => {
    const h = harness();
    const plan = (status: "pending" | "in_progress" | "completed"): SessionUpdate => ({
      sessionUpdate: "plan",
      entries: [
        { content: "Leer", priority: "high", status: "completed" },
        { content: "Editar", priority: "high", status },
        { content: "Testear", priority: "low", status: status === "completed" ? "completed" : "pending" },
      ],
    });
    script(h.conn, [plan("in_progress"), plan("completed"), text("Listo.")], { stopReason: "end_turn" });
    const output = finalText(await h.run([user("hacé")]));
    expect(h.plans).toEqual([["Plan", "✓ Leer", "› Editar", "· Testear"], undefined]);
    expect(output).toBe("Listo.");
  });

  it("sends Claude Code questions to the elicitation handler with the turn signal", async () => {
    const h = harness();
    let answer: unknown;
    h.conn.onPrompt = async (params, fake) => {
      answer = await fake.elicit({
        mode: "form",
        sessionId: params.sessionId,
        message: "¿Qué base?",
        requestedSchema: { type: "object" },
      });
      return { stopReason: "end_turn" };
    };
    await h.run([user("elegí")]);
    expect(h.elicitations).toEqual([{ message: "¿Qué base?", aborted: false }]);
    expect(answer).toEqual({ action: "accept", content: { question_0: "Postgres" } });
  });

  it("C17: logs ignored and unknown updates without ending the stream", async () => {
    const h = harness();
    script(
      h.conn,
      [
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { sessionUpdate: "future_update" } as unknown as SessionUpdate,
        text("sigue"),
      ],
      { stopReason: "end_turn" },
    );
    const events = await h.run([user("hola")]);
    expect(finalText(events)).toBe("sigue");
    expect(h.logged.join("\n")).toContain("available_commands_update");
    expect(h.logged.join("\n")).toContain("future_update");
  });

  it("C21: drops updates of other sessions and updates after the turn ends", async () => {
    const h = harness();
    let sessionId = "";
    h.conn.onPrompt = async (params, fake) => {
      sessionId = params.sessionId;
      fake.emit("other-session", text("ajeno"));
      fake.emit(params.sessionId, text("propio"));
      return { stopReason: "end_turn" };
    };
    const events = await h.run([user("hola")]);
    h.conn.emit(sessionId, text("tarde"));
    expect(finalText(events)).toBe("propio");
  });
});

describe("streamPrompt: prompt", () => {
  it("sends the context block with the first prompt and only the last user message", async () => {
    const h = harness();
    await h.run([user("viejo"), { ...user("nuevo") }]);
    await h.run([user("viejo"), user("nuevo"), user("otro")]);
    const [first, second] = h.conn.callsOf("prompt");
    expect(first?.prompt).toEqual([
      { type: "text", text: "<pi-context/>" },
      { type: "text", text: "nuevo" },
    ]);
    expect(second?.prompt).toEqual([{ type: "text", text: "otro" }]);
  });

  it("C22: sends images from the user message", async () => {
    const h = harness();
    await h.run([
      {
        role: "user",
        content: [
          { type: "text", text: "mirá" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
    ]);
    expect(h.conn.callsOf("prompt")[0]?.prompt).toContainEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
    });
  });

  it("C22: fails explicitly when the adapter does not announce image support", async () => {
    const h = harness();
    h.conn.supportsImages = false;
    const events = await h.run([
      { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(h.conn.callsOf("prompt")).toEqual([]);
  });

  it("sends the context block again after Claude Code compacts", async () => {
    const h = harness();
    script(h.conn, [{ sessionUpdate: "compaction_update", compactionId: "c", status: "completed" }], {
      stopReason: "end_turn",
    });
    await h.run([user("uno")]);
    await h.run([user("dos")]);
    expect(h.conn.callsOf("prompt")[1]?.prompt).toHaveLength(2);
  });

  it("C10: sends Pi internal calls to a disposable session and closes it", async () => {
    const h = harness();
    await h.run([user("resumí")], { sessionId: "pi-1-compaction" });
    const [created] = h.conn.callsOf("newSession");
    expect(created?._meta).toMatchObject({ claudeCode: { options: { persistSession: false } } });
    expect(h.conn.callsOf("closeSession")).toHaveLength(1);
  });

  it("shows session notices before the output", async () => {
    const h = harness();
    h.conn.resumeFails = true;
    h.store.load("pi-1", [
      {
        type: "custom",
        customType: "claude-acp-session",
        data: { acpSessionId: "gone", leafId: null, piSessionId: "pi-1" },
        id: "e",
        parentId: null,
        timestamp: "",
      },
    ]);
    script(h.conn, [text("hola")], { stopReason: "end_turn" });
    const output = finalText(await h.run([user("hola")]));
    expect(output).toMatch(/^> No se pudo reanudar.*\n\nhola$/s);
  });
});

describe("streamPrompt: end of turn", () => {
  it("C18: maps cancelled to an aborted error", async () => {
    const h = harness();
    script(h.conn, [], { stopReason: "cancelled" });
    expect((await h.run([user("hola")])).at(-1)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it.each(["max_tokens", "max_turn_requests", "refusal"] as const)(
    "C18: maps %s to an error with the reason",
    async (stopReason) => {
      const h = harness();
      script(h.conn, [], { stopReason });
      const last = (await h.run([user("hola")])).at(-1);
      expect(last).toMatchObject({ type: "error", reason: "error" });
      expect(last?.type === "error" && last.error.errorMessage).toContain(stopReason);
    },
  );

  it("C3: explains how to log in when Claude Code requires authentication", async () => {
    const h = harness();
    h.conn.promptError = RequestError.authRequired();
    const last = (await h.run([user("hola")])).at(-1);
    expect(last?.type === "error" && last.error.errorMessage).toContain(
      "ejecutando `claude` en una terminal",
    );
  });

  it("C15: ends with an error and never prompts when the selected model is not offered", async () => {
    const h = harness();
    const model = { ...MODEL, id: "claude-opus-5-5" };
    const events: AssistantMessageEvent[] = [];
    const context = normalizeContext({ messages: [user("hola")] });
    for await (const event of streamPrompt(model, context, { sessionId: "pi-1" }, h.deps)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(h.conn.callsOf("prompt")).toEqual([]);
  });

  it("names the Claude Code version in other errors", async () => {
    const h = harness();
    h.conn.promptError = new Error("model not available");
    const last = (await h.run([user("hola")])).at(-1);
    expect(last?.type === "error" && last.error.errorMessage).toContain("2.1.285");
  });

  it("C19: reads token usage from the prompt response and cost as the delta of the cumulative amount", async () => {
    const h = harness();
    const usage = (amount: number): SessionUpdate => ({
      sessionUpdate: "usage_update",
      used: 5000,
      size: 1_000_000,
      cost: { amount, currency: "USD" },
    });
    script(h.conn, [usage(0.5)], {
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 30, totalTokens: 60, thoughtTokens: 5 },
    });
    const first = (await h.run([user("uno")])).at(-1);
    script(h.conn, [usage(0.8)], { stopReason: "end_turn" });
    const second = (await h.run([user("dos")])).at(-1);
    expect(first?.type === "done" && first.message.usage).toMatchObject({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 0,
      reasoning: 5,
      totalTokens: 60,
      cost: { total: 0.5 },
    });
    expect(second?.type === "done" && second.message.usage.cost.total).toBeCloseTo(0.3);
    expect(h.windows).toEqual([
      ["opus", 1_000_000],
      ["opus", 1_000_000],
    ]);
  });

  it("C20: aborts: cancels the ACP turn, cancels pending permissions and ends aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    let permission: Promise<unknown> = Promise.resolve();
    h.conn.onPrompt = async (params, fake) => {
      permission = fake.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t" },
        options: [],
      });
      const cancelled = fake.untilCancel();
      controller.abort();
      await cancelled;
      return { stopReason: "cancelled" };
    };
    const events = await h.run([user("hola")], { sessionId: "pi-1", signal: controller.signal });
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(h.conn.callsOf("cancel")).toHaveLength(1);
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("ends aborted without prompting when the turn is cancelled while the session opens", async () => {
    const controller = new AbortController();
    const h = harness(new FakeConnection(), () => controller.abort());
    const events = await h.run([user("hola")], { sessionId: "pi-1", signal: controller.signal });
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(h.conn.callsOf("prompt")).toEqual([]);
  });

  it("ends aborted without prompting when the signal is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const events = await h.run([user("hola")], { sessionId: "pi-1", signal: controller.signal });
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(h.conn.callsOf("prompt")).toEqual([]);
  });
});

describe("truncateResult", () => {
  it("keeps short results", () => {
    expect(truncateResult("uno\ndos")).toBe("uno\ndos");
  });

  it("keeps the first 5 lines and counts the rest", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
    expect(truncateResult(lines)).toBe("l1\nl2\nl3\nl4\nl5\n… (+7 líneas)");
  });

  it("marks a cut inside the first lines and counts only the lines after them", () => {
    const lines = ["a".repeat(300), "b".repeat(300), "c", "d", "e", "f"].join("\n");
    expect(truncateResult(lines)).toBe(`${"a".repeat(300)}\n${"b".repeat(99)}…\n… (+1 líneas)`);
  });

  it("cuts a long result at 400 characters", () => {
    const result = truncateResult("x".repeat(1000));
    expect(result).toBe(`${"x".repeat(400)}…`);
  });
});
