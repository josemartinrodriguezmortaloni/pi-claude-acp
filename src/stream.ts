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
  type Tool,
  type ToolCall,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { ACTIVITY_TOOL } from "./activity.ts";
import type { ToolEntry } from "./burst.ts";
import { claudeCodeMeta } from "./claude-code-meta.ts";
import { type AcpConnection, errorText, type Log } from "./connection.ts";
import { harnessTools, isHarnessReport } from "./harness.ts";
import { LOGIN_HINT } from "./login.ts";
import { copy } from "./messages.ts";
import type { Reasoning } from "./reasoning.ts";
import type { AcpSession, OpenTurn, TurnRequest } from "./sessions.ts";
import { printable } from "./terminal-text.ts";
import {
  type Activity,
  type HarnessCall,
  type LiveTurn,
  onAbort,
  type TurnEvent,
  type TurnRegistry,
} from "./turn.ts";
import { decideFor } from "./turn-permissions.ts";
import { addUsage, toUsage } from "./usage.ts";

const AUTH_REQUIRED_CODE = -32000;
/** Updates that carry the model's own words. */
const MODEL_TEXT = new Set<acp.SessionUpdate["sessionUpdate"]>([
  "agent_message_chunk",
  "agent_thought_chunk",
]);

type BlockKind = "text" | "thinking";
type Push = (events: AssistantMessageEvent[]) => void;

/** One Pi assistant message: the part of the turn between two bursts. */
export interface SegmentState {
  readonly message: AssistantMessage;
  open?: { index: number; block: TextContent | ThinkingContent };
}

export interface StreamDeps {
  connect(): Promise<AcpConnection>;
  withTurn<T>(
    request: Pick<TurnRequest, "conn" | "requestSessionId" | "modelId" | "level" | "blocks">,
    task: (turn: OpenTurn) => Promise<T>,
  ): Promise<T>;
  decide(request: acp.RequestPermissionRequest, signal?: AbortSignal): Promise<acp.RequestPermissionResponse>;
  elicit(request: acp.CreateElicitationRequest, signal?: AbortSignal): Promise<acp.CreateElicitationResponse>;
  /** Shows a warning about the session (an aviso) outside the transcript. */
  notify(message: string): void;
  /** Shows the agent's plan in a live widget. */
  showPlan(entries: acp.PlanEntry[]): void;
  /** Shows the turn's subagents in a live widget, from every tool of the turn. */
  showSubagents(tools: ToolEntry[]): void;
  onContextWindow(modelId: string, size: number): void;
  noteCompaction(session: AcpSession, update: acp.CompactionUpdate): void;
  /** The agent changed its own mode: it entered plan mode, or a plan approval left it. */
  onModeChange(modeId: string): void;
  /** Sets the harness tools the agent of the Pi session `sessionId` can call. */
  offerTools(sessionId: string, tools: Tool[]): void;
  /** Patterns of the Pi tools the agent does not get, read again on every request. */
  hiddenTools(): string[];
  turns: TurnRegistry;
  /** Whether `sessionId` names the Pi session of the agent loop. Other requests are internal calls. */
  isAgentSession(sessionId: string | undefined): boolean;
  log: Log;
}

interface Segment {
  state: SegmentState;
  /** Changes when the turn ends and the user's waiting messages open the next one. */
  turn: LiveTurn;
  options: SimpleStreamOptions;
  deps: StreamDeps;
  push: Push;
}

export function createSegmentState(model: Model<Api>): SegmentState {
  return {
    message: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: toUsage(undefined, 0, 0),
      stopReason: "pending",
      timestamp: Date.now(),
    },
  };
}

/**
 * Pi's `streamSimple` for claude-acp. The first call of a Pi turn opens the ACP turn; every call
 * after an activity tool result continues it (docs/adr/0001).
 */
