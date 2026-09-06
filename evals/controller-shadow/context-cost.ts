import { CONTEXT_ACTIONS } from "../../src/lab/context-router.ts";

export interface ContextCostEstimate {
  tokens: number;
  latencyMs: number;
  toolCalls: number;
}
export interface ContextCostPrices {
  perThousandTokens: number;
  perSecond: number;
  perToolCall: number;
}

/** Convert PRE-ACTION fixed estimates into reward units for Q - lambda*K.
 * These estimates are not measured outcomes. Keep outcome rewards unpenalized
 * when fitting Q, otherwise selection subtracts the same cost twice.
 * Prices and estimates never change allowed actions or hard budgets.
 */
export function contextCostPenalties(
  estimates: readonly ContextCostEstimate[],
  prices: ContextCostPrices,
  lambda: number,
): number[] {
  if (estimates.length !== CONTEXT_ACTIONS.length) throw new Error("four cost estimates required");
  assertCost(lambda);
  for (const value of [prices.perThousandTokens, prices.perSecond, prices.perToolCall])
    assertCost(value);
  return estimates.map((estimate) => {
    for (const value of [estimate.tokens, estimate.latencyMs, estimate.toolCalls])
      assertCost(value);
    const cost =
      lambda *
      ((estimate.tokens / 1000) * prices.perThousandTokens +
        (estimate.latencyMs / 1000) * prices.perSecond +
        estimate.toolCalls * prices.perToolCall);
    assertCost(cost);
    return cost;
  });
}

function assertCost(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("costs must be finite and nonnegative");
}
