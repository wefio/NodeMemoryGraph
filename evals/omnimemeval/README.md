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

A seven-conversation streaming smoke (`nmg_smoke7_fix_20260728`, conversation
indices 0--6) exercised OmniMemEval's official add/search/delete lifecycle,
then used `deepseek-chat` (`deepseek-v4-flash`, temperature 0) for both answer
generation and judging. A matched no-memory artifact preserved the same seven
questions and prompts while clearing all retrieved context.

| Arm | LLM-as-Judge | Context tokens / question | Search mean / P95 |
| --- | ---: | ---: | ---: |
| NMG, K=20 | **0.8571** (6/7) | 1,150 | 152 / 160 ms |
| No memory | 0.0000 (0/7) | 270 | 0 / 0 ms |

All seven NMG units completed ingestion, retrieval, cleanup, answering, and
judging without failures. The earlier run missed both `Target` and `Serenity
Yoga` because retrieval applied a per-node evidence cap. Retrieval now uses only
shared Active Graph budgets: records from one node compete with records from
other nodes by relevance, token cost, and remaining budget. This recovers
`Serenity Yoga`. `Target` remains a weak-reader composition miss even though
both same-session clues are present in the returned context. This sample is a
pipeline smoke, not a statistically meaningful benchmark result.

### LongMemEval full result

A fresh full streaming run (`nmg_lme500_fixed_20260728`) completed the official
add/search/delete lifecycle for all 500 LongMemEval conversations. The matched
baseline (`no_memory_lme500_fixed_20260728`) preserves the same questions,
golden answers, reader, judge, and prompts while removing only retrieved
context. Both arms used `deepseek-chat` (currently `deepseek-v4-flash`) at
temperature 0 with `top_k=20`.

| Arm | LLM-as-Judge | F1 | METEOR | Answer prompt tokens / question | Search mean / P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| NMG | **0.6404** (317/495) | 0.1544 | 0.2124 | 1,138 | 156 / 175 ms |
| No memory | 0.0646 (32/495) | 0.0853 | 0.0904 | 278 | 0 / 0 ms |

The absolute NMG gain is **+57.6 judge points**. Search and answer stages
completed 500/500 in both arms. The official judge accepted 495/500 outputs in
each arm; five outputs per arm were skipped through OmniMemEval's documented
`--skip-failed-judge 1` path because DeepSeek returned a JSON object containing
both `label` and `explanation`, while upstream's strict parser accepts only its
narrow label format. The skipped question sets differ. On the 490 questions
successfully judged in both arms, NMG scores 0.6408 (314/490) versus 0.0653
(32/490), so the matched-subset result is unchanged.

| Category on common 490 | NMG | No memory | Questions |
| --- | ---: | ---: | ---: |
| single-session user | **0.9714** | 0.0857 | 70 |
| temporal reasoning | **0.7519** | 0.0620 | 129 |
| knowledge update | **0.7692** | 0.0769 | 78 |
| multi-session | **0.5227** | 0.0909 | 132 |
| single-session assistant | **0.2857** | 0.0000 | 56 |
| single-session preference | **0.1600** | 0.0000 | 25 |

The result shows a large end-to-end memory benefit with the fixed weak reader,
but also identifies the next quality targets: assistant memories, preferences,
and multi-session evidence composition. The 860-token average prompt increase
over no memory is the approximate retrieval-context cost.

The auxiliary exact-text evidence audit makes that diagnosis more concrete.
Of 479 questions with labelled evidence, NMG retrieves at least one evidence
turn for 79.96%, all evidence turns for 62.63%, and 69.42% of labelled turns
overall. User evidence recall is 72.92%, but assistant evidence recall is only
14.81%. When all labelled evidence is present, answer accuracy is 89.67%;
with only partial evidence it falls to 16.67%, and with no exact evidence to
7.45%. This strongly points to retrieval coverage and multi-record composition,
rather than reader capacity alone, as the main remaining bottleneck. This
audit is deliberately strict and is not an official LongMemEval score.