export function streamPrompt(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  deps: StreamDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const state = createSegmentState(model);
  const push = (events: AssistantMessageEvent[]) => {
    for (const event of events) stream.push(event);
  };
  stream.push({ type: "start", partial: state.message });
  startSegment(state, context, options ?? {}, deps, push)
    .catch((error: unknown) => failEvent(state, abortReason(options?.signal), errorText(error)))
    .then((last) => {
      stream.push(last);
      stream.end();
    });
  return stream;
}

async function startSegment(
  state: SegmentState,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  deps: StreamDeps,
  push: Push,
): Promise<AssistantMessageEvent> {
  const live = deps.turns.live(options.sessionId);
  if (options.signal?.aborted) return abandon(state, live, deps);
  offerHarnessTools(context, options.sessionId, deps);
  const turn = await turnFor(live, state, context, options, deps);
  return runSegment({ state, turn, options, deps, push }, options.signal);
}

/** Pi's tools can change between calls; the agent sees the current ones. Internal calls get none. */
function offerHarnessTools(
  context: TranscriptContext,
  sessionId: string | undefined,
  deps: StreamDeps,
): void {
  if (sessionId !== undefined && deps.isAgentSession(sessionId))
    deps.offerTools(sessionId, harnessTools(context, deps.hiddenTools()));
}

/**
 * A call that continues a live turn may carry messages the user wrote meanwhile: Pi adds them after
 * the activity tool result (pi-agent-core/dist/agent-loop.js:186). They wait for the turn to end.
 */
async function turnFor(
  live: LiveTurn | undefined,
  state: SegmentState,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  deps: StreamDeps,
): Promise<LiveTurn> {
  if (!live) return openTurn(state, lastUserBlocks(context), options, deps);
  live.addSteers(steersOf(context));
  return live;
}

/** The user messages after the last tool result. */
function steersOf(context: TranscriptContext): acp.ContentBlock[][] {
  const lastResult = context.messages.findLastIndex((message) => message.role === "toolResult");
  return context.messages
    .slice(lastResult + 1)
    .filter((message): message is UserMessage => message.role === "user")
    .map(userBlocks);
}

/** Pi stopped before this call started: the live turn, if any, ends with it. */
function abandon(state: SegmentState, live: LiveTurn | undefined, deps: StreamDeps): AssistantMessageEvent {
  if (live?.key) deps.turns.discard(live.key);
  return failEvent(state, "aborted", copy.turnCancelled);
}

/** Starts the ACP prompt in the background; its events reach the segment through the turn queue. */
async function openTurn(
  state: SegmentState,
  blocks: acp.ContentBlock[],
  options: SimpleStreamOptions,
  deps: StreamDeps,
): Promise<LiveTurn> {
  const conn = await deps.connect();
  requireImageSupport(conn, blocks);
  const modelId = state.message.model;
  const turn = deps.turns.open(options.sessionId, deps.isAgentSession(options.sessionId), modelId, (tools) =>
    deps.showSubagents(tools),
  );
  const request = { conn, requestSessionId: options.sessionId, modelId, level: options.reasoning, blocks };
  deps
    .withTurn(request, (opened) => promptInto(turn, opened, deps))
    .catch((error: unknown) => {
      turn.tools.interruptOpen();
      turn.events.push({ kind: "error", error });
    });
  return turn;
}

async function promptInto(turn: LiveTurn, opened: OpenTurn, deps: StreamDeps): Promise<void> {
  opened.warnings.forEach((warning) => {
    deps.notify(warning);
  });
  if (turn.signal.aborted)
    return turn.events.push({ kind: "end", response: { stopReason: "cancelled" }, cost: 0, context: 0 });
  const { session } = opened;
  const costBefore = session.costTotal;
  turn.onCancel(() => cancelPrompt(session, deps));
  const unlisten = session.conn.listen(session.id, {
    update: (update) => receive(update, turn, session, deps),
    permission: (request) => decideFor(turn, request, deps),
    elicit: (request) => deps.elicit(request, turn.signal),
  });
  try {
    const response = await session.conn.agent.prompt({ sessionId: session.id, prompt: opened.prompt });
    if (response.stopReason === "cancelled") turn.tools.interruptOpen();
    const cost = session.costTotal - costBefore;
    turn.events.push({ kind: "end", response, cost, context: session.contextUsed });
  } finally {
    unlisten();
  }
}

