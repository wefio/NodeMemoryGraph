# Retrieval infrastructure performance, 2026-10-26

[中文](infrastructure-performance-2026-10-26.zh-CN.md) · [Terms used](infrastructure-performance-2026-10-26.terms.yaml)

## Result

Incremental InformationView accounting removes repeated output concatenation.
Batched evidence loading reduces SQL calls without changing measured retrieval
results. The performance arm uses synthetic data; the separate full LME
regression arm below verifies unchanged recall@20 on 500 benchmark questions.

Median milliseconds from the first baseline and final runs:

| Operation | Before | After |
| --- | ---: | ---: |
| Context preparation, 20 views, 8,000 characters | 0.117 | 0.058 |
| Context preparation, 2,000 views, 8,000 characters | 13.698 | 3.179 |
| Context preparation, 2,000 views, all fit | 326.812 | 3.582 |
| Local retrieval, 200 memories, 20 returned | 5.019 | 4.265 |
| SQL executions per retrieval (count, not milliseconds) | 203 | 4 |

The all-fit case uses a 1,000,000-character stress budget; it is not a new
product default. With the 8,000-character budget, 42 of 2,000 views fit and
1,958 are omitted. Both counts and the complete output are unchanged.

Independent process repeats give retrieval medians of 5.019–5.476 ms before
and 4.265–4.285 ms after. The large all-fit context case gives 325.704–326.812 ms
before and 3.582–3.645 ms after. No confidence interval or production latency
claim is inferred from two runs.

## Method and artifacts

Baseline source revision: `d8992f99`. Windows, Node `v24.19.0`, local in-memory
SQLite and no external models. Each case warms up five times and measures 40
iterations. P50/P95 use the repository's `percentileFloor` convention.
Runs are serial; fixture construction, SQL counting and report writing are
outside the timed retrieval section.

The fixture has 200 memories with deterministic IDs, timestamps and importance,
one node and three history records per memory. Search uses `limit=20`,
`maxTier=3`, `graphHops=0`, `secondPass=false`, `persistTrace=false`, `perf=true`,
and an AG budget of 20 nodes, 20 evidence records, 6,000 tokens and tier budget 20.
It exercises the local lexical path. SQL counts instrument prepared-statement
`all/get/run` calls during a separate search; they are not row counts.

InformationView cases cover 20/200/2,000 inputs, flat/context output and
8,000/1,000,000-character budgets. Every fifth input has state purpose; other
inputs have material purpose, and all carry memory source handles and labels.
The benchmark compares SHA-256 hashes of complete prepared outputs and ordered
retrieval result objects. All 12 view cases and the retrieval result match.
AG/board wrapper and protected-omission cases are covered by contract tests.

Raw JSON includes configuration, implementation hashes, timestamps and phase
timings. Retained runs:

- [Baseline](artifacts/2026-10-26-infra-baseline.json) and [baseline repeat](artifacts/2026-10-26-infra-baseline-repeat.json).
- [Rendering only](artifacts/2026-10-26-infra-rendering.json): SQL count remains 203.
- [Both optimizations, initial](artifacts/2026-10-26-infra-optimized.json).
- [Final](artifacts/2026-10-26-infra-final.json) and [final repeat](artifacts/2026-10-26-infra-final-repeat.json).

The final files include formatting and function extraction after the initial
measurement; hashes identify the exact source snapshots. Baseline and final
script differences are formatting only.

## Reproduce and interpret

From the repository root with dependencies installed:

```powershell
rtk proxy node --experimental-strip-types evals/retrieval/infra-perf.ts --out docs/experiments/retrieval/artifacts/infra-local.json --compare docs/experiments/retrieval/artifacts/2026-10-26-infra-baseline.json
```

`--iterations` and `--records` accept positive integers. Comparison requires
matching input configuration and output hashes and exits nonzero on a mismatch.
Missing `--out` and zero iterations were exercised and correctly failed before
writing a report. The script owns and closes its in-memory database. It never
opens an official benchmark store or a shared daemon.

