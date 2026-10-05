import type * as acp from "@agentclientprotocol/sdk";
import type { Usage } from "@earendil-works/pi-ai";

/**
 * The usage of a message that spans several ACP turns. The billed tokens add up; the context is the
 * later turn's, or the earlier one's when the later turn reports none.
 */
export function addUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0),
    totalTokens: laterContext(first, second),
    cost: { ...first.cost, total: first.cost.total + second.cost.total },
  };
}

const laterContext = (first: Usage, second: Usage) => second.totalTokens || first.totalTokens;

const count = (value: number | null | undefined) => value ?? 0;

/**
 * `usage` sums every model request of the turn, so it counts billed tokens. Pi reads `totalTokens`
 * as the context size, so it carries `context`: the `usage_update.used` of the turn's last request.
 */
export function toUsage(usage: acp.Usage | null | undefined, cost: number, context: number): Usage {
  const reported: Partial<acp.Usage> = usage ?? {};
  return {
    input: count(reported.inputTokens),
    output: count(reported.outputTokens),
    cacheRead: count(reported.cachedReadTokens),
    cacheWrite: count(reported.cachedWriteTokens),
    reasoning: count(reported.thoughtTokens),
    totalTokens: context,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Math.max(cost, 0) },
  };
}
