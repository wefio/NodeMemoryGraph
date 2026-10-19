# Lexical tie ranking and neural ranker outcome

[English](lexical-tie-ranking-2026-09-30.md) | [简体中文](lexical-tie-ranking-2026-09-30.zh-CN.md) · [Terms](lexical-tie-ranking-2026-09-30.terms.yaml)

**Evidence boundary (2026-10-17):** the tables and adoption outcome below are
reported historical observations, not rerun benchmark or current acceptance
receipts. The ignored local reports and label provenance were not independently
revalidated. Current source inspection is separated from the frozen comparison.

## Question and protocol

Can a CPU-only, model-free rule improve the order of evidence already selected by
NMG, under the 100 MB additional resident-memory budget? The comparison calls
the product search once per question and scores the same returned candidates
before and after reordering adjacent records with exactly equal `combinedScore`.
The rule uses `Intl.Segmenter` word terms (NFKC, lowercase, at least two Unicode
code points) and IDF-weighted query-term coverage over each statement plus the
first 500 evidence characters. Query-term document frequency is computed over
the selected ranked prefix. Unranked chain and block supplements are untouched.

The pinned samples contain LoCoMo 1,540 questions from 10 users, LongMemEval
100, BEAM 400, PersonaMem 500, and HaluMem 352. The same Active Graph and appended
budgets are used in both arms. Official gold evidence labels are used only by
the retrieval scorer, never for fitting or selecting this rule. The rule was fixed
before the held-out comparison. The paired unit for the exact sign-flip check is
a user, not a question; a p-value from only two users has little resolution.

The earlier [calibration record](relevance-gate-calibration-2026-09-09.md) uses
1,532 scored LoCoMo questions. Its filters/source snapshot and this record's
1,540-question sample are not reconciled here; the counts are not interchangeable.

## Current implementation boundary

Read-only source review on 2026-10-17 found
[`rankLexicalCandidates`](../../../src/core/store/retrieval.ts) conditional on
`retrievalMode === "fts5"` and the internal `preserveOrder === false` argument. The pure
[`rerankEqualScoresByQueryCoverage`](../../../src/core/store/search-ranking.ts)
helper preserves its input candidate set, computes document frequency over that
input array, and stably orders equal-coverage ties. The product supplies the
statement plus `evidence.content.slice(0, 500)`: 500 UTF-16 code units, not
necessarily 500 Unicode code points.

The [approved decision](../../decisions/implemented/2026-09-30-lexical-tie-ranking.md)
owns this pre-budget stage; its separate
[small-budget evidence](lexical-budget-2026-10-10.md) is not the fixed-set trial
reported below. This review does not authorize a new ranking policy.

At least one product call precedes the direct cap/relevance gates. Changing order
before that cap can change final returned membership, even though the helper
preserves its input pool. The fixed post-selection comparison below is therefore
not a universal product selected-set invariant or a semantic candidate generator.
The 100 MB limit is a protocol budget; this record supplies no before/after
resident-memory measurement. Model-free execution and an offline CPU average
do not by themselves verify that cap or an online latency bound.

## Held-out lexical results

| Dataset | R@1 before → after | R@5 before → after | MRR(Q) before → after | Paired MRR direction |
| --- | ---: | ---: | ---: | --- |
| LoCoMo | 7.71% → 17.42% | 14.86% → 29.09% | 0.1830 → 0.3364 | 441 queries improved, 70 worsened; 10/10 users improved; p=0.00195 |
| LongMemEval | 50.59% → 50.00% | 66.47% → 66.47% | 0.8823 → 0.8800 | 3 improved, 4 worsened |
| BEAM | 2.76% → 2.76% | 6.60% → 6.48% | 0.1352 → 0.1338 | 7 improved, 5 worsened |
| PersonaMem | 1.84% → 2.24% | 8.76% → 8.63% | 0.1246 → 0.1326 | 25 improved, 14 worsened; unadjusted p=0.017 |
| HaluMem | 0.00% → 4.23% | 5.04% → 9.27% | 0.0285 → 0.1012 | 38 improved, 2 worsened; only 2 users, p=0.5 |

R@20 is reported unchanged on every sample. Permutation preserves the full input
set, not necessarily an arbitrary top-k cut. A tie group crossing that cut can
change its membership; keeping every reordered group wholly on one side is a
sufficient condition for unchanged cutoff membership. This sample observation is not a guarantee for every product
limit or candidate pool. The offline rerank averaged roughly 0.13–2.0 ms per query across the
five samples and requires no model weights. The pre-integration paired report and
the post-integration five-dataset report are in the ignored local evaluation
workspace at `evals/results/retrieval/program-ranking-probe/`. After integration,
all scoring fields in the product lexical arm match the pre-integration candidate
arm; a cached-embedding LongMemEval control retained its original hybrid metrics.

These are ranking metrics, not an answer-quality or candidate-recovery result.
Absolute lexical recall remains low on BEAM, PersonaMem, and HaluMem. The small
LongMemEval and BEAM regressions are real paired outcomes of this fixed rule.

## Neural ranking outcome

A small MLP trained on multilingual SemRel with 17 lexical-overlap features did
not meet the adoption bar on NMG's reported "independent real-recall" traces: 19 queries,
43 explicitly useful memories, and no verified negative labels. On the same
candidate sets, the existing ranker had Hit@1 16/19 and MRR(Q) 0.921; the MLP
had MRR(Q) 0.861. Restricting the MLP to the highest equal-usefulness group
gave Hit@1 17/19 and MRR(Q) 0.947, but the paired result was not significant
(exact p=1.0). Nineteen query rows do not by themselves establish nineteen independent users
or natural tasks. The available labels cannot establish precision on irrelevant
memories, and exact p=1.0 is not an equivalence or zero-effect proof. Changing a seed is not evidence that the route succeeds.

The neural ranker therefore failed this task's requirement of a demonstrated,
material gain over product ranking. No neural model is included in the lexical
tie-ranking change. This conclusion applies to the tested ranking task and data;
it does not turn untested semantic candidate recovery into a measured result.
