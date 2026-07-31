# Tiered Disclosure Design（层级渐进披露）

**Status:** design proposal
**Updated:** 2026-07-31
**Related:** [edge-activation-design.md](edge-activation-design.md), [fibonacci-progressive-recall.md](fibonacci-progressive-recall.md), docs/design.md §7.1, §11

## 1. Problem

Tiering exists for **latency and focus**: the most likely memories sit shallow,
deeper tiers are cold. Today a single `searchContext` call can pull records
from every tier up to `budget.maxLocalTier` at once. That contradicts the
design goal — deep tiers should be rare, deliberate, and paid for, not
co-retrieved by default. Retrieval must **open tiers in order, one at a time**,
and stop as soon as the opened evidence satisfies the query.

This is not a new budget dimension. It is a **sequential gate** over the tier
axis, composed with the existing record/token/node budgets.

## 2. Design

### 2.1 Principle: tier as a sequential gate, not a pool

```
current behavior:   candidate pool  =  Σ all tiers ≤ maxLocalTier
new behavior:       candidate pool  =  tier 0 only
                    → evaluate     → insufficient? → open tier 1
                    → evaluate     → insufficient? → open tier 2
                    → … (hard stop at maxLocalTier)
```

Key rules:

- **Tier 0 is always searched** (hot memory; cheap, FTS-covered).
- **A deeper tier is opened only if** the current tier's evidence is
  insufficient (budget not exhausted but coverage weak), AND the deeper tier
  is worth its cost.
- **Opening is monotone**: once tier *k* is opened, tiers 0..k stay open for
  the rest of the query. We never close a tier mid-query.
- **Deep tiers have a per-query access counter** that feeds the maintenance
  loop: if a deep tier is never opened in N queries, it is a candidate for
  demotion (already exists as retention candidates); if it is opened often,
  its content is probably too hot to sit deep and should be promoted.

### 2.2 The insufficiency signal (when to open the next tier)

Opening is decided by a conservative, deterministic signal — no LLM call.
The decision is a **sequential probability ratio test (SPRT)** (Wald 1947):
after each tier opens, compute the likelihood ratio

```text
Λ_k = L(data | evidence sufficient with tiers ≤ k)
      / L(data | evidence still insufficient)
```

- `Λ ≥ A` (upper bound) → **stop**: the opened tiers suffice, do not open
  further.
- `Λ ≤ B` (lower bound) → **open the next tier**, then re-test.
- In between → keep testing only if budget remains; otherwise stop
  (conservative default: a shallow miss is cheaper than a deep retrieve).

SPRT is the optimal sequential decision rule: among all tests with the same
type I/type II error bounds, no test has a smaller expected sample size
(verified: Wald 1947; modern treatment in arXiv:2504.19952). The expected
stopping time has the closed form

```text
E[τ] ≈ log(1/α) / KL(Q, P)
```

which quantifies directly how many evidence samples a tier open buys per
unit of discrimination — the "is this tier open worth it" cost question.

**Calibration requirement.** SPRT needs a likelihood ratio, but the existing
QPP components (match strength, score distribution, type coverage) produce
deterministic scores, not probabilities. The scores must be calibrated into
`P(evidence sufficient | opened tiers)` — the claim-level Beta posterior
(design.md §5c) is the existing seed for this. Until calibration exists, run
SPRT in shadow with the deterministic threshold (§2.2 original form) as
fallback.

### 2.3 Budget composition (tier-aware)

`ActiveGraphBudget` (src/core/types.ts:343) gains one field:

```ts
maxTierBudget: number        // new: how many records may come from tiers ≥ 1
```

existing fields unchanged. Composition rule:

```text
tier-0 records  : governed by maxEvidence / maxTokens (unchanged)
tier-1+ records : governed by maxEvidence / maxTokens AND maxTierBudget
```

The per-tier quota from the earlier discussion is replaced by a single
**deep-token budget** with a Fibonacci-style scale per opened tier
(1 record from tier 1, 2 from tier 2, 3 from tier 3 — reusing the Fibonacci
progression already defined in fibonacci-progressive-recall.md).

### 2.4 Interaction with existing mechanisms

| Mechanism | Interaction |
| --- | --- |
| `maxLocalTier` (existing) | becomes the **hard ceiling** of the gate; the gate opens only up to it |
| `maxTier` option (store.ts:1419) | explicit caller override: `maxTier=0` disables deep tiers entirely |
| QPP second pass (Fibonacci) | operates **within** the currently opened tiers; never opens a new tier itself. Tier opening and Fibonacci expansion are orthogonal axes |
| `blockTiers` (hierarchy.ts:28) | unchanged — still produces the tier assignment from access-weighted Huffman depths |
| rebalance tiers (store.ts:1365) | now also driven by "deep tier opened count" signal (§2.1 third bullet) |
| Active Graph ledger | records `deepestTier` (already exists) plus new `tiersOpened: number` |
| retention (L4/L5) | unchanged: deep-tier access counters feed the same candidates |

