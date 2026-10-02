import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { ImageContent, JsonObject, TextContent } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Burst, type BurstDetails, ToolBook, type ToolEntry } from "./burst.ts";
import { Reasoning, type ReasoningDetails } from "./reasoning.ts";

/**
 * What an ACP turn produces, in order. One consumer reads at a time: a segment (a Pi assistant
 * message), then the burst that segment opened, then the next segment (docs/adr/0001).
 */
export type TurnEvent =
  | { kind: "update"; update: acp.SessionUpdate }
  | { kind: "harness"; call: HarnessCall }
  | { kind: "end"; response: acp.PromptResponse; cost: number }
  | { kind: "error"; error: unknown };

/** What a harness tool returns in Pi: its tool result content. */
export interface PiToolResult {
  content: (TextContent | ImageContent)[];
}

/** A harness tool the agent called (docs/adr/0002). It waits until Pi runs it as a tool call of its own. */
export class HarnessCall {
  readonly id = `harness-${randomUUID()}`;
  readonly result: Promise<CallToolResult>;
  #resolve: (result: CallToolResult) => void = () => {};

  constructor(
    readonly name: string,
    readonly args: JsonObject,
  ) {
    this.result = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** The first result wins: a cancel after Pi's own result changes nothing. */
  settle(result: CallToolResult): void {
    this.#resolve(result);
  }
}

/** What the activity tool shows: a burst of tools or a run of reasoning. */
export type ActivityDetails = BurstDetails | ReasoningDetails;

/** A part of the turn that the activity tool shows while it lasts. */
export interface Activity {
  readonly id: string;
  readonly done: Promise<ActivityDetails>;
  subscribe(listener: (details: ActivityDetails) => void): () => void;
  finish(): void;
}

/** A FIFO whose reader waits for the next item. A reader that peeked too far puts the item back. */
export class EventQueue<T> {
  readonly #items: T[] = [];
  readonly #readers: ((item: T) => void)[] = [];

  push(item: T): void {
    const reader = this.#readers.shift();
    if (reader) reader(item);
    else this.#items.push(item);
  }

  putBack(item: T): void {
    this.#items.unshift(item);
  }

