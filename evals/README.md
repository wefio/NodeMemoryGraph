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

## Pi Agent integration cases

Run `npm run eval:agents` for fresh-process Pi+NMG write/read cases. The runner
loads `DEEPSEEK_API_KEY` from the process environment or the project `.env`,
isolates Pi identity and NMG storage per case, and fails fast when credentials
are unavailable. The suite includes both memory-dependent questions and ordinary
memory-independent work. A no-memory case must produce the correct answer while
making no `nmg_search` or `nmg_get` call, so NMG is checked for interference as
well as recall.

## HaluMem operation-level extraction and update audit

HaluMem is evaluated separately from the OmniMemEval QA runner because its
official operation protocol exposes the write set and update retrieval set.
The checked-in report includes two matched natural slices comparing raw-message
ingress with an Agent executing NMG's durable-write policy. Aggregate
interference accuracy is always accompanied by its per-record decisions because
the official judge can accept a labelled interference inference without the
injected wording having been stored.

```powershell
npm run eval:halumem:prepare -- --users 1 --session-start 6 --sessions 1 --reset
npm run eval:halumem:score -- --users 1 --workers 4
npm run eval:halumem:promotion-audit -- --user 1 --origin-start 5 `
  --origin-end 6 --observe-through 11 --reset 1
```

`promotion-audit` uses the real STG/posterior path. It admits only candidates
with exact user evidence, asks later sessions for independent support or
contradiction, verifies the returned user excerpt, and exports only candidates
passing Core's configured consolidation gate. HaluMem contains no tool-success
or answer-use outcomes; a zero-qualified run is a benchmark-coverage result, not
a reason to weaken the product gate.

`prepare` replays earlier sessions before emitting a bounded scored slice and
writes the official `extracted_memories` / `memories_from_system` fields.
`score` reuses HaluMem's official prompts and judgment functions, omits QA, and
aggregates only metrics with a non-zero denominator. DeepSeek's valid bare JSON
is accepted in addition to the fenced JSON required by upstream. Results and
stores are ignored under `.benchmarks/halumem-nmg/`; see
`docs/experiments/halumem-operation-evaluation-2026-08-11.md`.

For a harness-policy ablation, first run
`npm run eval:halumem:agent-extract -- --users 1 --through-session 6`, then pass
its JSONL to `prepare` with `--agent-extractions`. The extractor sees only the
dialogue and the current NMG memory policy. It never receives gold memory points
or questions, and its cache key includes the policy hash and model.

## Real-use controller calibration

The optional Pi shadow bridge writes bounded local events. Audit and calibrate
them with separate commands:

```powershell
npm run eval:controller-shadow
npm run eval:controller-dataset -- --compact
npm run eval:controller-calibrate -- --compact
```

New retrieval events include the exact versioned controller feature snapshot
and Active Graph hard-budget envelope used at decision time. The dataset builder
rejects older labelled rows that cannot replay those inputs. Calibration uses a
chronological semantic-task split and writes a candidate artifact containing
the feature protocol, data window, effective hyperparameters, held-out metrics,
source-log fingerprint, and current-state rollback fingerprint. It never
activates or overwrites runtime policy. With insufficient independently labelled
real-use rows, the command exits with explicit blockers instead of training on
benchmark or synthetic labels.

The compact form reports row/split/task counts and blockers without dumping
every replay row into the terminal. Omit `--compact` when the complete joined
dataset is intentionally needed for an audit or export.

Matched benchmark scoring uses the same fail-closed rule. Each official scored
row preserves `taskScore`, nullable binary `taskSuccess`, typed/nullable evidence
sufficiency, Pi tool rounds, provider tokens, and answer latency. A complete
causal arm comparison emits `matchedProduct.metrics`; partial labels, unpaired
rows, or an observational candidate emit blockers and `metrics: null`. To attach
a valid scored artifact to an offline controller gate run:

```powershell
$env:NMG_CONTROLLER_MATCHED_PRODUCT_REPORT = "evals/.../official-score.json"
npm run eval:controller -- locomo 4
```

This imports only the typed metrics. It does not merge benchmark rows into the
natural shadow-training dataset, and a shadow-only artifact is rejected because
the candidate did not affect ranking.

## Experiment logs

This file intentionally keeps stable guidance and principles only. Raw run
matrices, root-cause analyses, and protocol notes live in dated standalone
logs under `docs/` (indexed here so new work can find prior evidence):

- `docs/experiments/longmemeval-profile-regression-2026-08-03.md` — LongMemEval baseline
  "drift" (94.15% → 76.0%) root-caused to embedding profile config drift;
  BGE models now auto-select the bge-en prompt template. Full fixed-vs-dynamic
  matrix under the corrected config: 94.15%/87.95%/81.2% vs 95.19%/89.71%/82.3%
  (any-evidence recall / overall / answer accuracy).
- `docs/experiments/qpp-evidence-signal-experiments-2026-08-02.md` — QPP trigger signal
  audit (top1 gap, cohesion, LLM sufficiency) and strong-hit evaluation.
- `docs/experiments/locomo-evidence-mode-signal-2026-08-02.md` — LoCoMo official
  search-only protocol alignment and evidence-mode signal protocol.
- `docs/experiments/qpp2-local-probe-experiment-2026-07-29.md` — local QPP2/elbow probe.
- `docs/design/daemon-lifecycle-design.md` — daemon lifecycle hardening (timeout,
  store cap as warning, restart fidelity) and its acceptance tests.
- `docs/design/llm-sufficiency-recall-design.md` — LLM-sufficiency recall design.
- `docs/experiments/lme-recall-headers-2026-08-04.md` — recall-header refinement verified as format-only (94.15/87.95/82.67 unchanged; answer acc 82.3%).

## Unified OmniMemEval runs

LongMemEval, LoCoMo, BEAM, PersonaMem v2 and HaluMem use the same NMG entry
point. The entry point owns preflight checks, environment encoding, NMG-safe
worker defaults, exact step forwarding and resume validation; the pinned
OmniMemEval scripts continue to own each dataset's parsing, prompts, scoring,
checkpoint implementation and report schema.

```powershell
# Complete pipeline. The version is generated when omitted.
npm run benchmark:omni -- longmemeval --env .env.nmg-bgefix

