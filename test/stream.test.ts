import type {
  PlanEntry,
  PromptRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  type Api,
  type AssistantMessageEvent,
  type ImageContent,
  type Message,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ACTIVITY_TOOL, activityTool } from "../src/activity.ts";
import type { BurstDetails, ToolEntry } from "../src/burst.ts";
import { copy } from "../src/messages.ts";
import type { ReasoningDetails } from "../src/reasoning.ts";
import { SessionStore } from "../src/sessions.ts";
import { type StreamDeps, streamPrompt } from "../src/stream.ts";
import { TurnRegistry } from "../src/turn.ts";
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
    mode: () => "default",
  });
  const windows: [string, number][] = [];
  const logged: string[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const plans: PlanEntry[][] = [];
  const subagentTools: ToolEntry[][] = [];
  const elicitations: { message: string; aborted: boolean }[] = [];
  const notified: string[] = [];
  const offered: [string, string[]][] = [];
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
    notify: (message) => notified.push(message),
    onModeChange: () => {},
    showPlan: (entries) => plans.push(entries),
    showSubagents: (tools) => subagentTools.push(tools),
    offerTools: (sessionId, tools) => offered.push([sessionId, tools.map((tool) => tool.name)]),
    onContextWindow: (modelId, size) => windows.push([modelId, size]),
    noteCompaction: (session, update) => store.noteCompaction(session, update),
    turns: new TurnRegistry(),
    isAgentSession: (sessionId) => sessionId === "pi-1",
    log: (line) => logged.push(line),
  };
  const run = async (messages: Message[], options: SimpleStreamOptions = { sessionId: "pi-1" }) => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamPrompt(MODEL, normalizeContext({ messages }), options, deps))
      events.push(event);
    return events;
  };
  const loop = (
    messages: Message[],
    options: SimpleStreamOptions = { sessionId: "pi-1" },
    steer: Message[] = [],
    runTool: RunTool = echoTool,
  ) => agentLoop(deps, messages, options, steer, runTool);
  return {
    conn,
    store,
    windows,
    logged,
    permissions,
    plans,
    subagentTools,
    elicitations,
    notified,
    offered,
    run,
    loop,
    deps,
  };
}

interface LoopRun {
  /** The events of each Pi assistant message, in order. */
  segments: AssistantMessageEvent[][];
  /** The details of each activity tool result that shows tools. */
  bursts: BurstDetails[];
  /** The details of each activity tool result that shows reasoning. */
  reasonings: ReasoningDetails[];
  /** Every partial result the activity tool reported for a burst. */
  partials: BurstDetails[];
  /** The model-facing text of each activity tool result. */
  summaries: string[];
  /** Each harness tool call Pi ran, in order. */
  harness: { name: string; arguments: Record<string, unknown> }[];
}

type RunTool = (call: ToolCall) => Promise<{ content: (TextContent | ImageContent)[] }>;

/** Pi's run of a harness tool in these tests: it echoes the call. */
const echoTool: RunTool = async (call) => ({
  content: [{ type: "text", text: `${call.name}: ${JSON.stringify(call.arguments)}` }],
});

/**
 * Pi's agent loop over claude-acp (pi-agent-core/dist/agent-loop.js:130-175): an assistant message
 * that ends with a tool call runs the tool, then the provider is called again with the result.
 */
