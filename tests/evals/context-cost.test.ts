import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextRouter, CONTEXT_ACTIONS } from "../../src/lab/context-router.ts";
import { contextCostPenalties } from "../../evals/controller-shadow/context-cost.ts";

const estimates = [
  { tokens: 0, latencyMs: 0, toolCalls: 0 },
  { tokens: 30, latencyMs: 0, toolCalls: 0 },
  { tokens: 100, latencyMs: 10, toolCalls: 0 },
  { tokens: 900, latencyMs: 1000, toolCalls: 1 },
];
const features = Array(32).fill(0);
const router = new ContextRouter([...Array(128).fill(0), 0, 0, 0.79, 0.8]);

test("research: token penalty changes action when retrieval has small marginal benefit", () => {
  const prices = { perThousandTokens: 1, perSecond: 0, perToolCall: 0 };
  const select = (lambda: number) =>
    router.select(
      features,
      CONTEXT_ACTIONS,
      contextCostPenalties(estimates, prices, lambda),
      0,
      () => 0,
    ).action;
  assert.equal(select(0), "retrieve");
  assert.equal(select(0.1), "resurface");
  assert.equal(select(10), "none");
  assert.deepEqual(
    router.values(features).map((x) => Math.round(x * 100)),
    [0, 0, 79, 80],
  );
});

test("research: latency price changes selection independently of token price", () => {
  const penalties = contextCostPenalties(
    estimates,
    { perThousandTokens: 0, perSecond: 1, perToolCall: 0 },
    1,
  );
  assert.equal(router.select(features, CONTEXT_ACTIONS, penalties, 0, () => 0).action, "resurface");
  assert.equal(router.select(features, ["none"], penalties, 0, () => 0).action, "none");
});

test("research: malformed prices/estimates fail instead of changing permissions", () => {
  const prices = { perThousandTokens: 1, perSecond: 0, perToolCall: 0 };
  assert.throws(() => contextCostPenalties(estimates, prices, -1));
  assert.throws(() => contextCostPenalties([], prices, 1));
  assert.throws(() => contextCostPenalties(estimates, { ...prices, perSecond: NaN }, 1));
  assert.throws(() =>
    contextCostPenalties([{ ...estimates[0]!, tokens: -1 }, ...estimates.slice(1)], prices, 1),
  );
});
