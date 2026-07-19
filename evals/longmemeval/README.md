# LongMemEval adapter

The local data directory contains the official cleaned LongMemEval-S and oracle
files and is intentionally ignored by Git.

Run one deterministic example from each of the seven benchmark categories:

```powershell
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
npm run eval:longmem -- matched 1
```

The final argument is the number of examples per category. Selection always
comes from the ordering in `longmemeval_s_cleaned.json`, so every mode uses the
same question IDs. Each answer is judged by a fresh DeepSeek V4 Flash session;
an empty judge response is retried once.

The runner defaults to four concurrent questions and a five-minute model-call
timeout. Override these with `NMG_LONGMEM_CONCURRENCY` and
`NMG_LONGMEM_TIMEOUT_MS`. A single answer timeout is recorded on that row rather
than discarding the whole experiment; judge failures receive one fresh retry.

## Modes

- `no-memory`: the reader receives only the question and date.
- `oracle`: the reader receives only the official evidence sessions.
- `nmg-oracle`: Pi imports the official evidence sessions into an isolated NMG
  database, then a fresh Pi session answers using NMG retrieval. This is an
  ingestion/retrieval smoke test, not a full-haystack score.
- `matched`: runs five controls on the same fixed IDs and full cleaned haystack:
  `no-memory`, `raw-session`, `flat-hybrid`, `nmg-lite`, and `nmg-graph`.
- `raw-session`: lexical session ranking under the shared context-character
  budget.
- `flat-hybrid`: lexical plus deterministic hashing-vector ranking over
  individual turns under the same budget.
- `nmg-lite`: the same turn-level evidence imported into NMG, with graph hops
  forcibly disabled by `NMG_GRAPH_HOPS=0`.
- `nmg-graph`: the same NMG import with one-hop typed relation expansion.

Matched import is deterministic: every source turn becomes immutable
`conversation_evidence`, and adjacent session nodes receive a temporal
`related_to` edge. This isolates retrieval from stochastic memory extraction.
It does not test the quality of automatic extraction or learned topology.

Reports and per-question NMG databases are written under `results/`, which is
also ignored by Git.

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

## First full-haystack matched development run

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

## Expanded 14-question development run

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