function cancelPrompt(session: AcpSession, deps: StreamDeps): void {
  session.conn.agent.cancel({ sessionId: session.id }).catch((error: unknown) => {
    deps.log(`cancel falló: ${errorText(error)}`);
  });
}

/** Session effects apply at once; tool reports update the book at once and keep their place in the queue. */
function receive(update: acp.SessionUpdate, turn: LiveTurn, session: AcpSession, deps: StreamDeps): void {
  const effect = SESSION_EFFECTS[update.sessionUpdate] as
    | SessionEffect<typeof update.sessionUpdate>
    | undefined;
  if (effect) {
    effect(update as never, turn, session, deps);
    return;
  }
  if (isToolReport(update)) turn.tools.report(update);
  turn.events.push({ kind: "update", update });
}

function isToolReport(
  update: acp.SessionUpdate,
): update is Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }> {
  return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
}

type SessionEffect<K extends acp.SessionUpdate["sessionUpdate"]> = (
  update: Extract<acp.SessionUpdate, { sessionUpdate: K }>,
  turn: LiveTurn,
  session: AcpSession,
  deps: StreamDeps,
) => void;

/** Updates that change the session or the UI around the transcript, never the transcript. */
const SESSION_EFFECTS: { [K in acp.SessionUpdate["sessionUpdate"]]?: SessionEffect<K> } = {
  usage_update: (update, turn, session, deps) => {
    if (update.cost) session.costTotal = update.cost.amount;
    session.contextUsed = update.used;
    deps.onContextWindow(turn.modelId, update.size);
  },
  compaction_update: (update, _turn, session, deps) => deps.noteCompaction(session, update),
  current_mode_update: (update, _turn, _session, deps) => deps.onModeChange(update.currentModeId),
  plan: (update, _turn, _session, deps) => deps.showPlan(update.entries),
};

/** Streams one Pi assistant message until the turn ends or a burst starts. */
async function runSegment(segment: Segment, signal: AbortSignal | undefined): Promise<AssistantMessageEvent> {
  const stopCancelling = onAbort(signal, () => segment.turn.cancel());
  try {
    return await readSegment(segment);
  } finally {
    stopCancelling();
  }
}

async function readSegment(segment: Segment): Promise<AssistantMessageEvent> {
  for (;;) {
    const last = await segmentStep(await segment.turn.events.next(), segment);
    if (last) return last;
  }
}

type StepResult = AssistantMessageEvent | undefined | Promise<AssistantMessageEvent | undefined>;

function segmentStep(event: TurnEvent, segment: Segment): StepResult {
  return STEPS[event.kind](event as never, segment);
}

const STEPS: {
  [K in TurnEvent["kind"]]: (event: Extract<TurnEvent, { kind: K }>, segment: Segment) => StepResult;
} = {
  update: (event, segment) => segmentUpdate(event.update, segment),
  harness: (event, segment) => closeWithHarness(event.call, segment),
  end: (event, segment) => endTurn(event, segment),
  error: (event, segment) => failTurn(event.error, segment),
};

function segmentUpdate(update: acp.SessionUpdate, segment: Segment): AssistantMessageEvent | undefined {
  if (isShownElsewhere(update)) return undefined;
  const open = activityOpener(update, segment.turn);
  if (open) return open(update as never, segment);
  segment.push(mapOrLog(update, segment.state, segment.deps));
  return undefined;
}

/** Subagent output shows in its Task tool; a harness tool, as Pi's own tool call. */
function isShownElsewhere(update: acp.SessionUpdate): boolean {
  return isSubagent(update) || isHarnessReport(update);
}

type Opener<K extends acp.SessionUpdate["sessionUpdate"]> = (
  update: Extract<acp.SessionUpdate, { sessionUpdate: K }>,
  segment: Segment,
) => AssistantMessageEvent;

