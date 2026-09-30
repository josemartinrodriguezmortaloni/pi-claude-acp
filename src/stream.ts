import type * as acp from "@agentclientprotocol/sdk";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type TranscriptContext,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { type AcpConnection, errorText, type Log } from "./connection.ts";
import type { AcpSession, OpenTurn, TurnRequest } from "./sessions.ts";

const MAX_RESULT_LINES = 5;
const MAX_RESULT_CHARS = 400;
const AUTH_REQUIRED_CODE = -32000;
const LOGIN_HINT =
  "Claude Code no tiene una sesión iniciada. Iniciá sesión ejecutando `claude` en una terminal.";
const TOOL_MARKS: Record<string, string> = { completed: "✓ completed", failed: "✗ failed" };
const PLAN_LINES: Record<acp.PlanEntryStatus, (content: string) => string> = {
  completed: (content) => `- [x] ${content}`,
  in_progress: (content) => `- [ ] ${content} (en curso)`,
  pending: (content) => `- [ ] ${content}`,
};

type BlockKind = "text" | "thinking";

export interface TurnState {
  readonly message: AssistantMessage;
  open?: { index: number; block: TextContent | ThinkingContent };
  readonly finishedTools: Set<string>;
  plan?: string;
}

export interface StreamDeps {
  connect(): Promise<AcpConnection>;
  withTurn<T>(
    request: Pick<TurnRequest, "conn" | "requestSessionId" | "modelId" | "level" | "blocks">,
    task: (turn: OpenTurn) => Promise<T>,
  ): Promise<T>;
  decide(request: acp.RequestPermissionRequest, signal?: AbortSignal): Promise<acp.RequestPermissionResponse>;
  onContextWindow(modelId: string, size: number): void;
  noteCompaction(session: AcpSession, update: acp.CompactionUpdate): void;
  log: Log;
}

export function createTurnState(model: Model<Api>): TurnState {
  return {
    message: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: toUsage(undefined, 0),
      stopReason: "pending",
      timestamp: Date.now(),
    },
    finishedTools: new Set(),
  };
}

/** Pi's `streamSimple` for claude-acp: one ACP prompt turn as a Pi assistant message. */
export function streamPrompt(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  deps: StreamDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const state = createTurnState(model);
  const push = (events: AssistantMessageEvent[]) => {
    for (const event of events) stream.push(event);
  };
  stream.push({ type: "start", partial: state.message });
  runTurn(state, context, options ?? {}, deps, push).then((last) => {
    stream.push(last);
    stream.end();
  });
  return stream;
}

async function runTurn(
  state: TurnState,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  deps: StreamDeps,
  push: (events: AssistantMessageEvent[]) => void,
): Promise<AssistantMessageEvent> {
  return startTurn(state, context, options, deps, push).catch((error: unknown) =>
    failEvent(state, abortReason(options.signal), errorText(error)),
  );
}

async function startTurn(
  state: TurnState,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  deps: StreamDeps,
  push: (events: AssistantMessageEvent[]) => void,
): Promise<AssistantMessageEvent> {
  if (options.signal?.aborted) return failEvent(state, "aborted", "Turno cancelado.");
  const blocks = lastUserBlocks(context);
  const conn = await deps.connect();
  requireImageSupport(conn, blocks);
  const request = { conn, requestSessionId: options.sessionId, modelId: state.message.model, blocks };
  return deps
    .withTurn({ ...request, level: options.reasoning }, (turn) =>
      promptTurn(state, turn, options.signal, deps, push),
    )
    .catch((error: unknown) =>
      failEvent(state, abortReason(options.signal), describeError(error, conn.claudeVersion)),
    );
}

function abortReason(signal: AbortSignal | undefined): "aborted" | "error" {
  return signal?.aborted ? "aborted" : "error";
}

async function promptTurn(
  state: TurnState,
  turn: OpenTurn,
  signal: AbortSignal | undefined,
  deps: StreamDeps,
  push: (events: AssistantMessageEvent[]) => void,
): Promise<AssistantMessageEvent> {
  if (signal?.aborted) return failEvent(state, "aborted", "Turno cancelado.");
  push(turn.notices.flatMap((notice) => appendParagraph(state, `> ${notice}`)));
  const { session } = turn;
  const costBefore = session.costTotal;
  const unlisten = session.conn.listen(session.id, {
    update: (update) => push(handleUpdate(update, state, session, deps)),
    permission: (request) => deps.decide(request, signal),
  });
  const stopCancelling = onAbort(signal, () => {
    session.conn.agent.cancel({ sessionId: session.id }).catch((error: unknown) => {
      deps.log(`cancel falló: ${errorText(error)}`);
    });
  });
  try {
    const response = await session.conn.agent.prompt({ sessionId: session.id, prompt: turn.prompt });
    push(closeBlock(state));
    state.message.usage = toUsage(response.usage, session.costTotal - costBefore);
    return stopEvent(state, response.stopReason);
  } finally {
    unlisten();
    stopCancelling();
  }
}

