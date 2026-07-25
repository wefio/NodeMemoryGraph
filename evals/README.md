# NMG evaluation strategy

NMG uses two complementary kinds of tests:

- deterministic engineering cases detect implementation regressions;
- public memory benchmarks measure whether the system improves agent behaviour.

Public benchmark scores do not replace the deterministic core suite. A memory
system can answer benchmark questions correctly while corrupting provenance,
exceeding its retrieval budget, or rebuilding an index unnecessarily.

## Benchmark roles

| Suite | Primary role | NMG mechanisms under test |
|---|---|---|
| NMG core cases | Fast deterministic regression | storage, provenance, STG/LTG lifecycle, Active Graph budgets, deletion and cache invalidation |
| LongMemEval | Main development gate | extraction, multi-session reasoning, updates, temporal reasoning and abstention |
| PersonaMem | User-memory gate | automatic fact/preference/constraint writes, evolving profiles, scope and current-state selection |
| LoCoMo | Relational-memory gate | temporal and causal links, multi-hop evidence, node-to-leaf expansion and event summarization |
| BEAM | Scale and cache-pressure gate | progressive retrieval, cache misses, maintenance cost and growth from 128K through 10M tokens |

The suites are reported separately. Their scores must not be averaged into one
number because they measure different distributions and failure modes.

## Reproducible official-protocol workflow

NMG keeps prediction generation separate from benchmark scoring. A reader run
writes `report.json` and `predictions.jsonl`; a later scoring command writes
`official-score.json` without rerunning the reader model.

```powershell
npm run benchmark:setup
npm run benchmark:validate

npm run eval:locomo -- matched 1
npm run benchmark:score -- locomo <result-directory>

npm run eval:longmem -- matched 1
npm run benchmark:score:longmem -- <result-directory>
```

### Committed score snapshots

Run directories are ignored, so scoring also writes a small snapshot under
`evals/snapshots/<benchmark>/<timestamp>_<revision>.json`. These are committed.

Each snapshot holds per-mode scores plus the provenance needed to interpret
them: code revision, sample fingerprint, judge model, protocol and sample size.
Two snapshots are only comparable when their `sampleFingerprint` matches; a
differing fingerprint means the runs covered different cases, not that quality
changed.

Snapshots exist to make regressions visible across commits. They remain
development signal: sample sizes are small and `leaderboardComparable` is false.

`benchmark:setup` checks out the four official repositories at the commits in
`evals/official/upstreams.json` under ignored `.benchmarks/official`. It also
creates an isolated uv-managed Python 3.11 environment for official scorers;
benchmark code is not copied into NMG core.

Judge-backed protocols currently use `deepseek/deepseek-v4-flash` in place of
the upstream proprietary judge. Those outputs are labelled
`official-protocol/deepseek-judge`; LoCoMo and PersonaMem are labelled
`official-protocol/deterministic`. All experimental outputs retain
`leaderboardComparable: false`. LoCoMo uses its official deterministic QA and
retrieval functions, PersonaMem uses its official option-extraction rule, and
BEAM uses its rubric scale. BEAM
`event_ordering` uses the official normalized Kendall tau-b aggregation rather
than rubric-score averaging.

## Common experiment arms

Every adapter should expose as many of the following matched arms as the source
dataset permits:

1. `no-memory`: question and current date only;
2. `oracle`: official evidence only;
3. `raw-session`: ranked complete sessions under the shared context budget;
4. `flat-lexical`: flat FTS/BM25-style retrieval;
5. `flat-hybrid`: flat lexical plus vector retrieval;
6. `nmg-auto`: natural question with automatic budgeted recall only;
7. `nmg-nodes`: agent-directed node and leaf retrieval without graph expansion;
8. `nmg-active-graph`: budgeted STG/LTG Active Graph projection;
9. `nmg-full`: Active Graph plus feedback and consolidation, when the benchmark
   contains a genuine incremental write phase.

All matched arms use the same reader model, prompt, answer limit, source
history, retrieval token budget, question IDs and judge. An arm that receives
more evidence tokens must be reported as a different budget condition.

## Required measurements

### Capability

- official answer score and per-category score;
- evidence Recall@K and Precision@K when evidence labels exist;
- knowledge-update, wrong-scope and stale-memory error rates;
- abstention accuracy and false-memory injection rate;
- preference-following and contradiction-resolution accuracy where applicable.

### Cost

- records and evidence tokens read by the memory backend;
- tokens injected into the reader;
- graph nodes, edges, hops, local tiers and expansion steps visited;
- query, embedding, reranking and end-to-end P50/P95 latency;
- write, indexing, consolidation and rebuild work.

### Longitudinal behaviour

- retrieval cost and quality as total history grows;
- STG residence and promotion latency;
- false consolidation and incorrect node-merge rates;
- cache hit rate and cold-query penalty;
- summary hit with missing leaf evidence;
- index work per appended session.

Each result records the model identifier, model parameters, code revision,
dataset revision, fixed question IDs, random seed where supported, concurrency,
budgets and retry policy. Stochastic reader/judge experiments require repeated
runs or must be labelled development signals rather than capability claims.

For a command-level smoke test, set `NMG_BENCH_CASE` to one ID from the selected
stratified sample. `NMG_BENCH_CONCURRENCY`, `NMG_BENCH_TIMEOUT_MS`, and
`NMG_BENCH_CONTEXT_CHARS` control the shared runner.

`validate` performs parsing and sampling without model calls. A matched run
performs six reader/judge experiments per selected case and can take minutes;
the runner writes per-case/per-mode progress to stderr.

## Rollout order

1. Keep LongMemEval as the fast public development gate and expand its fixed
   paired sample with repeated runs.
2. Add PersonaMem next, initially as a deterministic ingestion and current
   preference/profile selection adapter.
3. Add LoCoMo after the shared evidence contract exists; use its evidence IDs
   to evaluate graph routing separately from answer generation.
4. Add BEAM last. Start at 128K, then 500K. Run 1M and 10M only if retrieval
   work grows materially slower than history size and the smaller tiers do not
   already expose the same failure.

Adapters should translate official data into a small shared case/result schema,
not copy benchmark-specific assumptions into NMG core.

## NMG-specific ablations

At minimum, capability experiments should isolate:

- STG disabled versus enabled;
- node/leaf retrieval versus flat record retrieval;
- Active Graph projection versus unbounded context injection;
- graph expansion disabled versus enabled;
- agent-confirmed use feedback disabled versus enabled;
- consolidation disabled versus enabled;
- lexical-only, vector-only and hybrid routing.

The purpose is to attribute gains to mechanisms. A larger NMG configuration is
not considered better when the same result comes from a smaller retrieval arm.

## Current adapter verification

On 2026-07-22 the loaders validated the locally downloaded official data:

- LongMemEval cleaned: 500 cases across seven categories;
- LoCoMo: 1,986 cases across five categories;
- PersonaMem 32K: 589 cases across seven categories;
- BEAM official 100K case 1: 20 cases across ten categories.

The original official-data smoke runs timed out because the benchmark allowed
Pi to auto-discover both the package and project extension, then explicitly
loaded NMG again. Every benchmark client now uses `--no-extensions` and loads at
most one explicit NMG instance; the no-memory controls load none. On a five-case
LoCoMo development sample, BGE-small automatic recall scored 3/5 and
agent-directed node recall scored 1/5. These single-run results are diagnostic,
not benchmark claims; they show that automatic and agent-directed retrieval must
remain separate arms.