/** In an agent turn, a tool call opens a burst and a thought opens a run of reasoning. */
const OPENERS: { [K in acp.SessionUpdate["sessionUpdate"]]?: Opener<K> } = {
  tool_call: (update, segment) => openBurst(update.toolCallId, segment),
  agent_thought_chunk: (update, segment) => openReasoning(chunkText(update), segment),
};

function activityOpener(update: acp.SessionUpdate, turn: LiveTurn) {
  return turn.segmented
    ? (OPENERS[update.sessionUpdate] as Opener<typeof update.sessionUpdate> | undefined)
    : undefined;
}

/** The burst collects the tools until the model writes again. */
function openBurst(toolCallId: string, segment: Segment): AssistantMessageEvent {
  const burst = segment.turn.startBurst(toolCallId);
  void fillBurst(segment.turn);
  return closeWithActivity(burst, segment);
}

/** The reasoning collects thoughts until the model does something else. */
function openReasoning(text: string, segment: Segment): AssistantMessageEvent {
  const reasoning = segment.turn.startReasoning();
  reasoning.add(text);
  void fillReasoning(segment.turn, reasoning);
  return closeWithActivity(reasoning, segment);
}

/** Ends this Pi message with the activity tool call that shows `activity`. */
function closeWithActivity(activity: Activity, segment: Segment): AssistantMessageEvent {
  return closeWithToolCalls([activityCall(activity, segment)], segment);
}

/**
 * Ends this Pi message with the harness tool call, so Pi runs the tool (docs/adr/0002). The tools of
 * the burst that still run follow in a new activity: Pi runs the calls in order, and that activity
 * only ends after the agent has the harness result.
 */
function closeWithHarness(call: HarnessCall, segment: Segment): AssistantMessageEvent {
  const toolCalls: ToolCall[] = [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }];
  const burst = segment.turn.continueBurst();
  if (burst) {
    void fillBurst(segment.turn);
    toolCalls.push(activityCall(burst, segment));
  }
  return closeWithToolCalls(toolCalls, segment);
}

function activityCall(activity: Activity, segment: Segment): ToolCall {
  segment.deps.turns.addActivity(activity, segment.turn);
  return { type: "toolCall", id: activity.id, name: ACTIVITY_TOOL, arguments: {} };
}

function closeWithToolCalls(toolCalls: ToolCall[], segment: Segment): AssistantMessageEvent {
  const { state, push } = segment;
  push(closeBlock(state));
  for (const toolCall of toolCalls) {
    const contentIndex = state.message.content.push(toolCall) - 1;
    push([
      { type: "toolcall_start", contentIndex, partial: state.message },
      { type: "toolcall_end", contentIndex, toolCall, partial: state.message },
    ]);
  }
  state.message.stopReason = "toolUse";
  return { type: "done", reason: "toolUse", message: state.message };
}

/** Adds the tools the agent starts to the open burst, until the model writes again or the turn ends. */
async function fillBurst(turn: LiveTurn): Promise<void> {
  for (;;) {
    const event = await turn.events.next();
    if (!continuesBurst(event)) return closeActivity(turn, event);
    burstUpdate(event.update, turn);
  }
}

/** Adds the model's thoughts to the open reasoning, until it does anything else or the turn ends. */
async function fillReasoning(turn: LiveTurn, reasoning: Reasoning): Promise<void> {
  for (;;) {
    const event = await turn.events.next();
    if (!continuesReasoning(event)) return closeActivity(turn, event);
    reasoning.add(chunkText(event.update));
  }
}

/** `event` belongs to what comes next: it goes back to the queue. A harness call hands the burst off. */
function closeActivity(turn: LiveTurn, event: TurnEvent): void {
  turn.events.putBack(event);
  if (event.kind === "harness") turn.handOff();
  else turn.endActivity();
}

function continuesReasoning(event: TurnEvent): event is Extract<TurnEvent, { kind: "update" }> {
  return event.kind === "update" && isMainThought(event.update);
}

