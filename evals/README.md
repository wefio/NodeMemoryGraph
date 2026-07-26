# NMG evaluation strategy

NMG uses two complementary kinds of tests:

- deterministic engineering cases detect implementation regressions;
- public memory benchmarks measure whether the system improves agent behaviour.

For public user-memory evaluation, NMG prefers
[OmniMemEval](https://github.com/MemTensor/OmniMemEval) as the upstream
multi-benchmark harness. Its user-memory track already provides one ingestion,
search, answer and scoring pipeline for LongMemEval, LoCoMo, BEAM, PersonaMem
v2 and HaluMem. NMG should integrate through one thin client adapter rather
than permanently maintaining one execution pipeline per benchmark.

Public benchmark scores do not replace the deterministic core suite. A memory
system can answer benchmark questions correctly while corrupting provenance,
exceeding its retrieval budget, or rebuilding an index unnecessarily.

## Benchmark roles

| Suite               | Primary role                  | NMG mechanisms under test                                                                          |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| NMG core cases      | Fast deterministic regression | storage, provenance, STG/LTG lifecycle, Active Graph budgets, deletion and cache invalidation      |
| LongMemEval         | Main development gate         | extraction, multi-session reasoning, updates, temporal reasoning and abstention                    |
| PersonaMem          | User-memory gate              | automatic fact/preference/constraint writes, evolving profiles, scope and current-state selection  |
| LoCoMo              | Relational-memory gate        | temporal and causal links, multi-hop evidence, node-to-leaf expansion and event summarization      |
| BEAM                | Scale and cache-pressure gate | progressive retrieval, cache misses, maintenance cost and growth from 128K through 10M tokens      |
| Reasoning workspace | Lab scratchpad gate           | explicit task-state retention, Pi compaction recovery, overhead, and unsupported scratchpad claims |

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

### Local score snapshots

Run directories are ignored, so scoring also writes a small snapshot under
`evals/snapshots/<benchmark>/<timestamp>_<revision>.json`. Snapshots and raw
logs are local runtime artifacts and are ignored by Git.

Each snapshot holds per-mode scores plus the provenance needed to interpret
them: code revision, sample fingerprint, judge model, protocol and sample size.
Two snapshots are only comparable when their `sampleFingerprint` matches; a
differing fingerprint means the runs covered different cases, not that quality
changed.

Snapshots support local regression comparisons. Any result selected for a
design document must be copied into a small, manually reviewed summary with its
sample fingerprint and protocol; raw run output is never committed.

`benchmark:setup` checks out the four official repositories at the commits in
`evals/official/upstreams.json` under ignored `.benchmarks/official`. It also
creates an isolated uv-managed Python 3.11 environment for official scorers;
benchmark code is not copied into NMG core.

OmniMemEval and the local Pi runner measure different boundaries. OmniMemEval's
user-memory track always invokes the backend's `search()` method, so it is the
preferred backend-retrieval harness and should own public-dataset parsing,
replay, checkpointing and report generation. The local matched runner remains
the Pi integration gate because it measures whether the harness triggers recall
and whether the agent uses the returned evidence. It is not retired when
OmniMemEval parity passes.

Judge-backed protocols currently use `deepseek/deepseek-v4-flash` in place of
the upstream proprietary judge. Those outputs are labelled
`official-protocol/deepseek-judge`; LoCoMo and PersonaMem are labelled
`official-protocol/deterministic`. All experimental outputs retain
`leaderboardComparable: false`. LoCoMo uses its official deterministic QA and
retrieval functions, PersonaMem uses its official option-extraction rule, and
BEAM uses its rubric scale. BEAM
`event_ordering` uses the official normalized Kendall tau-b aggregation rather
than rubric-score averaging.

## Matched capability gate

The default `matched` command runs exactly three arms:

1. `no-memory`: Pi without the NMG extension;
2. `nmg-deterministic`: deterministic NMG with controller shadow disabled;
3. `nmg-shadow`: the same deterministic NMG retrieval with controller scoring
   and telemetry enabled, but without changing ranking.

Every NMG arm starts from an independent copy of the same seeded database. All
three arms use the same reader model, thinking level, user prompt, question IDs
and official scorer. The runner records a prompt hash per row. Set
`NMG_BENCH_REPEATS` for repeated stochastic trials; one repeat is only a smoke
signal.

Other modes (`raw-session`, `flat-hybrid`, `nmg-nodes`, and `nmg-graph`) remain
diagnostic ablations rather than members of the strict three-arm gate.

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
performs three reader experiments per selected case and can take minutes;
the runner writes per-case/per-mode progress to stderr.

## Rollout order

1. **Complete:** add a thin NMG client to OmniMemEval's user-memory client registry. It must
   implement only the harness contract (`add`, `search`, and per-user cleanup)
   and call a stable NMG service/CLI boundary.
2. **Smoke complete:** replay the current fixed LongMemEval sample through
   OmniMemEval search-only before changing retrieval behaviour. This is the
   backend parity gate; it does not replace the Pi matched gate.
3. Run PersonaMem v2, LoCoMo and BEAM through the same adapter. Add HaluMem
   only after the first four suites are reproducible.
4. Keep BEAM scale runs staged: 128K, then 500K, then 1M/10M only when smaller
   tiers have not already exposed the same failure.
5. Retire only duplicated public-dataset parsing and scoring after score,
   sample, provenance and cost telemetry parity is demonstrated. Preserve the
   small local Pi end-to-end runner.

### July 2026 LongMemEval search-only smoke

The pinned OmniMemEval checkout successfully exercised the NMG adapter on the
same seven fixed LongMemEval questions as the Pi development run. Forced
backend search made five of seven cases plausibly answerable. It retrieved both
old and new personal-best evidence for the update case, but still missed
required evidence for the multi-session clothing count and the MoMA/Met
temporal comparison. Typical search latency was about 137–152 ms with roughly
2.3–4.2k context characters.

A controlled change from the default legacy path to hybrid FTS was rejected.
On the two deficient cases it did not recover the missing evidence, expanded
contexts to 7.2–7.9k characters, and increased the temporal query to 2.04 s.
This indicates that indiscriminate candidate expansion is not the next fix;
multi-evidence aggregation and temporal coverage need targeted work.

On Windows, set `PYTHONUTF8=1` because upstream progress output includes emoji.
The adapter installer must patch OmniMemEval's central client registry, generic
text-search dispatcher, and conversation-ID allowlist; those registrations are
currently maintained separately upstream.

OmniMemEval's agent-memory track is not the initial integration target. It is
currently coupled to AgentBench/OpenClaw lifecycle plugins, whereas NMG's
runtime integration target is Pi. Pi end-to-end tests therefore remain local
until a small runtime-neutral plugin protocol is justified by evidence.

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

## Adapter verification

Use `npm run benchmark:validate` as the authoritative check for locally
available official data. Do not preserve ad-hoc model scores in this document:
they become stale when sampling, prompts, retrieval policy, or model versions
change. Every benchmark client uses `--no-extensions` and loads at most one
explicit NMG instance; the no-memory control loads none.
