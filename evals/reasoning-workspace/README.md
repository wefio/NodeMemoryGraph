# Reasoning workspace benchmark

This development benchmark measures whether the Lab-only `nmg_reason` workspace
helps an agent maintain explicit task state. It is separate from LongMemEval,
LoCoMo, PersonaMem, and BEAM because those suites do not call the reasoning
workspace.

The benchmark compares the same model and user prompts in four conditions:

1. full context without a workspace;
2. full context with the workspace available;
3. Pi compaction without a workspace;
4. Pi compaction with the workspace available.

Tasks require the agent to retain observations, rejected hypotheses, decisions,
constraints, versions, and next actions. Compact trials add identical unrelated
history and invoke Pi's normal compactor before the final question.

Run:

```powershell
npm run eval:reasoning-workspace
```

Useful controls:

```text
NMG_PI_MODEL
NMG_REASONING_CASE=debugging|planning|incident
NMG_REASONING_REPEATS=3
NMG_REASONING_CONCURRENCY=8
```

Reports are written under ignored `results/` directories. This is a small
development signal, not a public benchmark or leaderboard result. Inspect
individual outputs and workspace files: exact recall can improve while latency
or unsupported scratchpad claims regress.
