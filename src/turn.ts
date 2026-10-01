import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { Burst, type BurstDetails, ToolBook, type ToolEntry } from "./burst.ts";
import { Reasoning, type ReasoningDetails } from "./reasoning.ts";

/**
 * What an ACP turn produces, in order. One consumer reads at a time: a segment (a Pi assistant
 * message), then the burst that segment opened, then the next segment (docs/adr/0001).
 */
export type TurnEvent =
  | { kind: "update"; update: acp.SessionUpdate }
  | { kind: "end"; response: acp.PromptResponse; cost: number }
  | { kind: "error"; error: unknown };

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
}

/** Runs `action` once if `signal` aborts; the returned function stops watching. */
export function onAbort(signal: AbortSignal | undefined, action: () => void): () => void {
  signal?.addEventListener("abort", action, { once: true });
  return () => signal?.removeEventListener("abort", action);
}