async function agentLoop(
  deps: StreamDeps,
  messages: Message[],
  options: SimpleStreamOptions,
  steer: Message[],
  runTool: RunTool,
): Promise<LoopRun> {
  const waiting = [...steer];
  const tool = activityTool(deps.turns);
  const context = [...messages];
  const run: LoopRun = { segments: [], bursts: [], reasonings: [], partials: [], summaries: [], harness: [] };
  for (;;) {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamPrompt(MODEL, normalizeContext({ messages: context }), options, deps))
      events.push(event);
    run.segments.push(events);
    const last = events.at(-1);
    if (last?.type !== "done" || last.reason !== "toolUse") return run;
    const calls = last.message.content.filter((block) => block.type === "toolCall");
    if (calls.length === 0) throw new Error("toolUse without a tool call");
    context.push(last.message);
    // Pi runs the calls one by one: the activity tool is sequential (agent-loop.js:368).
    for (const call of calls) {
      const content = call.name === ACTIVITY_TOOL ? await runActivity(call.id) : await runHarnessTool(call);
      context.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content,
        isError: false,
        timestamp: 0,
      });
    }
    // Pi adds what the user wrote meanwhile after the tool results (agent-loop.js:186).
    context.push(...waiting.splice(0));
  }

  async function runActivity(id: string) {
    const result = await tool.execute(
      id,
      {},
      options.signal,
      (partial) => {
        if ("tools" in partial.details) run.partials.push(partial.details);
      },
      {} as never,
    );
    if ("tools" in result.details) run.bursts.push(result.details);
    else run.reasonings.push(result.details);
    run.summaries.push(result.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    return result.content;
  }

  /** Pi runs the real tool, then the extension hears tool_execution_end (src/index.ts). */
  async function runHarnessTool(call: ToolCall) {
    run.harness.push({ name: call.name, arguments: call.arguments });
    const result = await runTool(call);
    deps.turns.settleHarness(call.id, result, false);
    return result.content;
  }
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

/** A tool_call as claude-agent-acp reports it: `_meta.claudeCode.toolName` names the tool (renderer.js:453-465). */
const toolCall = (
  toolCallId: string,
  toolName: string,
  title: string,
  extra: Partial<Extract<SessionUpdate, { sessionUpdate: "tool_call" }>> = {},
): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title,
  ...extra,
  _meta: { claudeCode: { toolName, ...Object(Object(extra._meta).claudeCode) } },
});

