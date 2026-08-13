# Reasoning workspace benchmark

This development benchmark measures whether the Lab-only `nmg_reason` workspace
helps an agent maintain explicit task state. It is separate from LongMemEval,
LoCoMo, PersonaMem, and BEAM because those suites do not call the reasoning
workspace.

The product adapter exposes `nmg_reason` only when
`NMG_ENABLE_LAB_TOOLS=1`. Scratch nodes are stored in
`NMG_DATA_DIR/reasoning/` per Pi session. Ordinary turns receive no automatic
workspace injection; Pi compaction creates one durable marker, and the next turn
receives one bounded checkpoint even if the extension process restarted. The
tool never writes scratch state to STG or LTG.

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

## Initial development signal

On 2026-07-26, DeepSeek V4 Flash ran three tasks with three repeats per
condition:

| Context   | Arm       | Exact success | Expected-detail recall | Mean latency |
| --------- | --------- | ------------: | ---------------------: | -----------: |
| Full      | Baseline  |          100% |                   100% |       5.79 s |
| Full      | Workspace |          100% |                   100% |      15.15 s |
| Compacted | Baseline  |         88.9% |                  88.9% |       9.83 s |
| Compacted | Workspace |          100% |                   100% |      23.41 s |

One of nine compacted workspace trials persisted an unsupported hypothesis
marker. The sample is too small for a capability claim, but it establishes two
product requirements:

- activate the workspace only when task complexity or context pressure
  justifies its cost;
- distinguish model-proposed hypotheses from observed evidence and prevent
  unsupported scratch state from automatic LTG consolidation.
