# LongMemEval adapter

The local data directory contains the official cleaned LongMemEval-S and oracle
files and is intentionally ignored by Git.

Run one deterministic example from each of the seven benchmark categories:

```powershell
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
```

The final argument is the number of examples per category. Selection always
comes from the ordering in `longmemeval_s_cleaned.json`, so every mode uses the
same question IDs. Each answer is judged by a fresh DeepSeek V4 Flash session;
an empty judge response is retried once.

## Modes

- `no-memory`: the reader receives only the question and date.
- `oracle`: the reader receives only the official evidence sessions.
- `nmg-oracle`: Pi imports the official evidence sessions into an isolated NMG
  database, then a fresh Pi session answers using NMG retrieval. This is an
  ingestion/retrieval smoke test, not a full-haystack score.

Reports and per-question NMG databases are written under `results/`, which is
also ignored by Git.

## First seven-question development run

| Mode | Correct | Accuracy |
|---|---:|---:|
| No memory | 1/7 | 14.3% |
| Oracle evidence | 5/7 | 71.4% |
| NMG over oracle evidence, pre-semantic architecture | 2/7 | 28.6% |
| NMG over oracle evidence, typed graph architecture | 6/7 | 85.7% |

The sample is too small and model execution is stochastic, so this is not a
benchmark claim. The second NMG run used the same seven fixed question IDs after
adding stable state identity, typed memories, multi-evidence derivation,
graph-aware context composition, and typed usage instructions. It resolved the
previous state-update, assistant-detail, preference, and temporal failures. The
remaining failure was multi-session aggregation: the reader counted two items
when the reference required three.

The next engineering target exposed by this run is reliable aggregation across
several sessions and memories. Larger full-haystack runs are still required to
measure retrieval quality and scalability.

The next fair comparison will ingest every LongMemEval-S haystack session into
NMG and compare it with no-memory, full-history/windowed, and flat-retrieval
baselines on the same fixed question IDs.