const text = (t: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: t },
});
const thought = (t: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: t },
});
/** Resolves once `condition` holds, checking after each pending task. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 0));
}

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

  it("shows the thoughts of an agent turn as a run of reasoning, then the text in the next message", async () => {
    const h = harness();
    script(h.conn, [thought("pienso "), thought("en esto"), text("respuesta")], { stopReason: "end_turn" });
    const run = await h.loop([user("hola")]);
    expect(run.reasonings).toEqual([
      { reasoning: { text: "pienso en esto", startedAt: expect.any(Number), endedAt: expect.any(Number) } },
    ]);
    expect(run.summaries).toEqual(["pienso en esto"]);
    expect(finalText(run.segments[1] ?? [])).toBe("respuesta");
  });

  it("C17: streams the thoughts of an internal call as thinking and closes the block when text starts", async () => {
    const h = harness();
    script(h.conn, [thought("pienso"), text("respuesta")], { stopReason: "end_turn" });
    const events = await h.run([user("hola")], { sessionId: "pi-internal" });
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

  it("C17: ends the message with one activity tool call per burst and continues the same ACP turn after it", async () => {
    const h = harness();
    script(
      h.conn,
      [
        text("Leo el archivo."),
        toolCall("t1", "Read", "Read src/index.ts", { kind: "read", status: "pending" }),
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "export {}" } }],
        },
        toolCall("t2", "Bash", "ls", { kind: "execute" }),
        { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", rawOutput: "no such file" },
        text("Listo."),
      ],
      { stopReason: "end_turn" },
    );
    const run = await h.loop([user("leé")]);
    expect(run.segments).toHaveLength(2);
    expect(finalText(run.segments[0] ?? [])).toBe("Leo el archivo.");
    expect(run.segments[0]?.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(run.bursts[0]?.tools).toMatchObject([
      { id: "t1", target: "src/index.ts", status: "completed", output: "export {}" },
      { id: "t2", target: "ls", status: "failed", output: "no such file" },
    ]);
    expect(finalText(run.segments[1] ?? [])).toBe("Listo.");
    expect(run.segments[1]?.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(h.conn.callsOf("prompt")).toHaveLength(1);
  });

  it("reports each change of the burst while it runs", async () => {
    const h = harness();
    script(
      h.conn,
      [
        toolCall("t1", "Bash", "ls", { kind: "execute", status: "pending" }),
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "a.ts" },
      ],
      { stopReason: "end_turn" },
    );
    const run = await h.loop([user("listá")]);
    expect(run.partials.at(-1)?.tools[0]).toMatchObject({ status: "completed", output: "a.ts" });
    expect(run.summaries).toEqual(["Bash ls: completed"]);
  });

  it("ends with an empty message when the turn ends during a burst", async () => {
    const h = harness();
    script(h.conn, [{ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute" }], {
      stopReason: "end_turn",
    });
    const run = await h.loop([user("listá")]);
    expect(run.segments).toHaveLength(2);
    expect(run.segments[1]?.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: [] } });
  });

  it("keeps a burst open across whitespace the model writes between tools", async () => {
    const h = harness();
    script(
      h.conn,
      [
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read" },
        text("\n\n"),
        { sessionUpdate: "tool_call", toolCallId: "t2", title: "Read b.ts", kind: "read" },
      ],
      { stopReason: "end_turn" },
    );
    const run = await h.loop([user("leé")]);
    expect(run.bursts.map((burst) => burst.tools.map((tool) => tool.id))).toEqual([["t1", "t2"]]);
  });

  it("keeps what a subagent writes out of the message and inside its Task tool", async () => {
    const h = harness();
    const fromSubagent = { claudeCode: { parentToolUseId: "task" } };
    script(
      h.conn,
      [
        { sessionUpdate: "tool_call", toolCallId: "task", title: "buscar tests", kind: "think" },
        { ...text("encontré C12"), _meta: fromSubagent },
        {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read a.ts",
          kind: "read",
          _meta: fromSubagent,
        },
        text("Hecho."),
      ],
      { stopReason: "end_turn" },
    );
    const run = await h.loop([user("buscá")]);
    expect(run.bursts[0]?.tools).toMatchObject([
      { id: "task", subagentText: "encontré C12" },
      { id: "t1", parentId: "task" },
    ]);
    expect(finalText(run.segments[1] ?? [])).toBe("Hecho.");
  });

  it("shows a tool as awaiting while its permission dialog is open and as rejected after a no", async () => {
    const h = harness();
    let answer: (response: RequestPermissionResponse) => void = () => {};
    h.deps.decide = () => new Promise((resolve) => (answer = resolve));
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "rm -rf dist",
        kind: "execute",
      });
      await fake.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t1" },
        options: [{ optionId: "no", name: "No", kind: "reject_once" }],
      });
      fake.emit(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
      return { stopReason: "end_turn" };
    };
    const running = h.loop([user("borrá")]);
    await until(() => h.deps.turns.live("pi-1")?.tools.get("t1").status === "awaiting");
    answer({ outcome: { outcome: "selected", optionId: "no" } });
    const run = await running;
    expect(run.partials.map((details) => details.tools[0]?.status)).toContain("awaiting");
    expect(run.bursts[0]?.tools[0]?.status).toBe("rejected");
  });

  it("names the tool in the permission request from its tool_call report", async () => {
    const h = harness();
    let asked: Promise<unknown> = Promise.resolve();
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, toolCall("t1", "Bash", "ls", { kind: "execute" }));
      asked = fake.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t1", title: "ls" },
        options: [],
      });
      await until(() => h.permissions.length > 0);
      h.deps.turns.live("pi-1")?.cancel();
      return { stopReason: "cancelled" };
    };
    await h.loop([user("listá")]);
    await asked;
    expect(h.permissions[0]?.toolCall._meta).toEqual({ claudeCode: { toolName: "Bash" } });
  });

  it("C20: an abort during a burst cancels the ACP turn and marks the open tools as interrupted", async () => {
    const h = harness();
    const controller = new AbortController();
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "sleep 60",
        kind: "execute",
      });
      const cancelled = fake.untilCancel();
      setTimeout(() => controller.abort(), 0);
      await cancelled;
      return { stopReason: "cancelled" };
    };
    const run = await h.loop([user("esperá")], { sessionId: "pi-1", signal: controller.signal });
    expect(h.conn.callsOf("cancel")).toHaveLength(1);
    expect(run.bursts[0]?.tools[0]?.status).toBe("interrupted");
    expect(run.segments.at(-1)?.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(h.deps.turns.live("pi-1")).toBeUndefined();
  });

  it("tells the extension when the agent changes its own mode", async () => {
    const h = harness();
    const modes: string[] = [];
    h.deps.onModeChange = (modeId) => modes.push(modeId);
    script(h.conn, [{ sessionUpdate: "current_mode_update", currentModeId: "plan" }, text("planifico")], {
      stopReason: "end_turn",
    });
    await h.run([user("planificá")]);
    expect(modes).toEqual(["plan"]);
  });

  it("sends every tool of the turn to the subagent widget as tools change", async () => {
    const h = harness();
    script(h.conn, [toolCall("task", "Task", "buscar tests", { kind: "think" }), text("Hecho.")], {
      stopReason: "end_turn",
    });
    await h.loop([user("buscá")]);
    expect(h.subagentTools.at(-1)).toMatchObject([{ id: "task", name: "Task", target: "buscar tests" }]);
  });

  it("sends what the user wrote during a burst as the next prompt when the turn ends, in the same message", async () => {
    const h = harness();
    let prompts = 0;
    h.conn.onPrompt = async (params, fake) => {
      prompts++;
      if (prompts === 1) {
        fake.emit(params.sessionId, toolCall("t1", "Bash", "npm test", { kind: "execute" }));
        fake.emit(params.sessionId, text("Corrí los tests."));
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      }
      fake.emit(params.sessionId, text("Paso a pnpm."));
      return { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 } };
    };
    const run = await h.loop([user("probá")], { sessionId: "pi-1" }, [user("usá pnpm")]);
    expect(h.conn.callsOf("prompt").map((call) => call.prompt)).toEqual([
      [
        { type: "text", text: "<pi-context/>" },
        { type: "text", text: "probá" },
      ],
      [{ type: "text", text: "usá pnpm" }],
    ]);
    const last = run.segments.at(-1)?.at(-1);
    expect(finalText(run.segments.at(-1) ?? [])).toBe("Corrí los tests.Paso a pnpm.");
    expect(last).toMatchObject({
      type: "done",
      reason: "stop",
      message: { usage: { input: 30, output: 12, totalTokens: 42 } },
    });
  });

  it("drops what the user wrote when they cancel the turn", async () => {
    const h = harness();
    const controller = new AbortController();
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, toolCall("t1", "Bash", "sleep 60", { kind: "execute" }));
      const cancelled = fake.untilCancel();
      setTimeout(() => controller.abort(), 0);
      await cancelled;
      return { stopReason: "cancelled" };
    };
    await h.loop([user("esperá")], { sessionId: "pi-1", signal: controller.signal }, [user("y además…")]);
    expect(h.conn.callsOf("prompt")).toHaveLength(1);
  });

  it("C10: never splits a Pi internal call: its tool calls stay out of the message", async () => {
    const h = harness();
    script(
      h.conn,
      [{ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read" }, text("resumen")],
      { stopReason: "end_turn" },
    );
    const run = await h.loop([user("resumí")], { sessionId: "pi-internal" });
    expect(run.segments).toHaveLength(1);
    expect(finalText(run.segments[0] ?? [])).toBe("resumen");
  });

  it("C17: sends the plan to its live widget, not to the transcript", async () => {
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
    expect(h.plans.map((entries) => entries.map((entry) => entry.status))).toEqual([
      ["completed", "in_progress", "pending"],
      ["completed", "completed", "completed"],
    ]);
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

  it("sends session notices to Pi notifications instead of the transcript", async () => {
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
    expect(output).toBe("hola");
    expect(h.notified).toEqual([copy.resumeFailed]);
  });
});

describe("streamPrompt: end of turn", () => {
  it("C18: ends normally when the agent stops its own turn as cancelled, as it does when the user keeps planning", async () => {
    const h = harness();
    script(h.conn, [text("sigo planificando")], { stopReason: "cancelled" });
    const events = await h.run([user("hola")]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(h.conn.callsOf("cancel")).toEqual([]);
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
    expect(last?.type === "error" && last.error.errorMessage).toContain("/claude-login");
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

  it("reports other errors without naming the agent", async () => {
    const h = harness();
    h.conn.promptError = new Error("model not available");
    const last = (await h.run([user("hola")])).at(-1);
    expect(last?.type === "error" && last.error.errorMessage).toBe("model not available");
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

/** A harness tool as claude-agent-acp reports it: the MCP server name prefixes the tool name. */
const harnessReport = (toolCallId: string, name: string): SessionUpdate =>
  toolCall(toolCallId, `mcp__pi__${name}`, `mcp__pi__${name}`, { kind: "other", status: "pending" });

