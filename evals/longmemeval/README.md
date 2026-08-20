# LongMemEval adapter

The local data directory contains the official cleaned LongMemEval-S and oracle
files and is intentionally ignored by Git.

Run one deterministic example from each of the seven benchmark categories:

```powershell
npm run eval:longmem -- validate 1
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
npm run eval:longmem -- matched 1
npm run benchmark:score:longmem -- <result-directory>
```

The final command scores existing predictions with LongMemEval's task-specific
official prompt semantics using DeepSeek V4 Flash as the temporary judge. It
does not rerun the reader and is labelled non-leaderboard-comparable.

The final argument is the number of examples per category. Selection always
comes from the ordering in `longmemeval_s_cleaned.json`, so every mode uses the
same question IDs. Each answer is judged by a fresh DeepSeek V4 Flash session;
an empty judge response is retried once.

For a checked-in, order-independent sample and repeated reader trials, use:

```powershell
$env:NMG_LONGMEM_SAMPLE_FILE = "evals/longmemeval/samples/development-v1.json"
$env:NMG_LONGMEM_REPEATS = "3"
npm run eval:longmem -- validate 1
npm run eval:longmem -- matched 1
```

The manifest takes precedence over the positional per-category count. Every
repeat gets an isolated NMG database so access statistics from an earlier trial
cannot change a later trial. Reports include Wilson 95% accuracy intervals and
paired win/loss/tie counts against `no-memory`, matched by question and repeat.
They also separate per-mode answer latency from deterministic NMG ingestion and
embedding-index preparation time. Each NMG arm receives an independent copy of
the same deterministic seed corpus. Multi-arm runs rotate execution order
deterministically by question and repeat so provider cold-start cost is not
always charged to the same arm. `tokenUsageByMode` reports provider input,
output, cache-read, cache-write, and total token accounting separately from
latency. `answerTimingByMode` separately reports Pi startup, total prompt wall
time, assistant model-stream time, tool execution time, and shutdown time.
`injectedContextByMode` reports mean characters and an explicitly approximate
four-characters-per-token estimate; it is not presented as provider tokenization.
NMG search sections remain in each row's `memoryPerformance`, while corpus
ingestion and embedding-index construction remain in `preparations`.

Answer correctness and retrieval sufficiency are scored independently. The
retrieval judge sees only the context actually injected by `raw-session`,
`flat-hybrid`, or `oracle`, or the successful `nmg_get` output for explicit NMG
modes. Reports include `retrievalByMode` and a pipeline matrix that distinguishes
"sufficient evidence, wrong answer" from a true retrieval miss. Pi does not
expose automatically injected recall through RPC, so the evaluator reconstructs
the compact injected headers from the persisted retrieval trace. For explicit
`nmg_get`, official LongMemEval session recall is computed from the exact memory
IDs actually loaded and their immutable `sourceRef` values. Reports expose this
separately as `officialRetrievalByMode`; the LLM retrieval judge remains a
diagnostic sufficiency measure rather than the official evidence metric.
`durationMs` measures the answer call only; `evaluationDurationMs` also includes
the two independent judge calls.

Every answer row also records `toolCallCount` and `toolRounds`; a round is one Pi
model turn that returned at least one tool result. The separate official scorer
adds binary `taskSuccess` plus typed session-ID evidence any/all/recall/NDCG. It
then audits same-question/same-repeat deterministic and candidate arms. Because
the current `nmg-shadow` arm cannot change ranking, the expected result is
`matchedProduct.metrics: null` with the
`candidate_does_not_affect_ranking` blocker. This proves the measurement path,
not controller activation quality.

The retrieval judge is enabled by default. Set
`NMG_LONGMEM_RETRIEVAL_JUDGE=off` for lower-cost throughput runs; retrieval and
pipeline summaries will then be unavailable while answer scoring remains intact.

The runner defaults to four concurrent questions and a five-minute model-call
timeout. Override these with `NMG_LONGMEM_CONCURRENCY` and
`NMG_LONGMEM_TIMEOUT_MS`. A single answer timeout is recorded on that row rather
than discarding the whole experiment; judge failures receive one fresh retry.

## Modes

- `no-memory`: the reader receives only the question and date.
- `nmg-auto`: the natural question relies on automatic budgeted recall without
  forcing a memory tool call.
- `oracle`: the reader receives only the official evidence sessions.
- `nmg-oracle`: Pi imports the official evidence sessions into an isolated NMG
  database, then a fresh Pi session answers using NMG retrieval. This is an
  ingestion/retrieval smoke test, not a full-haystack score.
