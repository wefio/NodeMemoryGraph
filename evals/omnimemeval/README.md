# OmniMemEval integration

OmniMemEval is NMG's preferred upstream harness for public user-memory
benchmarks. It already runs LongMemEval, LoCoMo, BEAM, PersonaMem v2 and
HaluMem through a shared lifecycle:

```text
benchmark data
  -> add(messages, user_id)
  -> memory backend
  -> search(query, user_id, top_k)
  -> answer model
  -> official/dataset scorer
  -> report
```

## Integration boundary

NMG should contribute a thin Python client in OmniMemEval's
`scripts/client_factory` registry. The client is an adapter, not a second NMG
implementation. It forwards:

- `add(...)` to session/history ingestion and memory extraction;
- `search(...)` to budgeted NMG recall and returns plain-text context;
- cleanup to deletion of the benchmark user's isolated namespace.

The adapter should call a stable local NMG HTTP or CLI boundary. It must not
reach into SQLite tables, duplicate graph logic in Python, or make benchmark
semantics part of NMG core.

For user-memory questions, the bridge requests user-attributed evidence by
default so long unverified assistant replies do not crowd out the user's
history. Queries that explicitly ask about the assistant or a previous chat
use both actors, preserving LongMemEval's assistant-memory category. This uses
the generic `SearchOptions.sourceActor` boundary rather than SQL access.

The current adapter uses a persistent NDJSON subprocess rather than an HTTP
service. Install it into the pinned ignored checkout with:

```powershell
npm run benchmark:setup
npm run benchmark:install:omni-adapter
$env:NMG_ROOT = (Get-Location).Path
```

Then use `--lib nmg` in OmniMemEval's user-memory commands. OmniMemEval declares
its own Python 3.12 environment; NMG's smaller Python 3.11 official-scorer
environment is deliberately not reused.

The installer also registers NMG with OmniMemEval's generic text-search
dispatcher, LoCoMo's benchmark-local search dispatcher, and the conversation-ID
helper. OmniMemEval currently keeps these allowlists separately from its
central client registry, so copying only `nmg_client.py` is insufficient.

## Current official smoke results

### LongMemEval

A seven-conversation streaming smoke (`nmg_smoke7_20260728`, conversation
indices 0--6) exercised OmniMemEval's official add/search/delete lifecycle,
then used `deepseek-chat` (`deepseek-v4-flash`, temperature 0) for both answer
generation and judging. A matched no-memory artifact preserved the same seven
questions and prompts while clearing all retrieved context.

| Arm | LLM-as-Judge | Context tokens / question | Search mean / P95 |
| --- | ---: | ---: | ---: |
| NMG, K=20 | **0.7143** (5/7) | 1,046 | 152 / 160 ms |
| No memory | 0.0000 (0/7) | 270 | 0 / 0 ms |

All seven NMG units completed ingestion, retrieval, cleanup, answering, and
judging without failures. The two misses were the expected answers `Target`
and `Serenity Yoga`; the reader explicitly reported that the retrieved context
did not contain the requested location, so these are retrieval/evidence
coverage failures rather than answer-generation failures. This sample is a
pipeline smoke, not a statistically meaningful benchmark result.

The first baseline attempt exposed a harness bug: the transformer cleared
LoCoMo's `context` fields but retained LongMemEval's `search_context`.
`prepare-no-memory.ts` now clears both schemas and resets both duration fields;
a regression test protects the matched-baseline invariant.

### LoCoMo

The pinned LoCoMo search-only smoke ingested all 272 sessions for the ten
official conversations in about 3 seconds, then completed all 1,540 category
1--4 queries in 54 seconds with ten workers and no search failures. Per-query
backend latency was 329 ms mean, 267 ms P50, 619 ms P95, and 670 ms P99. The
returned context averaged 4,152 characters (5,054 at P95).