describe("streamPrompt: harness tools", () => {
  it("runs a harness tool the agent calls as a real Pi tool call and answers the agent with its result", async () => {
    const h = harness();
    const answers: unknown[] = [];
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, text("Calculo."));
      fake.emit(params.sessionId, harnessReport("t1", "eval"));
      answers.push(await h.deps.turns.callHarness("pi-1", "eval", { code: "1 + 1" }));
      fake.emit(params.sessionId, text("Da 2."));
      return { stopReason: "end_turn" };
    };
    const run = await h.loop([user("calculá")]);
    expect(finalText(run.segments[0] ?? [])).toBe("Calculo.");
    expect(run.harness).toEqual([{ name: "eval", arguments: { code: "1 + 1" } }]);
    expect(run.bursts).toEqual([]);
    expect(answers).toEqual([
      { content: [{ type: "text", text: 'eval: {"code":"1 + 1"}' }], isError: false },
    ]);
    expect(finalText(run.segments[1] ?? [])).toBe("Da 2.");
    expect(h.conn.callsOf("prompt")).toHaveLength(1);
  });

  it("ends the burst at a harness tool and shows its open tools after the harness tool, in the same message", async () => {
    const h = harness();
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, toolCall("r1", "Read", "Read a.ts", { kind: "read" }));
      fake.emit(params.sessionId, toolCall("r2", "Read", "Read b.ts", { kind: "read" }));
      fake.emit(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "r1",
        status: "completed",
      });
      fake.emit(params.sessionId, harnessReport("t1", "eval"));
      await h.deps.turns.callHarness("pi-1", "eval", { code: "x" });
      fake.emit(params.sessionId, text("Listo."));
      return { stopReason: "end_turn" };
    };
    // While Pi runs eval, the agent finishes reading b.ts.
    const run = await h.loop([user("leé")], { sessionId: "pi-1" }, [], async (call) => {
      h.conn.emit("acp-1", { sessionUpdate: "tool_call_update", toolCallId: "r2", status: "completed" });
      return echoTool(call);
    });
    const toolCalls = (events: AssistantMessageEvent[]) => {
      const last = events.at(-1);
      return last?.type === "done" ? last.message.content.filter((block) => block.type === "toolCall") : [];
    };
    expect(toolCalls(run.segments[1] ?? []).map((call) => call.name)).toEqual(["eval", ACTIVITY_TOOL]);
    expect(run.bursts.map((burst) => burst.tools.map((tool) => [tool.id, tool.status]))).toEqual([
      [["r1", "completed"]],
      [["r2", "completed"]],
    ]);
    expect(finalText(run.segments[2] ?? [])).toBe("Listo.");
  });

  it("keeps the harness tool's own report out of the bursts", async () => {
    const h = harness();
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, toolCall("r1", "Read", "Read a.ts", { kind: "read" }));
      fake.emit(params.sessionId, harnessReport("t1", "eval"));
      fake.emit(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "r1",
        status: "completed",
      });
      await h.deps.turns.callHarness("pi-1", "eval", { code: "x" });
      return { stopReason: "end_turn" };
    };
    const run = await h.loop([user("leé")]);
    expect(run.bursts.flatMap((burst) => burst.tools.map((tool) => tool.id))).toEqual(["r1"]);
  });

  it("answers the agent with an error when Pi drops the turn while the harness tool waits", async () => {
    const h = harness();
    const answers: unknown[] = [];
    h.conn.onPrompt = async (params, fake) => {
      fake.emit(params.sessionId, harnessReport("t1", "eval"));
      answers.push(await h.deps.turns.callHarness("pi-1", "eval", { code: "while True: pass" }));
      return { stopReason: "cancelled" };
    };
    // Pi's agent_end discards a turn its loop left behind (src/index.ts); this tool never ends.
    void h.loop([user("colgate")], { sessionId: "pi-1" }, [], () => {
      h.deps.turns.discard("pi-1");
      return new Promise(() => {});
    });
    await until(() => answers.length > 0);
    expect(answers).toEqual([
      { content: [{ type: "text", text: "The user cancelled the turn." }], isError: true },
    ]);
  });

  it("answers a harness call with an error when its Pi session has no live turn", async () => {
    const h = harness();
    expect(await h.deps.turns.callHarness("pi-1", "eval", {})).toEqual({
      content: [{ type: "text", text: "No turn is running in this Pi session." }],
      isError: true,
    });
  });

  it("offers the agent every Pi tool except the ones it already has and the activity tool", async () => {
    const h = harness();
    const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}) });
    const tools = [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ACTIVITY_TOOL,
      "eval",
      "codemode",
    ].map(tool);
    for await (const _ of streamPrompt(
      MODEL,
      normalizeContext({ messages: [user("hola")], tools }),
      { sessionId: "pi-1" },
      h.deps,
    ));
    expect(h.offered).toEqual([["pi-1", ["eval", "codemode"]]]);
  });

  it("offers no tools for Pi internal calls", async () => {
    const h = harness();
    await h.run([user("resumí")], { sessionId: "pi-internal" });
    expect(h.offered).toEqual([]);
  });
});
