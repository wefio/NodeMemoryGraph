# NMG Benchmark Results

NMG results on the [OmniMemEval](https://github.com/MemTensor/OmniMemEval)
user-memory benchmark suite, recorded in the same format as the official
[results snapshot](https://github.com/MemTensor/OmniMemEval/blob/main/docs/user_memory/results.md)
so that rows are comparable in structure.

Status: **partial**. One benchmark (BEAM 100K) has a complete current-code run;
the remaining suites are mid-pipeline with checkpoints and resume from exactly
where they stopped.

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
comparisons against the official table; they are same-harness,
different-judge-model numbers recorded for tracking.

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

Complete run, current code. BEAM uses nugget score (1.0 fully covered / 0.5
partial / 0.0 incorrect or missing).

- Version: `nmg_beam100k_full_curlogical_20260820`
- Questions: 400 (20 conversations, ~128K tokens each)
- Deployment: local/self-hosted

### Reproduced Result

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
- Logical chains are the retained default (+3.0pp overall vs none); temporal
  chains are redundant with the per-line `[time]` tag.
- `event_ordering` is bounded by narrative-reconstruction ability, not by time
  information: rendering experiments (6 modes, 2026-08-16) and temporal-chain
  injection both show that adding time ordering does not move it. Not pursued.
- `summarization` moved 46.52 → 69.74 between the 2026-08-16 no-chain baseline
  and this run; the gain coincides with logical-chain injection plus current-code
  retrieval changes and should be re-confirmed on a repeat run before being
  claimed.

## In-Progress Suites

All remaining suites are checkpointed and resume without redoing completed
local stages (ingestion/search are local and free; answer/judge need LLM
budget):

| Suite | Progress | Resume |
| --- | --- | --- |
| LongMemEval (500 q) | ingestion+search complete (local) | `run_lme_eval.sh --from-step 3` |
| LoCoMo (1,540 q) | not started | `run_locomo_eval.sh` (ingest/search local first) |
| PersonaMem v2 (1,315 q) | ingestion+search complete; 113 answers checkpointed | `run_pmv2_eval.sh --from-step 3` |
| HaluMem (Medium) | previous trials only (2026-08-11) | full run pending |

## Reproduction

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
service failed partway through a run. Before the official runner starts, the NMG
entry point sends one real query embedding request and fails before dataset work
if the provider is unavailable.

`NMG_EMBED_CACHE_ONLY=1` is the explicit offline exception. It disables provider
I/O and serves only vectors already present under the exact model and
preprocessing `indexId`; the first document or query miss fails closed with an
`embedding cache-only miss` error. Use it only when cache coverage is known to be
complete. Never interpret partial cache coverage as a valid benchmark result.