An exact normalized-text audit against LoCoMo's official evidence IDs found at
least one labelled evidence turn for 952/1,540 questions (61.8%), all labelled
turns for 764/1,540 (49.6%), and 1,059/2,355 labelled turns overall (45.0%).
This is a retrieval diagnostic rather than an official answer score: paraphrased
memories can be useful without exact text, while categories 1 and 3 often need
multiple turns or inference. The next comparable result must therefore run
OmniMemEval's official answer and scoring stages with a fixed reader model and
matched baseline, rather than optimizing to this auxiliary audit.

A matched retrieval-budget ablation rebuilt an isolated benchmark namespace for
each setting:

| Top K | Any evidence | All evidence | Evidence recall | Mean context chars | Mean / P95 latency |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 48.1% | 40.6% | 32.7% | 1,042 | 233 / 496 ms |
| 10 | 55.7% | 46.0% | 39.0% | 2,064 | 256 / 548 ms |
| 20 | 61.8% | 49.6% | 45.0% | 4,152 | 329 / 619 ms |
| 40 | 63.6% | 51.0% | 46.6% | 4,877 | 325 / 609 ms |

`top_k=20` remains the default knee point. Doubling to 40 recovers only 1.6
additional evidence-recall points while increasing context by 17.5%. Multi-hop
and open-domain evidence recall at K=40 remains only 28.8% and 15.5%, so their
main limitation is ranking/composition rather than an undersized output budget.
The larger default was rejected.

OmniMemEval includes `version` in benchmark user IDs and resumes existing search
artifacts. Budget ablations must therefore use a fresh version for both
ingestion and search; changing only the search version queries an empty
namespace, while reusing a failed version replays its cached results.

The initial LoCoMo rendering dropped NMG's stored `eventTime`. A retrieved turn
such as "I went ... yesterday" therefore lacked the session date needed to
derive the official answer. The bridge now prefixes event time only for
queries containing temporal language or an explicit year. On a fresh K=20 run,
all 450 retrieved labelled evidence turns for those queries carried their date
anchor. Retrieval ordering and exact evidence recall were unchanged. The
selective rendering affected 663/1,540 questions, adding 691 characters on
average to those questions and zero to the rest (about 297 characters averaged
over the complete benchmark). This restores information already present in NMG
without globally expanding context.

## Official LoCoMo answer-stage results

Evaluation discipline for all NMG answer-stage runs:

1. **Fixed weak reader/judge.** All comparable scores use `deepseek-chat`
   (v4-flash) at temperature 0 for both answering and judging. A weak reader
   keeps attribution clean — it cannot compensate for missing evidence from
   parametric knowledge — and matches the cheap-model reality of Pi users.
2. **Always run the matched no-memory baseline.** Report the delta over
   `no_memory`, not the absolute score. Absolute scores drift with judge and
   harness versions; the delta is the memory system's actual contribution.
3. **External leaderboards are context only.** OmniMemEval's reproduced table
   and vendor self-reports use different readers, judges, prompts, and budgets
   (vendors' own numbers run 15--30 points above OmniMemEval's reproduction).
   We do not tune to them or reproduce them.

The first official answer and scoring pass compared the K=20 record-vector
NMG run (`timefinal`) against the matched no-memory baseline
(`no_memory_timefinal`). Both used the same fixed reader and judge:
`deepseek-chat` (DeepSeek API, currently `deepseek-v4-flash`) at temperature 0
through `ANSWER_*`/`EVAL_*` in `.env.nmg`. All 1,540 questions were answered in
both runs; one judge call per run was skipped under `--skip-failed-judge 1`
because the judge wrapped its label JSON with an explanation that upstream's
strict `extract_label_json` regex rejects.

| Version | LLM-as-Judge | F1 | ROUGE-L | METEOR |
| --- | ---: | ---: | ---: | ---: |
| NMG (record vectors K=20) | **0.6173** | 0.3424 | 0.3573 | 0.3664 |
| No-memory lower bound | 0.1741 | 0.1309 | 0.1254 | 0.1166 |

| Category | NMG | No memory | Questions |
| --- | ---: | ---: | ---: |
| single hop | 0.6813 | 0.2093 | 841 |
| temporal reasoning | 0.6854 | 0.0592 | 321 |
| multi hop | 0.4184 | 0.1423 | 282 |
| open domain | 0.4105 | 0.3438 | 96 |

