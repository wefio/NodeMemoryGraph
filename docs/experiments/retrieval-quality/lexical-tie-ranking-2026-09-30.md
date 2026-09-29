# Lexical tie ranking and neural ranker outcome

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

## Held-out lexical results

| Dataset | R@1 before → after | R@5 before → after | MRR(Q) before → after | Paired MRR direction |
| --- | ---: | ---: | ---: | --- |
| LoCoMo | 7.71% → 17.42% | 14.86% → 29.09% | 0.1830 → 0.3364 | 441 queries improved, 70 worsened; 10/10 users improved; p=0.00195 |
| LongMemEval | 50.59% → 50.00% | 66.47% → 66.47% | 0.8823 → 0.8800 | 3 improved, 4 worsened |
| BEAM | 2.76% → 2.76% | 6.60% → 6.48% | 0.1352 → 0.1338 | 7 improved, 5 worsened |
| PersonaMem | 1.84% → 2.24% | 8.76% → 8.63% | 0.1246 → 0.1326 | 25 improved, 14 worsened; unadjusted p=0.017 |
| HaluMem | 0.00% → 4.23% | 5.04% → 9.27% | 0.0285 → 0.1012 | 38 improved, 2 worsened; only 2 users, p=0.5 |

R@20 is unchanged on every sample because the rule only permutes selected
evidence. The offline rerank averaged roughly 0.13–2.0 ms per query across the
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
not meet the adoption bar on NMG's independent real-recall traces: 19 queries,
43 explicitly useful memories, and no verified negative labels. On the same
candidate sets, the existing ranker had Hit@1 16/19 and MRR(Q) 0.921; the MLP
had MRR(Q) 0.861. Restricting the MLP to the highest equal-usefulness group
gave Hit@1 17/19 and MRR(Q) 0.947, but the paired result was not significant
(exact p=1.0). The available labels also cannot establish precision on irrelevant
memories. Changing a seed is not evidence that the route succeeds.

The neural ranker therefore failed this task's requirement of a demonstrated,
material gain over product ranking. No neural model is included in the lexical
tie-ranking change. This conclusion applies to the tested ranking task and data;
it does not turn untested semantic candidate recovery into a measured result.
