import { describe, expect, it } from "vitest";
import { addUsage, toUsage } from "../src/usage.ts";

describe("addUsage", () => {
  it("C39: adds the billed tokens of two ACP turns and keeps the context of the later one", () => {
    const first = toUsage(
      { inputTokens: 1, outputTokens: 2, cachedReadTokens: 300, totalTokens: 303 },
      0.1,
      300,
    );
    const second = toUsage(
      { inputTokens: 4, outputTokens: 5, cachedReadTokens: 600, totalTokens: 609 },
      0.2,
      450,
    );
    expect(addUsage(first, second)).toMatchObject({ input: 5, output: 7, cacheRead: 900, totalTokens: 450 });
  });

  it("C39: keeps the earlier context when the later turn reports none", () => {
    const first = toUsage(undefined, 0, 300);
    expect(addUsage(first, toUsage(undefined, 0, 0)).totalTokens).toBe(300);
  });
});