  next(): Promise<T> {
    if (this.#items.length > 0) return Promise.resolve(this.#items.shift() as T);
    return new Promise((resolve) => this.#readers.push(resolve));
  }
}

/** One ACP prompt of a Pi session, alive across the Pi assistant messages it spans. */
export class LiveTurn {
  readonly events = new EventQueue<TurnEvent>();
  readonly tools = new ToolBook(() => this.#toolsChanged());
  readonly #controller = new AbortController();
  #cancelPrompt: () => void = () => {};
  #burst: Burst | undefined;
  #reasoning: Reasoning | undefined;
  /** Tools of a burst a harness tool ended while they still ran. The next burst shows them. */
  #carried: string[] = [];
  /** Messages the user wrote while this turn ran (Pi's steering). Each is a list of content blocks. */
  readonly #steers: acp.ContentBlock[][] = [];

  /**
   * @param key Pi session id that continues this turn, or undefined for internal calls.
   * @param segmented Whether tool calls split the turn into bursts. Internal calls never run the activity tool.
   */
  constructor(
    readonly key: string | undefined,
    readonly segmented: boolean,
    readonly modelId: string,
    private readonly onToolsChange: (tools: ToolEntry[]) => void = () => {},
  ) {}

  /** Aborts on cancel: dialogs of this turn close with it. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get burst(): Burst | undefined {
    return this.#burst;
  }

  /** Sets how to cancel the ACP prompt once it exists. */
  onCancel(cancelPrompt: () => void): void {
    this.#cancelPrompt = cancelPrompt;
  }

  cancel(): void {
    if (this.signal.aborted) return;
    this.#controller.abort();
    this.#cancelPrompt();
  }

  /** ACP takes no input while a prompt runs, so these wait for the turn to end. */
  addSteers(messages: acp.ContentBlock[][]): void {
    this.#steers.push(...messages);
  }

  /** Every waiting message, in the order the user wrote them, as one prompt. */
  takeSteers(): acp.ContentBlock[] {
    return this.#steers.splice(0).flat();
  }

  startBurst(firstToolCallId: string): Burst {
    const burst = new Burst(firstToolCallId, this.tools);
    burst.add(firstToolCallId);
    this.#burst = burst;
    return burst;
  }

  /** A burst that goes on with the tools a harness tool call left open. */
  continueBurst(): Burst | undefined {
    const ids = this.#carried.splice(0);
    if (ids.length === 0) return undefined;
    const burst = new Burst(`burst-${randomUUID()}`, this.tools);
    for (const id of ids) burst.add(id);
    this.#burst = burst;
    return burst;
  }

  /** Ends the open burst at a harness tool call: its tools that still run move to the next burst. */
  handOff(): void {
    this.#carried = this.#burst?.releaseOpen() ?? [];
    this.endActivity();
  }

  startReasoning(): Reasoning {
    const reasoning = new Reasoning(`reasoning-${randomUUID()}`);
    this.#reasoning = reasoning;
    return reasoning;
  }

  #toolsChanged(): void {
    this.#burst?.changed();
    this.onToolsChange(this.tools.all());
  }

  /** Ends the open burst or reasoning: the model moved on, or the turn ended. */
  endActivity(): void {
    this.#burst?.finish();
    this.#reasoning?.finish();
    this.#burst = undefined;
    this.#reasoning = undefined;
  }
}

/** The live turns of this Pi runtime, by Pi session, and the activities the activity tool waits on. */
export class TurnRegistry {
  readonly #turns = new Map<string, LiveTurn>();
  readonly #activities = new Map<string, { activity: Activity; turn: LiveTurn }>();
  readonly #harnessCalls = new Map<string, HarnessCall>();

  open(
    key: string | undefined,
    segmented: boolean,
    modelId: string,
    onToolsChange?: (tools: ToolEntry[]) => void,
  ): LiveTurn {
    const turn = new LiveTurn(key, segmented, modelId, onToolsChange);
    if (key !== undefined && segmented) this.#turns.set(key, turn);
    return turn;
  }

  live(key: string | undefined): LiveTurn | undefined {
    return key === undefined ? undefined : this.#turns.get(key);
  }

  close(turn: LiveTurn): void {
    if (turn.key !== undefined && this.#turns.get(turn.key) === turn) this.#turns.delete(turn.key);
  }

  /** Cancels and forgets the live turn of `key`: Pi ended its agent loop without finishing it. */
  discard(key: string): void {
    const turn = this.#turns.get(key);
    turn?.cancel();
    this.#turns.delete(key);
  }

  addActivity(activity: Activity, turn: LiveTurn): void {
    this.#activities.set(activity.id, { activity, turn });
  }

  /** The activity the activity tool call `id` shows, and its turn. Removed once read. */
  takeActivity(id: string): { activity: Activity; turn: LiveTurn } | undefined {
    const entry = this.#activities.get(id);
    this.#activities.delete(id);
    return entry;
  }

  /**
   * Hands a harness tool call of the agent to the live turn of `key`. It resolves with what Pi's run
   * of the tool returns, or with an error when the turn ends first.
   */
  callHarness(key: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const turn = this.live(key);
    if (!turn) return Promise.resolve(harnessError(NO_TURN));
    // MCP arguments arrive as parsed JSON.
    const call = new HarnessCall(name, args as JsonObject);
    this.#harnessCalls.set(call.id, call);
    const stop = onAbort(turn.signal, () => this.#settle(call.id, harnessError(CANCELLED)));
    void call.result.then(stop);
    turn.events.push({ kind: "harness", call });
    return call.result;
  }

  /** Pi finished the tool call `id`. When it runs a harness call, the agent gets the result. */
  settleHarness(id: string, result: PiToolResult, isError: boolean): void {
    this.#settle(id, { content: result.content, isError });
  }

  #settle(id: string, result: CallToolResult): void {
    const call = this.#harnessCalls.get(id);
    this.#harnessCalls.delete(id);
    call?.settle(result);
  }
}

/** Texts for the agent, not the user: they stay in English. */
const NO_TURN = "No turn is running in this Pi session.";
const CANCELLED = "The user cancelled the turn.";

function harnessError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Runs `action` once if `signal` aborts; the returned function stops watching. */
export function onAbort(signal: AbortSignal | undefined, action: () => void): () => void {
  signal?.addEventListener("abort", action, { once: true });
  return () => signal?.removeEventListener("abort", action);
}
