# Evaluation and falsifiable claims

[简体中文](evaluation-and-falsifiable-claims.zh-CN.md) · [Terms used](evaluation-and-falsifiable-claims.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Evaluation and falsifiable claims

NMG must be evaluated with the same base model, prompts, histories, and budgets
under these controls:

1. no long-term memory;
2. raw session search with FTS/exact retrieval;
3. flat FTS + vector hybrid retrieval;
4. NMG Lite progressive disclosure;
5. NMG Graph with adaptive nodes, relations, and optional learned routing.

Core hypotheses:

- **Hierarchical coding:** node/leaf headers reduce tokens or latency without
  reducing evidence recall.
- **Adaptive granularity:** measured refinement reduces semantic routing errors.
- **Relational side information:** graph expansion improves temporal, scoped,
  conflict, or multi-hop questions enough to pay for its cost.
- **Learning:** a learned router improves recall/cost over cosine, lexical, and
  simple hybrid controls.
- **Active projection:** an explicit budgeted AG improves evidence coverage per
  token over ordinary Top-K context injection.
- **Consolidation:** stability-gated structural promotion improves future
  multi-hop retrieval without increasing false relations or stale-memory errors.

If Lite does not beat the flat hybrid control, its hierarchy has no demonstrated
product value. If Graph does not beat Lite, graph adaptation remains a Lab
feature. If a learned router does not beat deterministic routing, it remains
optional.

Development evidence snapshot (updated 2026-08-24):

- 953 automated tests cover UOp autodiff, the differentiable controller,
  hierarchical activation, the retained memory-graph reasoner prototype,
  reasoning-workspace persistence and checkpoint injection, P3 lifecycle,
  budget enforcement, disclosure/verified-evidence separation, independent-task deduplication,
  reversible consolidation, write-policy audit, Active Graph traces, official
  benchmark adapters, and schema migration. Test files live in `tests/core/`,
  `tests/evals/`, and `tests/extensions/nmg/`.
- a clean DeepSeek V4 Flash Pi process wrote a unique LTG fact, a second process
  recovered it through `nmg_search -> activeGraphId -> nmg_get`, and the store
  recorded one selection and one exact disclosure; isolated test data was removed
  afterwards and `PRAGMA foreign_key_check` remained clean;
- strict three-arm LongMemEval development gate over one fixed question from
  each of seven categories, scored separately with the pinned official protocol:
  no-memory 1/7, deterministic NMG 2/7, and identical deterministic NMG with
  non-ranking shadow logging 3/7. No external embedding provider was enabled.
  Deterministic retrieval was sufficient in 2/7 cases and both answers were
  correct; all five retrieval misses were wrong. Shadow decisions cannot affect
  ranking. The observed 2/7 versus 3/7 score difference is unexplained by the
  available record; its cause could include model/judge or other run variation,
  and it does not establish a shadow-logging effect;
- historical pre-gate LongMemEval diagnostic, one fixed case from seven categories: no-memory 1/7,
  raw-session 1/7, flat hybrid 5/7, Lite 5/7, Graph 6/7;
- historical pre-gate LongMemEval diagnostic, two fixed cases from seven categories:
  no-memory 2/14, raw-session 4/14, flat hybrid 8/14, Lite 10/14, Graph 9/14;
- controlled 30-case topology ablation: flat 0%, fixed unlinked graph 0%,
  accepted evidence-backed link 100% recall by construction;
- controlled labelled routing: heuristic 0%, online router after three explicit
  useful-node labels 100% by construction;
- 10K near-duplicate hierarchy workload: node+leaf exact scan 100% accuracy at
  10.6 ms P50, leaf ANN 87.5% at 8.1 ms P50, full record scan 75% at 779 ms P50.
- full 1,540-question LoCoMo K=20 retrieval ablation with local
  `BAAI/bge-small-en-v1.5`: FTS5 exact-evidence recall 45.1%, node/leaf summaries
  18.0%, record vectors 52.9%, and node/leaf+record union 17.7%. Record vectors
  also kept mean latency and context size near the lexical baseline. This
  rejects compressed hierarchy as the sole evidence index and rejects the
  current union ranker; node/leaf routing remains a directory/scale
  optimization, not a substitute for detailed evidence candidates. The
  1,540-question total reported here is not reconciled with the 1,532
  scored-question denominator in the [LoCoMo relevance-gate report](../../experiments/retrieval-quality/relevance-gate-calibration-2026-09-09.md);
  this document does not establish that those denominators describe the same
  scored set.
- full 20-conversation, 400-question BEAM 100K K=20 retrieval ablation:
  FTS5 exact labelled-evidence recall was 26.2% and BGE record vectors reached
  32.9% with slightly less returned text. Incremental add-time indexing kept
  32.8% recall while reducing mean first-query latency from 2,102 to 193 ms
  and total add-plus-search time from 73.0 to 68.9 seconds. Shared all-actor
  ranking and fixed actor quotas were rejected because they added context and
  latency without improving recall.
- full OmniMemEval BEAM 100K answer-and-judge run over the same 20 conversations
  and 400 questions: NMG with BGE record vectors, K=20, QPP2 off, and DeepSeek V4
  Flash as both reader and judge scored `0.6422 ± 0.3974`. Search latency was
  40.9 ms P50 and 185.1 ms P95; all 400 search, answer, and judge records
  completed without skipping. A matched empty-retrieval-context control using
  the same questions, prompt, reader, and judge scored `0.2724 ± 0.4086`; the
  paired gain was `+0.3698` (20,000-sample descriptive paired-bootstrap 95%
  interval `[+0.3205, +0.4183]`; 251 wins, 123 ties, 26 losses). Abstention
  regressed by `-0.3875`, so this is evidence of dataset-specific utility, not a
  blanket safety or generalization claim. Full parameters, per-dimension scores,
  accounting caveats, timing, and runner corrections are recorded in the
  [BEAM 100K evaluation report](../../experiments/benchmarks/beam-100k-evaluation-2026-08-13.md).
- reasoning-workspace development benchmark, three tasks with three repeats per
  condition using DeepSeek V4 Flash: full-context baseline and workspace both
  achieved 100% exact task success, while mean latency rose from 5.79 s to
  15.15 s; after ordinary Pi compaction, baseline achieved 88.9% and workspace
  100%, while latency rose from 9.83 s to 23.41 s. One of nine compacted
  workspace trials persisted an unsupported hypothesis marker.
  The topology and router cases isolate whether the mechanisms can learn and
  apply a missing relation; they are not natural-distribution quality estimates.
  The scale result shows why leaf granularity matters and why the current ANN
  configuration must not replace exact local scan yet.

The 14-question paired outcomes are more important for product gating than the
controlled topology result: Lite uniquely won five versus flat's three, while
Graph uniquely won one versus Lite's two. The sample is still too small for a
capability claim, and it explicitly keeps graph expansion in Lab.

Track evidence Recall@K, stale-memory error, wrong-scope error, false-memory
injection, answer accuracy, unrelated-task regression, injected tokens, deepest
tier, index/maintenance cost, and end-to-end P50/P95 latency including query
embedding. For STG/LTG/AG experiments also track STG residence time, atomic
promotion latency, relation precision, false-consolidation rate, consolidated
subgraph reuse, AG node/edge/evidence counts, budget utilization, expansion
steps, and marginal evidence gain per added token.

### Offline text-space policy optimization

Read the complete responsibility: [Offline text-space policy optimization](evaluation-and-falsifiable-claims/offline-text-space-policy-optimization.md).
