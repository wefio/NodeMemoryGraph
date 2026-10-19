# NMG Benchmark Results

[English](benchmark-results.md) | [简体中文](benchmark-results.zh-CN.md) · [Terms](benchmark-results.terms.yaml)

## Reading the historical snapshot

This is a retained partial experiment snapshot, not a current backend leaderboard
or a fresh reproduction. The BEAM version label contains `20260820`; the chain
comparison is labelled 2026-08-16. This review did not reopen run artifacts,
verify the mutable official-results URL, measure provider cost or resume a run.
The embedding guard source view below is separate from those historical scores.

NMG results on the [OmniMemEval](https://github.com/MemTensor/OmniMemEval)
user-memory benchmark suite, recorded in the same format as the official
[results snapshot](https://github.com/MemTensor/OmniMemEval/blob/main/docs/user_memory/results.md)
so that rows are comparable in structure.

Recorded status: **partial**. BEAM 100K is reported complete for the listed
version; the other suites retain the checkpoint states shown below. Their
present progress, checkpoint compatibility and exact resume behavior were not
re-established by this documentation review.

## Evaluation Setup

| Component | Configuration |
| --- | --- |
| Benchmarks | BEAM 100K (complete); LongMemEval, LoCoMo, PersonaMem v2, HaluMem (in progress) |
| Answer model | `deepseek-v4-flash` (OpenCode Go), thinking disabled, `max_tokens=1000` |
| Judge model | `deepseek-v4-flash` (same as answer — see caveats) |
| Memory embeddings | `BAAI/bge-small-en-v1.5` (local service) + built-in `nmg-hashing-v1` |
| Retrieval | Progressive `searchContext`, top-k 20, logical-chain injection (eval-only), idtime rendering (`<A:short-id> [time]` lines) |
| Primary metric | Nugget score for BEAM; LLM-as-a-judge accuracy for the other suites |

**Comparability caveat.** The official OmniMemEval snapshot reproduces all
backends with `gpt-4.1-mini` (answer) + `gpt-4o-mini` (judge). NMG's runs use a
different answer/judge pair, so NMG rows must not be read as head-to-head
comparisons against the official table. They are historical tracking numbers,
not a matched model/prompt/item/cost comparison. Same-model answering/judging is
not independent validation. The two embedding names in the setup row do not
establish per-input routing or automatic provider fallback.

## Result Summary

| Backend | LoCoMo | LongMemEval | BEAM 100K | BEAM 10M | PersonaMem v2 | HaluMem |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **NMG (this run)** | pending | pending | **66.57 +/- 39.51** | - | in progress | pending |
| MemOS (official ref) | 88.83 | 89.20 | 66.87 | 56.75 | 40.58 | 80.91 |
| Hindsight (official ref) | 81.99 | 72.20 | 70.22 | 59.75 | 37.98 | 83.99 |
| Mem0 (official ref) | 77.68 | 56.00 | 70.41 | 43.33 | 36.76 | 73.64 |

Official reference rows are reproduced under gpt-4.1-mini/gpt-4o-mini and are
shown only to position the scale of the numbers, not as direct comparisons
(different judge model).

## BEAM 100K

Reported complete for the listed run version, not rerun on this review's current
checkout. BEAM uses nugget score (1.0 fully covered / 0.5
partial / 0.0 incorrect or missing).

- Version: `nmg_beam100k_full_curlogical_20260820`
- Questions: 400 (20 conversations, ~128K tokens each)
- Deployment: local/self-hosted

### Reproduced Result

This repeats the same historical run as the summary, not an independent
replication. The `+/-` statistic/aggregation unit is not defined in this record;
do not silently read it as a confidence interval.

| Backend | Deployment | 100K Nugget Score | 100K Context Tokens |
| --- | --- | ---: | ---: |
| NMG | local/self-hosted | 66.57 +/- 39.51 | n/a (not recorded) |

### Dimension Breakdown

| Dimension | n | Nugget |
| --- | ---: | ---: |
| preference_following | 40 | 92.50 |
| instruction_following | 40 | 88.12 |
| information_extraction | 40 | 87.92 |
| summarization | 40 | 69.74 |
| contradiction_resolution | 40 | 66.25 |
| multi_session_reasoning | 40 | 64.32 |
| temporal_reasoning | 40 | 61.25 |
| abstention | 40 | 60.00 |
| knowledge_update | 40 | 55.00 |
| event_ordering | 40 | 20.61 |

### Chain-Injection A/B (same harness, 2026-08-16 runs)

Eval-only logical-chain injection over the same stores and parameters:

| Injection | Nugget Score | event_ordering |
| --- | ---: | ---: |
| none | 65.68 +/- 39.34 | 18.92 |
| temporal | 67.55 | 21.73 |
| **logical (default)** | **68.67** | 23.79 |
| both | 56.24 | 2.69 (context bloat) |

Notes:
- The table's logical/default label is a historical evaluation choice
  (about +3.0pp overall vs none), not evidence of current bridge/product defaults. The
  inspected bridge selects logical injection only for explicit
  `NMG_CHAIN_INJECTION=logical`, otherwise none; temporal/both are old trial rows,
  not current entry-point options.
- The displayed temporal `event_ordering` is 21.73 versus 18.92 without injection,
  so "does not move it" is not a literal description of this table. These runs
  do not isolate a universal narrative-reconstruction ceiling or establish that
  time information is redundant. The original rationale also cited rendering
  experiments (6 modes, 2026-08-16) and the per-line `[time]` tag; those separate
  observations are not a controlled causal decomposition. The original record
  did not pursue that line.
  Its `context bloat` explanation for the both row is not causally established
  by this review. A/B sample sizes and comparable spread estimates are absent.
- `summarization` moved 46.52 → 69.74 across different run sets (the 2026-08-16
  no-chain baseline and this full run), with both injection and retrieval-code
  changes. That is not an isolated chain effect. The A/B logical score 68.67 and
  full-run score 66.57 are separate readings, not reconciled replications here.
  The original record calls for repeat confirmation before claiming the gain;
  this review neither supplies nor authorizes that confirmation.

## In-Progress Suites

The following are reported checkpoint states, not newly inspected resume
receipts. Local ingestion/search still consume compute/storage and may call a
configured embedding provider; "local" does not guarantee zero monetary cost.
Answer/judge stages also require their own LLM budget:

| Suite | Progress | Resume |
| --- | --- | --- |
| LongMemEval (500 q) | ingestion+search complete (local) | `run_lme_eval.sh --from-step 3` |
| LoCoMo (1,540 q) | not started | `run_locomo_eval.sh` (ingest/search local first) |
| PersonaMem v2 (1,315 q) | ingestion+search complete; 113 answers checkpointed | `run_pmv2_eval.sh --from-step 3` |
| HaluMem (Medium) | previous trials only (2026-08-11) | full run pending |

## Reproduction

The preserved shell block is historical, not the normal current NMG entry.
For an authorized new/resumed run, first follow the
[config-driven workflow](../../.pi/skills/omnimemeval-eval/SKILL.md), which owns
checkpoint/configuration checks and the runner entry. The commands below can
invoke paid answer/judge stages; this documentation review grants no run budget
and executed none of them.

```bash
# BEAM 100K (complete result above)
cd .benchmarks/official/OmniMemEval
PYTHONUTF8=1 NMG_CHAIN_INJECTION=logical \
  bash scripts/run_beam_eval.sh --lib nmg --env .env.nmg-opencode \
  --version <version-label>

# Remaining suites share the same entry points
./scripts/run_lme_eval.sh   --lib nmg --env .env.nmg-opencode --from-step 3
./scripts/run_locomo_eval.sh --lib nmg --env .env.nmg-opencode
./scripts/run_pmv2_eval.sh  --lib nmg --env .env.nmg-opencode --from-step 3
./scripts/run_halumem_eval.sh --lib nmg --env .env.nmg-opencode
```

The NMG adapter bridge lives at `evals/omnimemeval/bridge.ts`; per-user stores
under `.benchmarks/omnimemeval-nmg/`, shared embedding cache at
`.benchmarks/shared-embedding-cache.sqlite`.

### Embedding availability contract

The shared cache is an acceleration layer, not a provider fallback. An exact
cache hit can succeed while the configured embedding service is offline, so a
mixture of successful and `fetch failed` rows does **not** establish that the
service failed partway through a run. In the inspected
[`runPlan()` entry](../../evals/omnimemeval/run.ts), a configured provider is probed
by attempting one `embedQueries` call with one query before the runner is
spawned; invalid client configuration can fail before provider I/O. Cache-only mode or no configured
provider skips that probe. A successful probe establishes point-in-time
availability, not health throughout a run, and this guard must not be assumed
for every historical direct upstream-shell invocation.

`NMG_EMBED_CACHE_ONLY=1` is the explicit offline exception. It disables provider
embedding-provider I/O and serves only cached vectors under the declared
model/preprocessing `indexId`, input kind and text hash. The first required
document/query miss fails closed with an `embedding cache-only miss` error;
coverage must include the inputs needed by that run. A partial checkpoint is
not a complete benchmark result. This is embedding-only offline operation, not
a promise that answer/judge stages or the entire evaluation make no network calls.