This experiment excludes embedding preparation, RPC transport, disk contention,
graph expansion, second passes, answer generation and judging. The full reader
budget and ranking policies are unchanged. The remaining direct-search phase
dominates this small fixture; further candidate hydration or index work needs
profiles from representative stores. Answer generation and judging were not
rerun. Recall parity is measured separately below.

## Full LME recall regression check

The optimized tree and baseline `d8992f99125958a331b63f2aeb98f7571e2bba93`
were run on all 500 LongMemEval-S questions, using the existing 500 stores from
`nmg-longmemeval_20261025T095539Z`. Each read-only source database produces one
SQLite backup; identical copies feed the two versions. The baseline runs in a
detached worktree with the same installed dependencies as the candidate.

All 500 query vectors hit the cache for `bge-small-en-v1.5@1e9807091681`.
Cache-only mode and a rejecting provider delegate prevent online calls.
Every response must report record retrieval; lexical fallback fails the check.
Both versions execute `OmniMemEvalBridge` with topK 20 and its 6,000-token AG
budget, second pass and chain expansion enabled, summary routing disabled,
and the pinned appended-context limits.

The existing dataset loader and `evals/retrieval/score.ts` supply gold
answer-session texts and `candidate-in-gold` matching. Recall counts 948 gold
sessions across 500 questions; unranked appended context does not count toward
recall@20. This metric is separate from the LLM-as-Judge answer score.

| Metric | Baseline | Optimized |
| --- | ---: | ---: |
| Recall@20, micro evidence | 794/948 = 83.7553% | 794/948 = 83.7553% |
| Any evidence@20 | 479/500 = 95.8% | 479/500 = 95.8% |
| All evidence@20 | 386/500 = 77.2% | 386/500 = 77.2% |
| MRR(Q) | 0.873278 | 0.873278 |

Across 500 pairs there are zero per-question recall regressions, zero changed
ordered ranked-ID lists, and zero changed output hashes. Hashes bind complete
rendered text and memory DTOs, including scores and evidence excerpts. All six
category metrics match. The run completed without failed or skipped questions.
This establishes non-regression on this LME configuration; other datasets and
answer-model outcomes were not measured in this arm.

[Full per-question evidence](artifacts/2026-10-26-infra-recall-lme500.json)
records snapshot hashes, code hashes, dataset identity, ranks and output hashes.
[The smoke run](artifacts/2026-10-26-infra-recall-smoke.json) exercised two questions
before the full run. Timing was not sampled here: aggregate latency fields are
the scorer's zero defaults, not measured zero-cost searches.

To repeat, prepare a clean baseline checkout at the revision above, install the
same dependencies and run `npm run prompts:generate` in it. From the candidate
repository, pass that checkout as `--baseline-root`:

```powershell
rtk proxy node --max-old-space-size=8192 --experimental-strip-types evals/retrieval/infra-recall.ts --baseline-root C:/Documents/GitHub/NodeMemoryGraph-recall-baseline --stores .benchmarks/omnimemeval-nmg --run-input .benchmarks/official/OmniMemEval/results/lme/nmg-longmemeval_20261025T095539Z/nmg_lme_search_results.json --cache .benchmarks/shared-embedding-cache.sqlite --index-id bge-small-en-v1.5@1e9807091681 --out docs/experiments/retrieval/artifacts/infra-recall-local.json --scratch .benchmarks/test-runs/infra-recall-local
```

`--scratch` must not exist: the script owns and removes it. `--limit 2` selects a
smoke run. Dataset-to-user bindings are checked; missing stores, missing cached
queries, fallback, recall regressions or changed outputs fail with a nonzero exit.
The runner passed explicit TypeScript and ESLint checks. Its missing-required-
argument path was exercised and failed as intended.
