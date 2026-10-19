# QPP small paired experiment (2026-07-29)

[English](small-scale-experiment-2026-07-29.md) | [简体中文](small-scale-experiment-2026-07-29.zh-CN.md) · [Terms](small-scale-experiment-2026-07-29.terms.yaml)

> **Status:** Historical directional study on ten consecutive LongMemEval-S multi-session cases (original indices 70–79). It is not a full benchmark, its manually checked answer result was not scored by the official judge, and no rerun was performed for this documentation update. The experiment's `NMG_QPP_SECOND_PASS` switch is historical; current caller defaults are documented in the [QPP design](../../design/retrieval-confidence-controller.md).

## Objective

Test whether same-pool re-selection could recover multi-session evidence truncated by the normal `topK`/token budget without a second ANN search.

## Compared setups

Both groups used the same data, BGE embeddings, candidate pool, and `topK=20`:

- Normal: `NMG_QPP_SECOND_PASS=0`
- Adaptive: `NMG_QPP_SECOND_PASS=1`

Adaptive re-selected from the candidate pool produced by the first retrieval under an expanded budget. It did not recompute embeddings or run a second ANN search.

For the answer step, each group made ten calls using the same official LongMemEval answer prompt and `deepseek-chat` (then identified as DeepSeek v4-flash), with the official pipeline's temperature setting. No additional LLM judge was run.

## Retrieval results

| Metric | Normal | Adaptive | Change |
| --- | ---: | ---: | ---: |
| Strict evidence hits | 22 / 32 | 27 / 32 | +5 |
| Evidence recall | 68.75% | 84.38% | +15.63 pp |
| Questions with at least one evidence hit | 9 / 10 | 9 / 10 | 0 |
| Questions with all evidence hit | 5 / 10 | 8 / 10 | +3 |
| Mean context characters | 3,470 | 7,421 | 2.14× |
| Mean search latency | 3,789 ms | 3,782 ms | -7 ms |

Paired outcomes: four questions gained evidence hits; five remained complete; one had no evidence in either group; none regressed in evidence recall.

The latency difference is smaller than the measurement noise expected from this sample and does not support a performance claim. The observed cost was larger reader context, not the local pool re-selection itself.

## Answer results

Manual comparison against the reference answers found approximately 8/10 correct for Normal and 9/10 for Adaptive. The clearest improvement was a bicycle-expense question: Normal lacked the helmet record and answered `$65`; Adaptive recovered that evidence and answered the reference `$185`.

Two counterexamples bound the claim:

1. A project-count question lacked its evidence in both groups and remained wrong; re-selection cannot recover candidates that were never in the pool.
2. A clothing-count answer remained wrong even though Adaptive retrieved one more evidence item; retrieval coverage does not replace reader aggregation or counting.

Because answer accuracy was not evaluated by the official LLM judge, these answers are directional diagnostics, not comparable LongMemEval scores.

## Conclusions

The experiment reported a limited capability: when correct evidence was already in the over-sampled pool but hidden by the normal display budget, re-selection could improve evidence recall with little local computation.

It also showed the cost of unconditional expansion: mean context grew by 2.14×, all ten contexts grew, and one case increased from 2,928 to 16,534 characters. Some additional evidence did not improve the answer. The report therefore recommended improving trigger selectivity before expanding more.

## Engineering review recorded at the time

1. The then-used OmniMemEval bridge did not enable `secondPass`; earlier benchmark results therefore did not exercise this feature. The report added `NMG_QPP_SECOND_PASS=1` as an explicit opt-in, with the default still off at that time.
2. Stage 0 was same-pool re-selection, not a second retrieval.
3. `expandActiveGraphBudget()` increased `maxGraphHops`, but relation expansion had already run before the budget increase and was not rerun; the experiment did not actually gain extra graph hops.
4. Benchmark memories were all stored as `conversation_evidence`, so `intentCoverage` was nearly constant and could not distinguish triggers on those data.
5. “The first selection was truncated” was too common to be a selective trigger and made Adaptive behave like unconditional expansion.

These are findings about the code and experiment at that time; current implementation boundaries and caller defaults are in the [QPP design](../../design/retrieval-confidence-controller.md).

## Historical next experiment proposal

The original note proposed, without adding LLM or embedding calls:

1. Separate `evidence-truncated` from `token-truncated` and measure which kind tracks recall gains.
2. Compare marginal scores, redundancy, and diversity of newly added evidence.
3. Replay expansion multipliers of `1.25×`, `1.5×`, and `2×` rather than using one fixed multiplier.
4. Record trigger decisions as a shadow policy before changing visible context.
5. Run another 10–20 paired model cases only if offline results show selective triggering.

This is a historical proposal, not a current implementation plan.