function isMainThought(update: acp.SessionUpdate): boolean {
  return update.sessionUpdate === "agent_thought_chunk" && !isSubagent(update);
}

/** Tool reports and subagent output keep a burst open; the model's own words or the turn end close it. */
function continuesBurst(event: TurnEvent): event is Extract<TurnEvent, { kind: "update" }> {
  return event.kind === "update" && !isModelText(event.update);
}

/** Text of the main agent. Whitespace alone does not end a burst. */
function isModelText(update: acp.SessionUpdate): boolean {
  return MODEL_TEXT.has(update.sessionUpdate) && !isSubagent(update) && chunkText(update).trim() !== "";
}

function burstUpdate(update: acp.SessionUpdate, turn: LiveTurn): void {
  const step = BURST_UPDATES[update.sessionUpdate] as BurstStep<typeof update.sessionUpdate> | undefined;
  step?.(update as never, turn);
}

type BurstStep<K extends acp.SessionUpdate["sessionUpdate"]> = (
  update: Extract<acp.SessionUpdate, { sessionUpdate: K }>,
  turn: LiveTurn,
) => void;

/** A burst takes in the tools that start and what subagents write; everything else passes by. */
const BURST_UPDATES: { [K in acp.SessionUpdate["sessionUpdate"]]?: BurstStep<K> } = {
  tool_call: (update, turn) => addTool(update, turn),
  agent_message_chunk: (update, turn) => addSubagentText(update, turn),
};

function addTool(update: acp.SessionUpdate & { toolCallId: string }, turn: LiveTurn): void {
  if (!isHarnessReport(update)) turn.burst?.add(update.toolCallId);
}

function addSubagentText(update: acp.SessionUpdate, turn: LiveTurn): void {
  const parentId = parentToolUseId(update);
  if (parentId) turn.tools.addSubagentText(parentId, chunkText(update));
}

/** claude-agent-acp stamps everything a subagent emits with its Task tool id (acp-agent.js:483-491). */
function parentToolUseId(update: acp.SessionUpdate): string | undefined {
  const id = claudeCodeMeta(update).parentToolUseId;
  return typeof id === "string" ? id : undefined;
}

function isSubagent(update: acp.SessionUpdate): boolean {
  return parentToolUseId(update) !== undefined;
}

function chunkText(update: acp.SessionUpdate): string {
  const content = Object(update).content as acp.ContentBlock | undefined;
  return content?.type === "text" ? content.text : "";
}

/**
 * Ends the Pi message, unless the user wrote during the turn: then those messages open the next ACP
 * turn and this message goes on with its answer.
 */
async function endTurn(
  event: Extract<TurnEvent, { kind: "end" }>,
  segment: Segment,
): Promise<AssistantMessageEvent | undefined> {
  const { state, turn, deps, push } = segment;
  push(closeBlock(state));
  deps.turns.close(turn);
  state.message.usage = addUsage(
    state.message.usage,
    toUsage(event.response.usage, event.cost, event.context),
  );
  const reason = stopReasonOf(event.response.stopReason, turn);
  const steers = reason === "end_turn" ? turn.takeSteers() : [];
  if (steers.length === 0) return stopEvent(state, reason);
  segment.turn = await openTurn(state, steers, segment.options, deps);
  return undefined;
}

/**
 * A turn the user did not cancel can still end "cancelled": the adapter stops it on purpose when the
 * user keeps planning (permissions/effects.js:107-111). That is a normal end.
 */
function stopReasonOf(reason: acp.StopReason, turn: LiveTurn): acp.StopReason {
  return reason === "cancelled" && !turn.signal.aborted ? "end_turn" : reason;
}

function failTurn(error: unknown, segment: Segment): AssistantMessageEvent {
  segment.deps.turns.close(segment.turn);
  return failEvent(segment.state, abortReason(segment.turn.signal), describeError(error));
}

function abortReason(signal: AbortSignal | undefined): "aborted" | "error" {
  return signal?.aborted ? "aborted" : "error";
}