NMG beats the matched baseline by 44.3 judge points overall. Temporal
reasoning gains the most (+62.6 points), validating the selective event-time
rendering. Multi-hop remains the weakest memory category (0.4184), matching
the retrieval audit's finding that multi-hop evidence recall is limited by
ranking/composition rather than budget. Open-domain questions gain only 6.7
points because many are answerable from parametric knowledge.

A full-pipeline rerun (`records_k20_r2`, all six steps, fresh namespace)
after the polarity-metadata schema change (`confidence`, `polarity`,
`predicate_key`, `extract_method` columns on `memory_records`) confirmed no
regression: LLM-as-Judge 0.6480 overall (single hop 0.6908, temporal 0.6875,
multi hop 0.5179, open domain 0.5208; 1,537/1,540 judged, 3 judge skips).
The delta over `timefinal` partly reflects regenerated search results rather
than code changes, so it is read as "no regression, positive direction", not
as a measured improvement.

Reproduce with (Python 3.12 venv at `.benchmarks/omni-venv`, `PYTHONUTF8=1`):

```powershell
bash scripts/run_locomo_eval.sh --lib nmg --env .env.nmg --version no_memory_timefinal --from-step 3 --skip-failed-judge 1
bash scripts/run_locomo_eval.sh --lib nmg --env .env.nmg --version timefinal --from-step 3 --skip-failed-judge 1
```

Environment notes: NLTK `punkt_tab`/`wordnet` had to be fetched manually into
`~/nltk_data` because the local network blocks nltk's downloader; the judge
stage resumes completed groups from `nmg_locomo_judged.json`, so transient API
errors are retried cheaply by rerunning step 4.

## Embedding-granularity ablation

A matched LoCoMo K=20 retrieval ablation used the locally cached
`BAAI/bge-small-en-v1.5` model (384 dimensions) through the small offline
benchmark server in `bge_server.py`. Vectors remained in each user's SQLite
database; no vector database or vLLM server was introduced.

With the model already present in the Hugging Face cache, the local server is:

```bash
uv run --offline evals/omnimemeval/bge_server.py
```

Set `NMG_EMBED_BASE_URL=http://127.0.0.1:8000/v1`,
`NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5`, and
`NMG_EMBED_PROFILE=bge-en` in the OmniMemEval environment file.

| Retrieval path | Any evidence | All evidence | Evidence recall | Mean context chars | Mean / P95 latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS5 lexical | 61.8% | 49.4% | 45.1% | 4,450 | 327 / 637 ms |
| Node + leaf summaries (5 nodes) | 23.8% | 17.9% | 16.4% | 3,335 | 281 / 342 ms |
| Node + leaf summaries (10 nodes) | 26.1% | 19.7% | 18.0% | 3,359 | 312 / 371 ms |
| Record vectors | **68.0%** | **54.1%** | **52.9%** | 4,458 | 314 / 361 ms |
| Node + leaf + record union | 25.7% | 19.4% | 17.7% | 3,358 | 568 / 647 ms |

The compressed hierarchy is therefore not accepted as the sole evidence
retrieval index. Its summaries discard distinctions needed by LoCoMo, and the
current union ranking lets coarse routes crowd out stronger record candidates.
For the benchmark bridge, an enabled embedding provider defaults to record
granularity. Node and leaf vectors remain useful as a bounded directory or a
future large-scale routing stage, but they must not replace fine-grained
evidence retrieval until a matched experiment demonstrates equal or better
recall.

The record-vector path improves overall evidence recall by 7.8 points without
increasing mean context size or mean latency. Category 1 and 3 recall rises
from 26.9% to 40.4% and from 14.7% to 28.4%, respectively. Initial per-user
index construction does create a P99 latency spike (about 2.3 seconds), so
production indexing should remain asynchronous or incremental rather than
occurring on the first user query.

## BEAM 100K retrieval experiment

The official OmniMemEval streaming runner completed all 20 BEAM 100K
conversations and 400 probing questions at K=20. The auxiliary audit matches
the benchmark's `source_chat_ids` against exact normalized source messages;
it is a retrieval diagnostic, not the official Nugget Score.