The assistant category was then isolated as a 56-question diagnostic. Expanding
the high-confidence assistant-recall cue from the literal words `assistant`,
`you said`, and `previous chat` to ordinary references such as `you
recommended`, `your answer`, and `previous conversation` retrieved exact
evidence for 46/56 questions (82.14%): assistant evidence recall rose from
14.81% in the full run to 43/51 (84.31%) in the isolated category. With the
same DeepSeek reader and official judge, accuracy rose from 16/56 (28.57%) to
48/56 (85.71%). The cue fired for 55/56 assistant-category questions and none
of the other 444 LongMemEval questions.

An additional experiment embedded each assistant reply together with its
preceding user prompt. It reached 47/56 exact hits, but assistant evidence
recall remained 43/51 while mean context grew from 6,792 to 7,503 characters
and mean search latency grew from 172 to 191 ms. The paired representation was
therefore rejected. NMG retains raw turn-level evidence and actor metadata.
Query-intent cues choose the actor search scope; they do not rewrite evidence.

The 30-question preference category exposed a separate two-stage failure.
Lexical retrieval recalled only 31.82% of labelled evidence. Record-level
`BAAI/bge-small-en-v1.5` embeddings raised exact evidence recall to 86.36%,
with at least one labelled turn for 93.33% of questions and all labelled turns
for 83.33%. However, the weak reader often refused to apply retrieved
preferences to a new request because the requested recommendation did not
appear verbatim in history. A short retrieval header now tells the reader to
treat retrieved facts, preferences, constraints, tools, and experiences as
evidence for personalization without inventing user details.

Three matched answer-and-judge runs over the same stored contexts averaged
40.2% accuracy without that header and 53.3% with it, a stable gain of about
13.1 points. The header added about 278 context characters per question. A
longer instruction that explicitly demanded actionable recommendations did not
improve the result and was rejected. Remaining misses on generic questions,
such as requests for broadly relevant publications or conferences, motivate a
query-independent consolidated preference/profile representation; they do not
justify more benchmark-specific prompt rules.

The record-level BGE path was then evaluated on the complete 500-question
LongMemEval set (`nmg_lme500_bge_merged_20260728`). All 500 searches and answer
calls succeeded; the official judge accepted 491 answers. It scored **0.7963**
(391/491), with lexical F1 0.1754 and METEOR 0.2456. The strict evidence audit
found at least one labelled turn for 94.15% of questions, every labelled turn
for 81.63%, and 87.28% recall over all labelled turns. Assistant and user
evidence recall were 85.19% and 87.41%, respectively.

On the 482 questions successfully judged in the BGE, lexical NMG, and
no-memory runs, the scores were:

| Arm on common 482 | Accuracy | Correct |
| --- | ---: | ---: |
| NMG + record BGE | **0.8008** | 386 |
| NMG lexical/FTS | 0.6473 | 312 |
| No memory | 0.0664 | 32 |

BGE versus lexical NMG produced 96 wins, 22 losses, and 364 ties, a net gain of
74 questions. Against no memory it produced 356 wins, 2 losses, and 124 ties.
The gain tracks evidence completeness: BGE answers were correct for 88.80% of
questions with all labelled evidence, 36.05% with partial evidence, and 25.00%
with none.

This quality result does not yet satisfy the latency goal. Full-run search
latency was 12.91 seconds mean, 13.13 seconds P50, and 14.28 seconds P95,
compared with roughly 156/175 ms mean/P95 for the lexical run. The BGE run
builds each isolated user's record index on its first query, so these numbers
mostly measure cold per-user embedding construction rather than warm ANN
lookup. The answer prompt averaged 1,114 reported tokens per question. Future
performance work must report cold indexing and warm retrieval separately and
must not trade away the measured evidence-recall gain.

On the Windows evaluation host, the offline BGE server is run from the existing
`uv` script environment. Installing the CUDA PyTorch wheel into that environment
reduced the 30-question search run from roughly 50--75 seconds per question on
CPU to about four seconds per question during indexing. This is local evaluation
acceleration only: GPU PyTorch, WSL, and `uv` are not NMG runtime dependencies.

Reproduce the diagnostic with:

```powershell
npm run benchmark:audit:longmem -- `
  .benchmarks/official/OmniMemEval/results/lme/nmg-nmg_lme500_bge_merged_20260728/nmg_lme_search_results.json `
  .benchmarks/official/OmniMemEval/results/lme/nmg-nmg_lme500_bge_merged_20260728/nmg_lme_judged.json
```

The first full attempt was invalid: 446 conversations were marked `skipped`
after the Windows Python-to-Node NDJSON adapter encountered non-ASCII corpus
content. The NMG adapter now emits ASCII-escaped JSON, which preserves Unicode
content while making the pipe portable. The fresh run has 500 `success`
search records, zero search errors, and zero empty contexts. Never compare or
score the invalid `nmg_lme500_20260728` artifact.

The first baseline attempt exposed a harness bug: the transformer cleared
LoCoMo's `context` fields but retained LongMemEval's `search_context`.
`prepare-no-memory.ts` now clears both schemas and resets both duration fields;
a regression test protects the matched-baseline invariant.

### PersonaMem v2

The first complete PersonaMem v2 run used record-level
`BAAI/bge-small-en-v1.5` retrieval and completed 200/200 personas and
5,000/5,000 questions without search or answer failures. With the fixed
DeepSeek v4 Flash reader it scored **34.44%** overall:

| Category | Accuracy |
| --- | ---: |
| sensitive preference | 28.57% |
| ask to forget | 12.88% |
| health / medical | 43.84% |
| neutral | 39.98% |
| therapy | 36.68% |
| anti-stereotypical preference | 41.40% |
| stereotypical preference | 49.72% |

The low `ask_to_forget` score exposed a semantic error rather than a capacity
problem. Deleting the active preference removed stale evidence but also removed
the fact that a revocation boundary existed. It improved the 1,048-question
category only to **14.12%**. The OmniMemEval adapter prototype now represents
logical forgetting as a searchable constraint:

```text
[forget] the revoked fact or preference
```

The original active memory is soft-deleted, the immutable source history
remains auditable, and retrieval guidance tells the reader that `[forget]`
content is not an active fact and must not be reconstructed or used. A distinct
physical-delete operation remains necessary for privacy erasure; the logical
marker is not a substitute for deleting user data. Promotion into NMG core and
Pi requires a typed revocation API rather than parsing benchmark text in the
store.

Two matched diagnostics validate this representation:

| `ask_to_forget` arm | Accuracy | Delta vs deletion-only | Search path |
| --- | ---: | ---: | --- |
| deletion only | 14.12% | -- | record BGE |
| NMG `[forget]`, real end-to-end | **16.22%** | +2.10 | FTS5 |
| NMG `[forget]`, nearest-tag ablation | **20.52%** | +6.40 | BGE nearest revocation |

The end-to-end FTS run completed all 200 persona lifecycles and all 5,000
searches. Every one of the 1,048 forget questions retrieved at least one
`[forget]` marker (1.15 markers per question on average, maximum four), with
46 ms mean, 27 ms P50, and 297 ms P95 search latency. Against deletion-only it
produced 64 answer wins, 42 losses, and 942 ties (exact paired binomial
`p=0.0409`). The nearest-tag diagnostic produced 102 wins, 35 losses, and 911
ties (`p<1e-8`), showing that revocation routing precision remains the main
quality bottleneck.

Both answer passes used the official PersonaMem response and metric scripts,
the same 1,048 questions, and DeepSeek v4 Flash at temperature zero with 64
concurrent workers. They completed in 93 and 98 seconds without API failures.
The nearest-tag arm is an answer-stage ablation, not an end-to-end leaderboard
result: `personamem-forget-tag-ablation.py` selects the closest explicit
revocation from the original persona with BGE. A complete record-BGE NMG rerun
is still required before claiming the 20.52% score as backend performance.

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
seconds. The shared incremental synchronizer is therefore accepted, but the
OmniMemEval adapter now accumulates pending records across a benchmark user's
session adds and flushes them as one or more batches immediately before search.
This preserves a ready index at retrieval time without issuing dozens of tiny
embedding requests for LongMemEval conversations. Pi separately schedules the
same synchronizer in the background after turns and continues using FTS until
the index is ready.

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
