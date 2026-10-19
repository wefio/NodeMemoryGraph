# Pool-Aware HyDE on LongMemEval — full-corpus results

[English](hyde-pool-full-2026-08-04.md) | [简体中文](hyde-pool-full-2026-08-04.zh-CN.md) · [Terms](hyde-pool-full-2026-08-04.terms.yaml)

Evidence boundary (2026-10-17 documentation review): this dated record is
historical research material, not a current runtime contract or authorization
to run provider experiments. No cited experiment or original run artifact was
rerun or independently revalidated in this review.

Date: 2026-08-04 · Branch: nmg_search advanced syntax + multi-clause fusion

## What was tested

The agent-facing flow the user specified — *retrieve the recommendation pool
first, then search again with a pool-grounded hypothetical answer*:

```
① auto-recommend: searchContext(question)            → recommendation pool
② pool-aware HyDE: LLM reads question + top-10 pool → hypothetical answer
③ second search:  searchContext(hyde clause)
④ fusion:         baseline ∪ hyde-only results (memory.id dedup)
```

## Recall results (official metric alignment)

Search config reproduced the official bridge exactly (sourceActor=user unless
assistant-evidence query, limit 20, secondPass off, bge-en embeddings), so the
recomputed baseline is bit-for-bit the official fixed-top-20 run:

| metric | baseline | + pool-aware HyDE | Δ |
|---|---|---|---|
| any-evidence recall | 94.15% (451/479) | **96.66%** (463/479) | **+2.51pp** |
| evidence recall | 87.95% | **92.52%** | **+4.58pp** |
| rescued questions | — | 12 (8,30,108,134,288,291,295,302,305,445,456,498) | — |
| regressed | — | 0 | — |
| errors | — | 0 | — |

The recall table uses a 479-question denominator, whereas the answer/judge
stages below report 500 successes. The other 21 judged questions are not included
in that recall denominator; their per-question mapping is not supplied here.
Also, the displayed rounded evidence-recall values subtract to 4.57pp, while
the original table reports +4.58pp. Rounding of underlying values could explain
that 0.01pp difference, but the underlying counts were not rechecked; +4.58pp
is retained as reported, not independently validated.

Rescue concentration: temporal-reasoning (HyDE recovers date/entity anchors
from the pool that the question itself does not mention). Cost: +1 LLM call
(deepseek-chat, ~200 out tokens) + 1 fused search per question.

Pitfall recorded: earlier run without the sourceActor filter reproduced
89.35% baseline (an actor-mixed candidate pool) and overstated the HyDE delta
(+3.97pp); after alignment the true delta is +2.51pp.

## Judged accuracy (real LongMemEval score)

Answer + judge ran against the fused contexts (`results/lme/nmg-hyde-pool/`)
with deepseek-chat for both answer and judge, same prompts and same
`audit-lme-judged.py` as the official fixed-top-20 baseline (81.2%).

| | baseline fixed-top-20 | + pool-aware HyDE | Δ |
|---|---|---|---|
| **Overall Accuracy (official LLM-as-a-Judge)** | **81.2%** | **85.0%** | **+3.8pp** |
| knowledge-update | 84.6% (78) | 85.9% (78) | +1.3 |
| multi-session | 74.4% (133) | **82.7%** (133) | **+8.3** |
| single-session-assistant | 94.6% (56) | **100.0%** (56) | +5.4 |
| single-session-preference | 66.7% (30) | 63.3% (30) | **−3.4** |
| single-session-user | 92.9% (70) | 94.3% (70) | +1.4 |
| temporal-reasoning | 77.4% (133) | 80.5% (133) | +3.1 |
| context tokens / question | 856 | 1100 | +28% |

Notes: judge temperature 0, with 500/500 success reported on both steps.
Temperature 0 does not guarantee repeat-identical hosted-model outputs; answer
and judge use the same model, so this is not independent quality validation.
multi-session is the largest gain (HyDE stitches cross-session detail into the
context); preference is the only regressing class (hypothetical recommendations
can inject noise). Run artifacts: `results/lme/nmg-hyde-pool/`.

## Engineering artifacts

- `evals/omnimemeval/research/probes/hyde-probe.mjs` — small-batch probe (plain vs pool-aware
  HyDE on the official failure set: +5 vs +9 rescued of 28)
- `evals/omnimemeval/research/probes/hyde-full.mjs` — full-corpus recall probe (resume-friendly,
  official-metric aligned)
- `evals/omnimemeval/research/probes/hyde-context.mjs` — generates the fused search-results
  artifact (bridge-identical rendering) that feeds answer + judge
- `src/core/store/advanced-query.ts` + `nmg_search queries[]` — the engine
  generic multi-query surface used to submit a caller-generated HyDE clause;
  HyDE generation itself remains outside NMG