# The same common flags work for every suite.
npm run benchmark:omni -- locomo --env .env.nmg-opencode `
  --version locomo-canary --llm-workers 32 --top-k 20

# Dataset-only flags go after `--`; they cannot silently become global policy.
npm run benchmark:omni -- beam --env .env.nmg-opencode `
  --version beam-canary -- --scale 100k --judge-batch-size 4

# Resume from search only when the exact old result directory is named.
npm run benchmark:omni -- longmemeval --env .env.nmg-bgefix `
  --version fixed20-rerun --from-step 2 `
  --resume-dir .benchmarks/official/OmniMemEval/results/lme/nmg-fixed20-rerun

# Validate the resolved official command without running it.
npm run benchmark:omni -- personamem-v2 --env .env.nmg-opencode --dry-run
```

The common defaults are `workers=1`, `llm-workers=16`, `top-k=20` and
`num-runs=1`. Explicit CLI values win. `workers=1` protects NMG's single-writer
bridge; answer and judge calls still use the shared LLM concurrency pool.
The runner never kills Pi, NMG daemons, embedding servers, or unrelated Python
processes. External services remain the caller's responsibility.

`--from-step > 1` is fail-closed: both `--version` and `--resume-dir` are
required, the directory must belong to the selected suite, its recorded NMG
version must match, and the preceding checkpoint artifact must be non-empty.
This prevents an old result label from accidentally continuing against a new
or empty store. `--replay <result-dir>` delegates to OmniMemEval's official
interactive replay flow. Dataset-specific audits remain separate commands;
they do not change execution or official scoring.

Storage: user stores (`omnimemeval-nmg/*.sqlite`) are keyed by
`sha256(userId)` and the userId embeds the version label, so every run creates
~500 fresh ~12 MB stores that are never reused. Embeddings are the shared,
reusable part: all evals use ONE content-hashed cache at
`.benchmarks/shared-embedding-cache.sqlite` (keys = `(model, kind, text_hash)`,
so the same text under the same model maps to the same vector everywhere).
**Boundary — do not create new per-eval embedding caches.** `OmniMemEvalBridge`
and the probe/audit scripts default to the shared cache; only pass an explicit
`embeddingCachePath` (or hardcode a path) when true isolation is required, and
fold its content back into the shared cache when done
(`evals/omnimemeval/merge-embedding-caches.mjs`). Measured before merging:
27% of cached rows (248k) were duplicates across eval variants — the merged
shared cache is the single source of truth. Run `--prune-stores` after a run
to drop all stores except the current run's (ingestion rebuilds them; the
shared embedding cache is what actually makes reruns cheap).

## Benchmark roles

| Suite               | Primary role                  | NMG mechanisms under test                                                                          |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| NMG core cases      | Fast deterministic regression | storage, provenance, STG/LTG lifecycle, Active Graph budgets, deletion and cache invalidation      |
| LongMemEval         | Main development gate         | extraction, multi-session reasoning, updates, temporal reasoning and abstention                    |
| PersonaMem          | User-memory gate              | automatic fact/preference/constraint writes, evolving profiles, scope and current-state selection  |
| LoCoMo              | Relational-memory gate        | temporal and causal links, multi-hop evidence, node-to-leaf expansion and event summarization      |
| BEAM                | Scale and cache-pressure gate | progressive retrieval, cache misses, maintenance cost and growth from 128K through 10M tokens      |
| Reasoning workspace | Lab scratchpad gate           | explicit task-state retention, Pi compaction recovery, overhead, and unsupported scratchpad claims |
| SkillOpt policy     | Offline policy decision gate  | answer/expand/stop, noise folding, held-out policy selection, matched Pi promotion                   |

The suites are reported separately. Their scores must not be averaged into one
number because they measure different distributions and failure modes.

## Official-protocol benchmark commands

The npm entry points below are the README-independent reproduction surface.
Dataset placement and overrides are documented in each adapter's README under
`evals/`; `validate` parses official local data and reports stratified samples
without a model call.

```bash
# LongMemEval development comparison (also see "Reproducible LongMemEval runs")
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
npm run eval:longmem -- matched 1
npm run benchmark:score:longmem -- <result-directory>

# LoCoMo / PersonaMem / BEAM share one runner and the same matched modes
npm run eval:locomo -- validate 1
npm run eval:personamem -- validate 1
npm run eval:beam -- validate 1

npm run eval:locomo -- matched 1
npm run eval:personamem -- matched 1
npm run eval:beam -- matched 1
npm run benchmark:score -- <locomo|personamem|beam> <result-directory>

# Deterministic invariants and ablations (no model call)
npm run eval:quality
npm run eval:adaptive

# Scale ladder: 100 / 1K / 10K / 100K memories (see evals/scale/README.md)
npm run eval:scale
```

Matched rows retain exact Pi tool rounds, tool calls, provider token usage, and
answer latency. Official scoring adds a lossless `rowScore`; task success and
evidence sufficiency remain `null` when the upstream protocol does not define
them. The scored artifact also contains a fail-closed `matchedProduct` audit.
The current `nmg-shadow` arm does not alter ranking, so its audit intentionally
reports `candidate_does_not_affect_ranking` instead of product-gate metrics.

Older LongMemEval diagnostic ablations compared raw-session, flat-hybrid, Lite,
and Graph variants. They predate the strict three-arm protocol and remain
documented only as historical mechanism evidence, not as current matched-gate
or benchmark claims.

## SkillOpt policy Lab

`evals/skillopt` exports only de-identified observable retrieval state and
explicit decision labels. It never exports memory statements or evidence. The
official SkillOpt optimizer remains an ignored external checkout; NMG installs
a thin adapter rather than vendoring or reimplementing it.

```powershell
npm run eval:skillopt:install
npm run eval:skillopt:export
```

The exporter fails closed until natural train/validation/test minima are met.
Use `--allow-insufficient` only for a file-layout/adapter smoke. See
`docs/design/skillopt-policy-optimization.md`.

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
them: code revision, sample fingerprint, judge model, protocol, sample size,
and a resolved non-secret parameter block. The parameter block records QPP1,
QPP2, retained mass, recommendation mode, progressive-pass settings, QPP
threshold, graph-hop override, and embedding model/profile/dimensions/batch
size. API keys, provider credentials, and machine-specific data paths are never
included.
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

The separate backend capability ablation runs the four architecture arms from
the design checklist over one shared sample/corpus and budget:

```powershell
npm run eval:longmem -- backend-ablation 1
```

Its arms are `no-memory`, `flat-hybrid`, `nmg-lite` (`graphHops=0`), and
`nmg-graph` (`graphHops=1`). Each row records both the complete effective prompt
hash and a `taskPromptHash` covering the invariant question/instructions. This
is a matched local development comparison, not a leaderboard run.

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

NMG daemons started per arm are self-limiting: `NMG_DAEMON_IDLE_TIMEOUT_MS`
(default `300000`, `<=0` disables) makes an orphaned daemon exit after that
many milliseconds without requests, and `NMG_DAEMON_LIMIT` (default `32`,
`<=0` disables) warns on stderr when live daemon count exceeds the limit
before spawning a new one. See
[daemon-lifecycle-design.md](../docs/design/daemon-lifecycle-design.md).

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
same seven fixed LongMemEval questions as the Pi development run. The first
forced-search pass made five of seven cases plausibly answerable. Diagnosis
showed that unverified assistant replies and English question words were
crowding out user evidence. NMG now exposes an optional source-actor filter;
the adapter defaults user-memory questions to user assertions and falls back
to both actors for explicit assistant/previous-chat recall. Lexical ranking
also ignores common English question/function words.

On the fixed sample this recovered both temporal evidence records (2/2),
preserved both update records (2/2), preference evidence (1/1), and assistant
evidence (1/1). The clothing count improved from two duplicate boot mentions
to complementary boot and blazer evidence, but remains only 2/3 against the
official evidence list. Search latency stayed around 126–166 ms. Context was
usually 2.8–4.1k characters; the long assistant schedule case reached 7.5k.

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

## Consolidation policy audit

`npm run eval:consolidation` uses LoCoMo's official evidence IDs as independent
positive task outcomes to audit the STG → LTG posterior gate and its retention
hysteresis. It reports coverage and contradiction-to-retraction stress without
calling an LLM. Absence from an evidence list is never treated as a negative
claim label, so this audit deliberately does not report false-promotion
precision. See `docs/experiments/consolidation-evaluation-2026-08-09.md`.

For ordinary product data, run the separate read-only evidence inventory:

```powershell
npm run eval:natural-maintenance -- --project-dir C:/path/to/project
```

It opens the authoritative LTG and project STG SQLite files in read-only mode,
reports claim outcomes/posteriors, STG promotion and retention candidates,
materialized STG→LTG markers, maintenance backlog, topology proposals, identity
gate reasons, transforms, and rollbacks. It never records outcomes, runs
maintenance, promotes memories, or actuates a merge. Missing evidence is emitted
as an explicit `evidenceGaps` list; a clean command run is not evidence that
natural precision or reversibility has been validated. Use repeatable `--stg`
arguments when auditing more than one project-local STG.
`maintenanceBacklog` distinguishes locally due nodes from distributed global
pressure, so a high total cannot be mistaken for one hot node.

## Topology identity-gate audit

`npm run eval:topology` uses LoCoMo's stable speaker identities to construct
same-person early/late node pairs and cross-person negative pairs. It measures
the production `same_as` assessment gate, competing-identity withdrawal, and
the invariant that assessment never mutates topology. Candidate generation is
deliberately held constant, so the result is not an alias-resolution or
end-to-end automatic-merge score. See
`docs/experiments/topology-gate-evaluation-2026-08-09.md`.

`npm run eval:topology:bpid` adds multi-field identity hard negatives, while
`npm run eval:topology:namesakes` optionally reads the official CC BY 4.0
Namesakes Entities JSONL to measure alias-like positive recall and rejection of
same-name references to a different entity. Both report candidate-generation
curves and remain read-only: neither score is allowed to authorize a merge.
Namesakes data belongs under `.benchmarks/namesakes/data/` and is not committed.
See `docs/experiments/topology-bpid-evaluation-2026-08-09.md` and
`docs/experiments/topology-namesakes-evaluation.md`.

The official LoCoMo scorer uses the environment created by
`npm run benchmark:setup`. If that uv-managed interpreter cannot execute in the
current sandbox, set `NMG_BENCHMARK_PYTHON` to one compatible Python environment
containing the pinned scorer dependencies. NMG uses this single explicit path;
it does not silently fall through across unrelated Python installations.
