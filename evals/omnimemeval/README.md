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