- `matched`: runs the strict three-arm gate on the same fixed IDs, prompt,
  reader configuration, and full cleaned haystack: `no-memory`,
  `nmg-deterministic`, and `nmg-shadow`. Shadow scoring is recorded but cannot
  affect retrieval ranking.
- `raw-session`: lexical session ranking under the shared context-character
  budget.
- `flat-hybrid`: lexical plus deterministic hashing-vector ranking over
  individual turns under the same budget.
- `nmg-lite`: the same turn-level evidence imported into NMG, with graph hops
  forcibly disabled by `NMG_GRAPH_HOPS=0`.
- `nmg-graph`: the same NMG import with one-hop typed relation expansion.

Answer agents run without built-in filesystem/shell tools, skills, context files,
or prompt templates. NMG arms expose only the three NMG tools. This prevents an
agent from searching the checked-out benchmark files or reading golden answers;
the memory delivery mechanism is the only arm-specific information channel.

`raw-session`, `flat-hybrid`, `nmg-auto`, `nmg-lite`, and `nmg-graph` remain
separately runnable diagnostic ablations; they are not members of the strict
matched gate.

Matched import is deterministic: every source turn becomes immutable
`conversation_evidence`, and adjacent session nodes receive a temporal
`related_to` edge. This isolates retrieval from stochastic memory extraction.
It does not test the quality of automatic extraction or learned topology.

Reports and per-question NMG databases are written under `results/`, which is
also ignored by Git.

## 2026-08-11 matched regression after controller telemetry changes

Run `2026-08-11T07-34-42.046Z` repeated the seven-category, one-repeat strict
matched gate with `deepseek/deepseek-v4-flash`, thinking off, four concurrent
questions, no external embedding provider, QPP1 shadow, and a controller that
could not affect ranking. The generic diagnostic judge and the separate
LongMemEval protocol scorer produced:

| Arm | Diagnostic | Protocol score | Evidence judge | Mean answer latency |
|---|---:|---:|---:|---:|
| No memory | 1/7 | 2/7 | n/a | 5.64 s |
| Deterministic NMG | 4/7 | 4/7 | 4/7 | 10.35 s |
| NMG + non-ranking shadow | 4/7 | 4/7 | 4/7 | 9.24 s |

Both NMG arms passed the same four categories: abstention, knowledge update,
single-session assistant evidence, and single-session user evidence. They both
missed multi-session aggregation, preference retrieval, and temporal reasoning.
Against no memory, each NMG arm had three candidate-only wins, zero
baseline-only losses, one shared pass, and three shared failures. This is a
small regression gate, not a leaderboard claim, but it shows no answer-quality
regression from the shadow telemetry path.

Official exact-evidence recall differed despite the non-ranking controller:
deterministic NMG had `recallAny=5/7`, `recallAll=3/7`, and `NDCG=0.567`; shadow
had `5/7`, `2/7`, and `0.538`. The model made different search/get choices and
loaded different exact evidence even though retrieval ranking was unchanged.
The equal 4/7 answer and evidence-judge scores therefore do not establish
retrieval equivalence; repeated paired trials are still required before making
a cost or recall claim.

Provider totals were 133,327 tokens for deterministic NMG, 97,207 for shadow,
and 5,136 for no memory, including 107,392, 82,304, and 1,408 cache-read tokens
respectively. Mean injected context estimates were 1,404 and 657 tokens for the
two NMG arms. These one-repeat cost differences are observations of Agent tool
behaviour, not effects attributable to the non-ranking controller.

## Strict matched development run

Run ID: `2026-07-26T09-47-30.923Z`. One fixed example from each of the seven
question categories used the same DeepSeek V4 Flash reader, prompt, question,
and deterministic full-haystack import in all arms. No external embedding
provider was configured, so this run measures the zero-configuration
FTS/hashing path rather than BGE or Qwen semantic retrieval.

The separate LongMemEval protocol scorer produced:

| Arm | Correct | Accuracy | Mean answer latency |
|---|---:|---:|---:|
| No memory | 1/7 | 14.3% | 4.1 s |
| Deterministic NMG | 2/7 | 28.6% | 6.9 s |
| NMG with non-ranking shadow logging | 3/7 | 42.9% | 6.7 s |

The shadow controller could not change ranking. Its one-answer difference is
reader/judge variance and is not evidence that the controller improves
retrieval. The independent retrieval diagnostic found sufficient evidence in
2/7 deterministic and 3/7 shadow trials. When deterministic retrieval was
sufficient, the answer was correct in 2/2 cases; all five deterministic
retrieval misses produced wrong answers.