/** Runs `action` once if `signal` aborts; the returned function stops watching. */
function onAbort(signal: AbortSignal | undefined, action: () => void): () => void {
  signal?.addEventListener("abort", action, { once: true });
  return () => signal?.removeEventListener("abort", action);
}

type SessionEffect<K extends acp.SessionUpdate["sessionUpdate"]> = (
  update: Extract<acp.SessionUpdate, { sessionUpdate: K }>,
  state: TurnState,
  session: AcpSession,
  deps: StreamDeps,
) => void;

/** Updates that change the session instead of the message. */
const SESSION_EFFECTS: { [K in acp.SessionUpdate["sessionUpdate"]]?: SessionEffect<K> } = {
  usage_update: (update, state, session, deps) => {
    if (update.cost) session.costTotal = update.cost.amount;
    deps.onContextWindow(state.message.model, update.size);
  },
  compaction_update: (update, _state, session, deps) => deps.noteCompaction(session, update),
};

function handleUpdate(
  update: acp.SessionUpdate,
  state: TurnState,
  session: AcpSession,
  deps: StreamDeps,
): AssistantMessageEvent[] {
  const effect = SESSION_EFFECTS[update.sessionUpdate] as
    | SessionEffect<typeof update.sessionUpdate>
    | undefined;
  if (!effect) return mapOrLog(update, state, deps);
  effect(update as never, state, session, deps);
  return [];
}

function mapOrLog(update: acp.SessionUpdate, state: TurnState, deps: StreamDeps): AssistantMessageEvent[] {
  const events = mapUpdate(update, state);
  if (!events) deps.log(`update ignorado: ${update.sessionUpdate}`);
  return events ?? [];
}

type Handler<K extends acp.SessionUpdate["sessionUpdate"]> = (
  update: Extract<acp.SessionUpdate, { sessionUpdate: K }>,
  state: TurnState,
) => AssistantMessageEvent[];

const HANDLERS: { [K in acp.SessionUpdate["sessionUpdate"]]?: Handler<K> } = {
  agent_message_chunk: (update, state) => appendChunk(state, "text", update.content),
  agent_thought_chunk: (update, state) => appendChunk(state, "thinking", update.content),
  tool_call: (update, state) => appendParagraph(state, `▸ ${update.title}`),
  tool_call_update: (update, state) => finishTool(update, state),
  plan: (update, state) => appendPlan(update, state),
};

/** Maps one ACP update to Pi events and updates `state`. Undefined means the update type is ignored. */
export function mapUpdate(update: acp.SessionUpdate, state: TurnState): AssistantMessageEvent[] | undefined {
  const handler = HANDLERS[update.sessionUpdate] as Handler<typeof update.sessionUpdate> | undefined;
  return handler?.(update as never, state);
}

function appendChunk(state: TurnState, kind: BlockKind, content: acp.ContentBlock): AssistantMessageEvent[] {
  return content.type === "text" ? append(state, kind, content.text) : [];
}

function append(state: TurnState, kind: BlockKind, delta: string): AssistantMessageEvent[] {
  const opening = state.open?.block.type === kind ? [] : [...closeBlock(state), openBlock(state, kind)];
  return [...opening, ...growBlock(state, delta)];
}

function openBlock(state: TurnState, kind: BlockKind): AssistantMessageEvent {
  const block =
    kind === "text" ? { type: "text" as const, text: "" } : { type: "thinking" as const, thinking: "" };
  const contentIndex = state.message.content.push(block) - 1;
  state.open = { index: contentIndex, block };
  return { type: `${kind}_start`, contentIndex, partial: state.message };
}

function growBlock(state: TurnState, delta: string): AssistantMessageEvent[] {
  const open = state.open;
  if (!open) return [];
  const event = { contentIndex: open.index, delta, partial: state.message };
  if (open.block.type === "text") {
    open.block.text += delta;
    return [{ type: "text_delta", ...event }];
  }
  open.block.thinking += delta;
  return [{ type: "thinking_delta", ...event }];
}

export function closeBlock(state: TurnState): AssistantMessageEvent[] {
  const open = state.open;
  state.open = undefined;
  return open ? [endEvent(open.index, open.block, state.message)] : [];
}

function endEvent(
  contentIndex: number,
  block: TextContent | ThinkingContent,
  partial: AssistantMessage,
): AssistantMessageEvent {
  return block.type === "text"
    ? { type: "text_end", contentIndex, content: block.text, partial }
    : { type: "thinking_end", contentIndex, content: block.thinking, partial };
}