### 2.5 Progressive model exposure (beyond retrieval)

The gate also applies at the model boundary: **the agent never sees all tiers
at once**. Recall cues carry a `tiersOpened` field; when the agent calls
`nmg_get` for a deeper tier, that is an explicit, budgeted unlock — exactly
the "searched but not all handed over" behaviour. The existing `nmg_search →
nmg_get` progression already provides the plumbing; this design makes the
tier axis explicit in it.

## 3. Implementation sketch

### 3.1 store.ts — sequential tier open

Replace the single `searchContext` pass (store.ts:1409) with a loop:

```ts
function* openTiers(maxTier: MemoryTier): Generator<MemoryTier> {
  for (let t = 0; t <= maxTier; t++) yield t as MemoryTier;
}

// in searchContext:
const opened: MemoryTier[] = [];
for (const tier of openTiers(hardCeiling)) {
  const result = searchTier(query, tier, {...options, maxTier: tier});
  opened.push(tier);
  if (sufficient(result, budget) || exhausted(budget)) break;
}
```

`searchTier` keeps the existing `search`/`searchByVector` paths but constrains
`maxTier` to the current tier, so each level is a fresh, bounded pass over a
smaller index. The insufficiency test (`sufficient`) uses §2.2.

### 3.2 types.ts — budget + ledger

```ts
// ActiveGraphBudget
maxTierBudget: number;

// ActiveGraphBudgetUsage
tiersOpened: number;

// ActiveGraphBudgetDimension
"tiersOpened"
```

### 3.3 controller-runtime.ts — project the new budget

Mirror the existing `projectFibonacci` for `maxTierBudget`; the learned
controller can widen it, never beyond `maximum.maxTierBudget`.

### 3.4 gate.ts — deep-tier admission

A new `tierGate(record.tier, opened, budget)` predicate, called at candidate
admission: tier 0 always passes; tier ≥1 passes only if
`record.tier ∈ opened` and `deepBudgetRemaining > 0`.

### 3.5 nmg_search — expose the gate

`nmg_search(..., maxTier: 0..3)` (already accepted as `maxTier` in
SearchOptions) becomes meaningful: `0` = hot memory only; unset = default
progression. Add `tiersOpened` to the result header so the agent can decide
whether to `nmg_get` deeper.

## 4. Evaluation

Falsifiable claims (consistent with docs/design.md §14 discipline):

1. **Latency**: mean/P95 search latency does not regress; on queries whose
   evidence lives in tier 0, latency **drops** because deeper tiers are not
   scanned. Measured by `eval:scale` at 100K.
2. **Evidence recall**: does not regress for questions whose evidence lives
   deep, because the gate opens tiers before declaring insufficiency. Measured
   by LongMemEval full-set `benchmark:score:longmem`.
3. **Context economy**: average returned-token estimate falls because tier-1+
   records are no longer co-retrieved on shallow queries. Measured by
   `nmg search --json` token estimate + QPP shadow traces.
4. **Tier dynamics**: deep-tier open rate correlates with actual usefulness
   (the access counter feeds rebalance); a tier opened often gets promoted.

Acceptance: gate passes 1–3 with no regression in the matched no-memory
baseline (benchmark discipline §"Always run the matched no-memory baseline").

## 5. Rollout

| Phase | Scope | Evidence gate |
| --- | --- | --- |
| 0 | `maxTierBudget` + ledger fields; gate only in **shadow** (log what would open, change nothing) | shadow traces stable over 100+ queries |
| 1 | Sequential open active for `nmg_search` (CLI) | eval:scale latency + recall no regression |
| 2 | Sequential open active in the Pi automatic-recall path | LongMemEval full-set matched run |
| 3 | `tiersOpened` exposed to the model in recall cues; `nmg_get` becomes the deep unlock | agent eval suite (`eval:agents`) |

## 6. Non-goals

- No new tier count (still 0..3 + L4/L5 retention).
- No per-tier learned quotas (single `maxTierBudget` + Fibonacci scale first).
- No LLM call in the insufficiency signal (deterministic QPP components only).
- Tier assignment logic (`huffmanDepths`/`blockTiers`) unchanged.
