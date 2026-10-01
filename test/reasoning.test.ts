import { afterEach, describe, expect, it, vi } from "vitest";
import { Reasoning, type ReasoningDetails } from "../src/reasoning.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("Reasoning", () => {
  it("collects the thoughts and resolves done with when it ended", async () => {
    const reasoning = new Reasoning("r1", 1_000);
    reasoning.add("uno ");
    reasoning.add("dos");
    reasoning.finish(4_000);
    await expect(reasoning.done).resolves.toEqual({
      reasoning: { text: "uno dos", startedAt: 1_000, endedAt: 4_000 },
    });
  });

  it("redraws a subscriber every half second while the model reasons, and stops when it ends", () => {
    vi.useFakeTimers();
    const reasoning = new Reasoning("r1", 0);
    const seen: ReasoningDetails[] = [];
    reasoning.subscribe((details) => seen.push(details));
    vi.advanceTimersByTime(1_000);
    expect(seen).toHaveLength(3);
    reasoning.finish(1_000);
    vi.advanceTimersByTime(1_000);
    expect(seen).toHaveLength(3);
  });
});