/** Appends `paragraph` as its own Markdown paragraph of the current text block. */
function appendParagraph(state: TurnState, paragraph: string): AssistantMessageEvent[] {
  const current = state.open?.block.type === "text" ? state.open.block.text : "";
  return append(state, "text", `${separatorAfter(current)}${paragraph}\n\n`);
}

function separatorAfter(text: string): string {
  if (text === "") return "";
  return "\n\n".slice(/\n{0,2}$/.exec(text)?.[0].length);
}

function finishTool(update: acp.ToolCallUpdate, state: TurnState): AssistantMessageEvent[] {
  const mark = TOOL_MARKS[String(update.status)];
  if (!mark || state.finishedTools.has(update.toolCallId)) return [];
  state.finishedTools.add(update.toolCallId);
  return appendParagraph(state, withResult(mark, toolOutput(update)));
}

function toolOutput(update: acp.ToolCallUpdate): string {
  return (update.content ?? []).flatMap(contentText).join("\n") || rawText(update.rawOutput);
}

function contentText(content: acp.ToolCallContent): string[] {
  return content.type === "content" && content.content.type === "text" ? [content.content.text] : [];
}

function rawText(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function withResult(mark: string, output: string): string {
  if (!output) return mark;
  const result = truncateResult(output);
  const fence = fenceFor(result);
  return `${mark}\n\n${fence}\n${result}\n${fence}`;
}

/** CommonMark closes a fence only with at least as many backticks, so ours outgrows every run inside. */
function fenceFor(text: string): string {
  const runs = (text.match(/`+/g) ?? []).map((run) => run.length);
  return "`".repeat(Math.max(3, ...runs.map((length) => length + 1)));
}

/** First lines of a tool result; "…" marks a cut inside them and the count names the lines after them. */
export function truncateResult(text: string): string {
  const lines = text.split("\n");
  const head = lines.slice(0, MAX_RESULT_LINES).join("\n");
  const shown = head.length > MAX_RESULT_CHARS ? `${head.slice(0, MAX_RESULT_CHARS)}…` : head;
  const hidden = lines.length - MAX_RESULT_LINES;
  return hidden > 0 ? `${shown}\n… (+${hidden} líneas)` : shown;
}

function appendPlan(update: acp.Plan, state: TurnState): AssistantMessageEvent[] {
  const checklist = update.entries.map((entry) => PLAN_LINES[entry.status](entry.content)).join("\n");
  if (checklist === state.plan) return [];
  state.plan = checklist;
  return appendParagraph(state, `Plan:\n\n${checklist}`);
}

function stopEvent(state: TurnState, reason: acp.StopReason): AssistantMessageEvent {
  if (reason === "end_turn") return doneEvent(state);
  if (reason === "cancelled") return failEvent(state, "aborted", "Turno cancelado.");
  return failEvent(state, "error", `Claude Code terminó el turno: ${reason}`);
}

function doneEvent(state: TurnState): AssistantMessageEvent {
  state.message.stopReason = "stop";
  return { type: "done", reason: "stop", message: state.message };
}

function failEvent(state: TurnState, reason: "aborted" | "error", message: string): AssistantMessageEvent {
  closeBlock(state);
  state.message.stopReason = reason;
  state.message.errorMessage = message;
  return { type: "error", reason, error: state.message };
}

const count = (value: number | null | undefined) => value ?? 0;

function toUsage(usage: acp.Usage | null | undefined, cost: number): Usage {
  const reported: Partial<acp.Usage> = usage ?? {};
  return {
    input: count(reported.inputTokens),
    output: count(reported.outputTokens),
    cacheRead: count(reported.cachedReadTokens),
    cacheWrite: count(reported.cachedWriteTokens),
    reasoning: count(reported.thoughtTokens),
    totalTokens: count(reported.totalTokens),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Math.max(cost, 0) },
  };
}

/** The last user message as ACP content. Claude Code keeps the rest of the conversation. */
function lastUserBlocks(context: TranscriptContext): acp.ContentBlock[] {
  const message = context.messages.findLast((m): m is UserMessage => m.role === "user");
  if (!message) throw new Error("La conversación no tiene un mensaje de usuario para enviar.");
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType },
  );
}

function requireImageSupport(conn: AcpConnection, blocks: acp.ContentBlock[]): void {
  if (conn.supportsImages || !blocks.some((block) => block.type === "image")) return;
  throw new Error("El adaptador ACP no anuncia soporte de imágenes (promptCapabilities.image).");
}

function describeError(error: unknown, version: string): string {
  if (Object(error).code === AUTH_REQUIRED_CODE) return LOGIN_HINT;
  return version ? `${errorText(error)} (Claude Code ${version})` : errorText(error);
}