function mapOrLog(update: acp.SessionUpdate, state: SegmentState, deps: StreamDeps): AssistantMessageEvent[] {
  const events = mapUpdate(update, state);
  if (!events) deps.log(`update ignorado: ${update.sessionUpdate}`);
  return events ?? [];
}

type Handler<K extends acp.SessionUpdate["sessionUpdate"]> = (
  update: Extract<acp.SessionUpdate, { sessionUpdate: K }>,
  state: SegmentState,
) => AssistantMessageEvent[];

/** Tool reports already live in the turn's tool book; outside a burst they add nothing to the message. */
const HANDLERS: { [K in acp.SessionUpdate["sessionUpdate"]]?: Handler<K> } = {
  agent_message_chunk: (update, state) => appendChunk(state, "text", update.content),
  agent_thought_chunk: (update, state) => appendChunk(state, "thinking", update.content),
  tool_call: () => [],
  tool_call_update: () => [],
};

/** Maps one ACP update to Pi events and updates `state`. Undefined means the update type is ignored. */
export function mapUpdate(
  update: acp.SessionUpdate,
  state: SegmentState,
): AssistantMessageEvent[] | undefined {
  const handler = HANDLERS[update.sessionUpdate] as Handler<typeof update.sessionUpdate> | undefined;
  return handler?.(update as never, state);
}

function appendChunk(
  state: SegmentState,
  kind: BlockKind,
  content: acp.ContentBlock,
): AssistantMessageEvent[] {
  return content.type === "text" ? append(state, kind, content.text) : [];
}

/** The model can repeat what a tool printed, escape sequences included. */
function append(state: SegmentState, kind: BlockKind, delta: string): AssistantMessageEvent[] {
  const opening = state.open?.block.type === kind ? [] : [...closeBlock(state), openBlock(state, kind)];
  return [...opening, ...growBlock(state, printable(delta))];
}

function openBlock(state: SegmentState, kind: BlockKind): AssistantMessageEvent {
  const block =
    kind === "text" ? { type: "text" as const, text: "" } : { type: "thinking" as const, thinking: "" };
  const contentIndex = state.message.content.push(block) - 1;
  state.open = { index: contentIndex, block };
  return { type: `${kind}_start`, contentIndex, partial: state.message };
}

function growBlock(state: SegmentState, delta: string): AssistantMessageEvent[] {
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

export function closeBlock(state: SegmentState): AssistantMessageEvent[] {
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

function stopEvent(state: SegmentState, reason: acp.StopReason): AssistantMessageEvent {
  if (reason === "end_turn") return doneEvent(state);
  if (reason === "cancelled") return failEvent(state, "aborted", copy.turnCancelled);
  return failEvent(state, "error", copy.turnEnded(reason));
}

function doneEvent(state: SegmentState): AssistantMessageEvent {
  state.message.stopReason = "stop";
  return { type: "done", reason: "stop", message: state.message };
}

/** An error message can quote the adapter's stderr, which tools write to. */
function failEvent(state: SegmentState, reason: "aborted" | "error", message: string): AssistantMessageEvent {
  closeBlock(state);
  state.message.stopReason = reason;
  state.message.errorMessage = printable(message);
  return { type: "error", reason, error: state.message };
}

/** The last user message as ACP content. The agent keeps the rest of the conversation. */
function lastUserBlocks(context: TranscriptContext): acp.ContentBlock[] {
  const message = context.messages.findLast((m): m is UserMessage => m.role === "user");
  if (!message) throw new Error(copy.noUserMessage);
  return userBlocks(message);
}

function userBlocks(message: UserMessage): acp.ContentBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType },
  );
}

function requireImageSupport(conn: AcpConnection, blocks: acp.ContentBlock[]): void {
  if (conn.supportsImages || !blocks.some((block) => block.type === "image")) return;
  throw new Error(copy.noImageSupport);
}

function describeError(error: unknown): string {
  return Object(error).code === AUTH_REQUIRED_CODE ? LOGIN_HINT : errorText(error);
}
