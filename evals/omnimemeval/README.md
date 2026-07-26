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

## Migration gate

Before adopting OmniMemEval results as authoritative:

1. use the same fixed LongMemEval question IDs as the current matched run;
2. use the same reader and judge configuration;
3. compare answer score, evidence recall, token injection and latency;
4. verify per-user isolation and cleanup;
5. verify that every returned memory remains traceable to NMG evidence.

Until parity passes, the existing TypeScript runners remain local migration
fixtures. Afterwards they should shrink to fast deterministic regression tests.

## Deliberate non-goals

- Do not vendor OmniMemEval into NMG core.
- Do not maintain five separate NMG benchmark adapters.
- Do not adopt the heavier AgentBench/OpenClaw agent-memory track for Pi.
- Do not add another embedding or storage implementation solely for the
  harness; it must exercise the same NMG configuration used by Pi.