| Retrieval path | Any evidence | All evidence | Evidence recall | Mean context chars | First query | Steady P50 / P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FTS5, user-first actor policy | 58.3% | 27.9% | 26.2% | 3,451 | 146 ms | 9 / 15 ms |
| BGE records, lazy first-query index | 65.9% | **34.4%** | **32.9%** | 3,099 | 2,102 ms | 41 / 62 ms |
| BGE records, incremental add-time index | **66.2%** | 33.8% | 32.8% | 3,118 | **193 ms** | **40 / 51 ms** |

Record vectors therefore generalize beyond LoCoMo: they gain 6.7 evidence
recall points on BEAM while returning slightly less text. They are retained.
The current exact vector scan is still adequate at 100K scale, but lazy
per-user construction is not: first-query latency averages 2.1 seconds.
Incremental add-time indexing preserved retrieval quality while reducing mean
first-query latency from 2,102 to 193 ms. Across 90 session add calls, embedding
increased aggregate ingestion time from 7.0 to 42.3 seconds, but total
add-plus-search time for all 20 conversations still fell from 73.0 to 68.9
seconds. The shared incremental synchronizer is therefore accepted:
OmniMemEval awaits it after each add, while Pi schedules the same operation in
the background after turns and continues using FTS until the index is ready.

BEAM also exposed an actor-routing trade-off. Of 1,094 labelled evidence
messages, 253 are assistant messages. Searching all actors in one shared K=20
pool reduced evidence recall to 13.3% and expanded mean context to 8,176
characters. Reserving 4/20 slots for assistant messages produced 26.1% recall,
essentially no gain over the 26.2% baseline, while nearly doubling context and
steady latency. Both variants were rejected; the experimental routing code was
removed rather than added to NMG.

Run the audit with:

```powershell
npm run benchmark:audit:beam -- `
  .benchmarks/official/OmniMemEval/data/beam/beam_100k.json `
  <one-or-more-search-result.json>
```

Reproduce the exact-text evidence audit with:

```powershell
npm run benchmark:audit:locomo -- `
  .benchmarks/official/OmniMemEval/data/locomo/locomo10.json `
  <one-or-more-search-result.json>
```

OmniMemEval does not ship a user-memory `no-memory` backend. For an internal
matched lower bound, transform an existing search artifact while preserving its
questions and ordering:

```powershell
npm run benchmark:prepare:no-memory -- `
  .benchmarks/official/OmniMemEval/results/locomo/nmg-nmg_smoke/nmg_locomo_search_results.json `
  .benchmarks/official/OmniMemEval/results/locomo/nmg-no_memory/nmg_locomo_search_results.json
```

Run the official response and scoring stages with `--lib nmg --version
no_memory`. This baseline changes only the retrieved context and search cost;
the official question set, answer prompt, reader, and judge remain identical.
It is an internal lower bound, not an OmniMemEval memory-backend leaderboard
entry.

## Two evaluation boundaries

OmniMemEval's user-memory runner forcibly calls the selected backend's
`search()`. It therefore measures NMG ingestion, retrieval, deletion, evidence
coverage and cost. It does not test whether Pi decides to recall memory or uses
the result correctly. The local matched Pi runner remains the end-to-end
harness gate.

For comparable backend runs:

1. use the same fixed LongMemEval question IDs as the local matched run;
2. use the same reader and judge configuration when answer stages are enabled;
3. compare evidence recall, token injection and latency;
4. verify per-user isolation and cleanup;
5. verify that every returned memory remains traceable to NMG evidence.

On Windows, set `PYTHONUTF8=1` before invoking the upstream runner.

## Deliberate non-goals

- Do not vendor OmniMemEval into NMG core.
- Do not maintain five separate NMG benchmark adapters.
- Do not adopt the heavier AgentBench/OpenClaw agent-memory track for Pi.
- Do not add another embedding or storage implementation solely for the
  harness; it must exercise the same NMG configuration used by Pi.
