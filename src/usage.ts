import type * as acp from "@agentclientprotocol/sdk";
import type { Usage } from "@earendil-works/pi-ai";

/** The usage of a message that spans several ACP turns. */
export function addUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: { ...first.cost, total: first.cost.total + second.cost.total },
  };
}

const count = (value: number | null | undefined) => value ?? 0;

export function toUsage(usage: acp.Usage | null | undefined, cost: number): Usage {
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
