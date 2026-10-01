/** What the model reasoned between two other outputs. Plain JSON: Pi persists it in the session. */
export interface ReasoningEntry {
  text: string;
  startedAt: number;
  /** Unset while the model is still reasoning. */
  endedAt?: number;
}

export interface ReasoningDetails {
  reasoning: ReasoningEntry;
}

/** The view redraws this often while the model reasons: the clock and the blink advance. */
const TICK_MS = 500;

/** One run of reasoning. The activity tool shows it and waits on `done`. */
export class Reasoning {
  readonly #entry: ReasoningEntry;
  readonly #listeners = new Set<(details: ReasoningDetails) => void>();
  readonly done: Promise<ReasoningDetails>;
  #resolve: (details: ReasoningDetails) => void = () => {};
  #ticker: NodeJS.Timeout | undefined;

  constructor(
    readonly id: string,
    startedAt = Date.now(),
  ) {
    this.#entry = { text: "", startedAt };
    this.done = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  add(text: string): void {
    this.#entry.text += text;
    this.#changed();
  }

  details(): ReasoningDetails {
    return { reasoning: { ...this.#entry } };
  }

  subscribe(listener: (details: ReasoningDetails) => void): () => void {
    this.#listeners.add(listener);
    listener(this.details());
    this.#ticker ??= setInterval(() => this.#changed(), TICK_MS);
    return () => this.#listeners.delete(listener);
  }

  finish(endedAt = Date.now()): void {
    clearInterval(this.#ticker);
    this.#entry.endedAt = endedAt;
    this.#listeners.clear();
    this.#resolve(this.details());
  }

  #changed(): void {
    const details = this.details();
    for (const listener of this.#listeners) listener(details);
  }
}