The dominant failures were semantic and coverage misses: personal-best state,
multi-session aggregation, Premiere Pro preference, degree, and two-event
temporal evidence. A one-question experiment that changed recommendation
requests from cue-only to automatic retrieval still returned unrelated nodes
and scored 0/1, so that gate change was reverted. The next fair experiment is
the same fixed sample with a working external node-and-leaf embedding provider.
Until then, changing graph topology, the controller, or answer prompts would
confound the diagnosed retrieval bottleneck.

This seven-question, one-repeat result is a development diagnostic, not a
general capability or leaderboard claim.

## First seven-question development run

| Mode | Correct | Accuracy |
|---|---:|---:|
| No memory | 1/7 | 14.3% |
| Oracle evidence | 5/7 | 71.4% |
| NMG over oracle evidence, pre-semantic architecture | 2/7 | 28.6% |
| NMG over oracle evidence, typed graph architecture | 6/7 | 85.7% |
| NMG over oracle evidence, adaptive retrieval architecture | 6/7 | 85.7% |
| NMG three-layer recall, corrected judge parser | 6/7 | 85.7% |

The adaptive-retrieval run adds persisted vectors, learned-route scoring, and
Huffman-derived block tiers. It retained the same aggregate score; the remaining
multi-session failure returned one item instead of the required three. The
sample is too small and model execution is stochastic, so this is not a
benchmark claim. The second NMG run used the same seven fixed question IDs after
adding stable state identity, typed memories, multi-evidence derivation,
graph-aware context composition, and typed usage instructions. It resolved the
previous state-update, assistant-detail, preference, and temporal failures. The
remaining failure was multi-session aggregation: the reader counted two items
when the reference required three.

The next engineering target exposed by this run is reliable aggregation across
several sessions and memories. Larger full-haystack runs are still required to
measure retrieval quality and scalability.

The three-layer run added a resident kernel, deterministic `none/cue/retrieve`
gate, automatic evidence recall, type-aware overfetch/reranking, and exact source
excerpts. Preference recommendations and candidate coverage improved. The one
remaining failure is an ingestion/provenance issue: a user turn containing both
an old-item return and replacement pickup can still be summarized into one
memory, and a model-selected "shortest quote" can omit the other action. The
next data-model step is stable per-message raw-history IDs linked directly to
every extracted memory.

The judge parser now uses the last line-leading PASS/FAIL verdict. This fixes a
case where the judge began with PASS, reconsidered, and ended with FAIL.

On Windows, do not run independent Pi evaluation processes concurrently against
the same global Pi configuration: they contend on `settings.json.lock`. Run
them sequentially or give each process an isolated Pi agent directory with an
appropriate credential strategy. Model requests within one evaluation may
still be concurrent.

## Historical pre-gate development runs

The results below predate the strict three-arm matched protocol and are retained
only as diagnostic history. They must not be compared as current matched-gate
results.

### First full-haystack diagnostic run

Run ID: `2026-07-19T10-34-21.919Z`. One fixed example from each of the seven
question categories was evaluated with DeepSeek V4 Flash.

| Control | Correct | Accuracy |
|---|---:|---:|
| No memory | 1/7 | 14.3% |
| Raw-session retrieval | 1/7 | 14.3% |
| Flat hybrid turn retrieval | 5/7 | 71.4% |
| NMG Lite, no graph expansion | 5/7 | 71.4% |
| NMG Graph | 6/7 | 85.7% |

Graph expansion recovered the three-item multi-session answer that Lite and
both non-NMG retrieval controls missed. Flat hybrid alone won one
single-session-user case that both NMG modes missed. With only seven questions
and a stochastic reader/judge, these numbers establish a reproducible
development signal, not statistical superiority. The next benchmark step is a
larger fixed sample with repeated model runs and confidence intervals.

### Expanded 14-question diagnostic run

Run ID: `2026-07-19T10-49-26.309Z`. Two fixed examples from every category,
four-way question concurrency, and no answer timeouts:

| Control | Correct | Accuracy |
|---|---:|---:|
| No memory | 2/14 | 14.3% |
| Raw-session retrieval | 4/14 | 28.6% |
| Flat hybrid turn retrieval | 8/14 | 57.1% |
| NMG Lite, no graph expansion | 10/14 | 71.4% |
| NMG Graph | 9/14 | 64.3% |

On paired questions, Lite uniquely passed five cases that flat missed, while
flat uniquely passed three. Graph uniquely passed one case that Lite missed and
uniquely failed two that Lite passed. The larger sample therefore does not
support enabling graph expansion by default. One Graph-only miss also produced
an empty final model answer despite no RPC error, illustrating why repeated
reader runs are still needed to separate retrieval effects from model variance.
