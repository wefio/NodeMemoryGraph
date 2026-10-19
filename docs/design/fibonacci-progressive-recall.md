# Fibonacci Progressive Recall

[简体中文](fibonacci-progressive-recall.zh-CN.md) · [Terms used](fibonacci-progressive-recall.terms.yaml)

> **Status: experimental.** Core `searchContext` performs progressive re-selection only when the caller passes `secondPass: true`; that option defaults off. `searchContextWithSecondPass()` defaults it on. Pi automatic recall enables it only when `NMG_QPP2_MODE=active` (the mode defaults to `off`); the OmniMemEval runner defaults it on unless `NMG_QPP_SECOND_PASS=0`. This document describes a retrieval mechanism, not a quality or cost guarantee.

## Definition

NMG interprets the Fibonacci sequence as **cumulative visible evidence counts**, not the number added at each round:

```text
1 → 2 → 3 → 5 → 8 → 13 → …
```

The repeated second `1` is omitted because it would perform no new read. `fibonacciEvidenceBudgets(maxEvidence)` appends its supplied evidence ceiling as the final tier; for example:

```text
maxEvidence = 10:
1 → 2 → 3 → 5 → 8 → 10
```

That ceiling is distinct from the caller's `limit`. The current implementation treats `limit` as a hard upper bound, but does not synthesize a tier for a `limit` between Fibonacci tiers. For example, if the expansion envelope is greater than 10 and the caller sets `limit=10`, the loop stops before tier 13; it does not add a tier of 10.

Progressive stages reselect from the same over-sampled candidate pool. They do not recompute the query embedding or call ANN, FTS, or an LLM again. The first stage is the first generated tier at or above the caller's `initialEvidenceTarget`; its default is 13, and a strong Top-1/Top-2 score gap may lower it to at most the default target of 3. It does not always start at Top-1.

## Per-tier decision

QPP is recomputed at each tier:

\[
C_t = QPP(R_{1:K_t})
\]

The current default QPP score is `Top1 + 0.5 × NQC`. `intentCoverage` and `reasonHealth` may still be recorded for shadow audits, but they do not contribute to the current score. If QPP judges the evidence sufficient, expansion stops; otherwise the loop tries the next tier. It also stops when the candidate pool, caller `limit`, or expanded budget envelope is exhausted.

`QppTriggerDecision.expansion` records this trace:

```text
strategy
stages[]
  targetEvidence
  selectedEvidence
  estimatedTokens
  qpp
  trigger
  reason
stoppedBecause: budget_exhausted | candidate_pool_exhausted | sufficient
```

The expansion record is returned on the Active Graph's `qpp` decision. A stage stores counts and scores, not the memory IDs newly selected at that tier. Answer-end `usefulMemoryIds` can support coarse calibration against the final selected result; it does not by itself prove which tier's additions were useful.

## Why progressive recall remains experimental

QPP estimates retrieval sufficiency for the current evidence; it does not prove that the evidence chain is complete for counting, comparison, or multi-hop questions. Progressive recall can therefore have either outcome:

- A simple query may stop at its first enabled tier, reducing exposed context.
- A multi-hop query may stop too early and omit later evidence in the candidate pool.

Observing only expansions that actually ran cannot reveal every false early stop. Some controlled exploration is still needed—for example, letting a subset of queries judged sufficient at their first tier continue through deeper tiers in shadow mode, then assessing the extra material with task-matched benchmark labels, user confirmation, or tool verification. Answer-text overlap is diagnostic only; it is not a substitute for those labels.

## Difference from the earlier Stage 0 sketch

Earlier sketch:

```text
normal Top-K → QPP trigger or truncate → expand directly to about 2K
```

Current implementation:

```text
initialEvidenceTarget → QPP → next Fibonacci tier → QPP → …
```

The current mechanism progressively selects evidence within a fixed candidate pool and budget envelope; it does not improve candidate generation. Misses outside that pool still require a genuine second search or graph-routing expansion.

## Current boundaries

- `secondPass=false`: use the fixed selection budget and retain the QPP observation, but do not run Fibonacci expansion.
- `secondPass=true`: enable progressive re-selection.
- Core `searchContext` defaults `secondPass` off; `searchContextWithSecondPass()` defaults it on. Pi automatic recall is controlled by `NMG_QPP2_MODE`, which defaults to `off`. The OmniMemEval runner defaults to enabled and can be disabled with `NMG_QPP_SECOND_PASS=0`. These are defaults at different caller boundaries.
- The first stage uses `initialEvidenceTarget` (core default 13). A relative Top-1/Top-2 gap at or above the default `0.05` may lower it to `strongHitInitialTarget` (default 3), subject to the caller's requested target. Callers can override these parameters; the core consumes the supplied target, which alone does not establish that a learned controller chose it.
- `limit` is a maximum return count, not a fill target. Expansion is also bounded by the hard envelope from `expandActiveGraphBudget()`. The current sequence is generated from that envelope and the caller's `limit` only stops tiers above it; if the limit falls between tiers, the final tier may be smaller than the limit.
- Only evidence selection expands progressively. Relation expansion uses the original `graphHops` budget and does not increase with the Fibonacci stages.
- A `forget` marker is surfaced by output projection as a withdrawal indication and corresponding prompt hint. This is an output-projection rule, not a reason to enlarge the retrieval window.
- Implementation locations: `src/core/store/retrieval.ts`, `src/core/qpp.ts`, `src/core/store/active-graph.ts`, and `src/core/types.ts`; Pi mode configuration is in `src/integration/config.ts` and `.pi/extensions/nmg/index.ts`, while the OmniMemEval default is in `evals/omnimemeval/bridge.ts`.
