# NMG evaluation strategy

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

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

## Layout

- `omnimemeval/` contains the maintained NMG HTTP client and its upstream
  evaluation guide. Its `research/` subtree contains probes, audits and ablations.
- `official/` pins benchmark sources and supplies offline scoring utilities.
- `controller*`, `topology/`, `retrieval/`, `consolidation/`, `disclosure/`,
  `reasoning-workspace/`, and scale/performance directories are focused research
  families. Use their local README or package script instead of treating the
  directory root as a command surface.

Only stable entry points belong in `package.json`. One-off scripts live beside
their evidence family and must not silently define benchmark or product policy.

## Pi Agent integration cases

Historical headless Pi runs measured recall and interference on ordinary tasks.
See the [archived evaluation guide](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/README.md) for the setup and results.

## HaluMem operation-level extraction and update audit

HaluMem is evaluated separately from the OmniMemEval QA runner because its
official operation protocol exposes the write set and update retrieval set.
The checked-in report includes two matched natural slices comparing raw-message
ingress with an Agent executing NMG's durable-write policy. Aggregate
interference accuracy is always accompanied by its per-record decisions because
the official judge can accept a labelled interference inference without the
injected wording having been stored.

```powershell
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

The scorer accepts existing operation-level artifacts. The original local
write-set and agent-extraction comparison is recorded in the
[archived evaluation guide](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/README.md).

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
rows, or an observational candidate emit blockers and `metrics: null`.

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

## OmniMemEval over NMG HTTP

Run the pinned upstream suite with the NMG HTTP adapter. The
[OmniMemEval guide](omnimemeval/README.md#run-longmemeval-over-nmg-http) covers
installation, the NMG HTTP endpoint and namespace, and the LongMemEval command.
The upstream runner owns checkpoints and the report. Repository-local scoring
commands can still score artifacts from supported historical runs.

## One-off measurement scripts

Each measures one property and none of them runs in CI. They write JSON or text to
stdout, so redirect it if you want to keep the numbers.

| Command                                      | Measures                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run benchmark:merge:longmem`            | Merges LongMemEval shard result files into one result set (`merge-longmemeval-shards.ts`).                                     |
| `npm run benchmark:ablate:reverse-retrieval` | Compares reverse-retrieval arms from saved artifacts.                                  |

## Benchmark roles

| Suite               | Primary role                  | NMG mechanisms under test                                                                          |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| NMG core cases      | Fast deterministic regression | storage, provenance, STG/LTG lifecycle, Active Graph budgets, deletion and cache invalidation      |
| LongMemEval         | Main development gate         | extraction, multi-session reasoning, updates, temporal reasoning and abstention                    |
| PersonaMem          | User-memory gate              | automatic fact/preference/constraint writes, evolving profiles, scope and current-state selection  |
| LoCoMo              | Relational-memory gate        | temporal and causal links, multi-hop evidence, node-to-leaf expansion and event summarization      |
| BEAM                | Scale and cache-pressure gate | progressive retrieval, cache misses, maintenance cost and growth from 128K through 10M tokens      |
| Reasoning workspace | Lab scratchpad gate           | explicit task-state retention, Pi compaction recovery, overhead, and unsupported scratchpad claims |
| SkillOpt policy     | Offline policy decision gate  | answer/expand/stop, noise folding, held-out policy selection, matched Pi promotion                 |

The suites are reported separately. Their scores must not be averaged into one
number because they measure different distributions and failure modes.

## Official-protocol benchmark commands

Use the [NMG HTTP workflow](omnimemeval/README.md#run-longmemeval-over-nmg-http)
to generate new OmniMemEval results. Use the existing offline scorers for their
supported NMG prediction artifacts.

```bash
npm run benchmark:score:longmem -- <result-directory>
npm run benchmark:score -- <locomo|personamem|beam> <result-directory>
```

Historical matched local runs and their commands are recorded in the
[archived evaluation guide](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/README.md).

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

OmniMemEval produces and scores HTTP runs through the
[upstream workflow](omnimemeval/README.md#run-longmemeval-over-nmg-http).
For an existing NMG-format `report.json` and `predictions.jsonl`, the offline
score commands above produce `official-score.json`.

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
replay, checkpointing and report generation. Historical local matched Pi runs measured whether the harness triggers recall
and whether the agent uses the returned evidence.

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

The historical local gate compared no-memory, deterministic NMG and controller
shadow on the same cases, prompts and scorer. The four-arm backend ablation and
run settings are in the [archived evaluation guide](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/README.md).

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

Run the installer and simulated NMG HTTP contracts with:

```bash
node --experimental-strip-types --test tests/evals/omnimemeval-install.test.ts tests/evals/omnimemeval-http-client.test.ts
```

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

Historical topology runs use LoCoMo's stable speaker identities.
See the [experiment record](../docs/experiments/topology-gate-evaluation-2026-08-09.md).

`npm run eval:topology:namesakes` optionally reads the official CC BY 4.0
Namesakes Entities JSONL to measure alias-like positive recall and rejection of\nsame-name references to a different entity. This is a read-only audit.
Namesakes data belongs under `.benchmarks/namesakes/data/` and is not committed.
See `docs/experiments/topology-bpid-evaluation-2026-08-09.md` and
`docs/experiments/topology-namesakes-evaluation.md`.

The official LoCoMo scorer uses the environment created by
`npm run benchmark:setup`. If that uv-managed interpreter cannot execute in the
current sandbox, set `NMG_BENCHMARK_PYTHON` to one compatible Python environment
containing the pinned scorer dependencies. NMG uses this single explicit path;
it does not silently fall through across unrelated Python installations.
