# QPP calibration

Use this procedure when tuning QPP thresholds or weights for a deployed Agent.
Do not copy a benchmark optimum directly into the product default: benchmark
queries, forced-search behavior, memory density, and answer judges can differ
substantially from ordinary Agent use.

## Current untrained baseline

The shipped score is deliberately an engineered heuristic, not a learned or
calibrated probability:

```text
C = Top1 + 0.5 * NQC
trigger when C < 0.55
```

`Top1` is the absolute bounded retrieval-strength anchor. `NQC` is normalized
intra-list dispersion; its hand-set 0.5 weight can encourage expansion but
cannot dominate one genuinely strong hit. The 0.55 threshold, 0.2 hard Top1
floor, and guardrails are cold-start operating points. Their numeric values must
not be described as production-calibrated, and benchmark improvements alone do
not authorize changing them.

## Required trace data

Collect matched real-use traces containing:

- the query and stable task/session identity;
- the first-pass candidate scores and QPP features;
- records exposed, expanded, fetched exactly, and actually used;
- whether the Agent searched again;
- user correction, task result, or another outcome signal when available;
- injected tokens, tool rounds, search latency, and end-to-end latency.

Treat an uncorrected answer as unknown rather than automatically successful.
Deduplicate repeated attempts from the same semantic task so one conversation
cannot dominate calibration.

## Labels

Use separate labels instead of one overloaded "good retrieval" flag:

1. `evidence_sufficient`: the exposed evidence was enough to answer correctly;
2. `expansion_helpful`: another search/get operation added necessary evidence;
3. `noise_excessive`: exposed records consumed budget without helping;
4. `no_memory_needed`: abstaining from recall was the correct behavior.

Prefer explicit user corrections, official evaluation evidence, tool-verified
outcomes, and reviewed samples. Weak implicit signals may be retained with lower
weight, but must not be treated as ground truth.

## Calibration procedure

1. Keep the current policy frozen while collecting traces.
2. Split by semantic task or time, never by individual trace, to prevent related
   turns leaking between train and validation data. Also check exact-use evidence
   identities: query-derived task IDs or paraphrases are not independent when
   they ultimately use the same memory. Require enough distinct training evidence
   targets and no target overlap across the train/validation boundary. Count one
   primary exact-use target per task for diversity, but check leakage against all
   exact records the Agent used so secondary evidence cannot cross the split.
3. Fit or sweep only on the training portion. Start with threshold calibration;
   change feature weights only when threshold adjustment cannot fix the error.
4. Choose an operating point from the real product cost:

   ```text
   cost = missed_required_evidence
        + lambda * unnecessary_expansion
        + mu * injected_tokens
        + nu * tool_and_search_latency
   ```

   Missing required evidence should normally cost more than one bounded extra
   expansion.
5. Validate on held-out tasks and report calibration by query type, language,
   memory density, and single- versus multi-evidence questions where labels are
   reliable.
6. Compare against the previous frozen policy in shadow mode. Promote a new
   policy only when evidence sufficiency does not regress and its added cost is
   acceptable.
7. Store the effective configuration, data window, feature version, and metrics
   with the result so it can be reproduced or rolled back.

## Guardrails

- Keep QPP1, QPP2, and search recommendation independently switchable.
- Do not train on whether the current policy chose to expand; train on whether
  expansion was actually necessary or useful.
- Do not interpret retrieval or rendering alone as success.
- Require enough independent tasks before updating defaults; until then retain
  the conservative engineered policy.
- Recalibrate after material changes to the embedding model, retrieval mode,
  prompt/tool contract, memory distribution, or base model.
- Benchmark data remains useful as a regression suite and cold-start prior, not
  as the final estimate of real-use probabilities.

## Natural controller shadow collection

Set `NMG_CONTROLLER_SHADOW=1` for ordinary Pi sessions to collect a bounded, local
matched trace without changing retrieval. NMG stores
`controller-shadow-events.jsonl` and `controller-shadow-state.json` under
`NMG_DATA_DIR`. A retrieval is only a candidate event; training occurs only
after an explicit `nmg_get` fetch from the same session-owned Active Graph.
Do not set `NMG_SHADOW_COLLECTION_ORIGIN=controlled` for ordinary work. Conversely,
never remove that marker from a headless probe, benchmark, or scripted experiment
to make it appear natural. See [natural evidence](natural-evidence.md) for the
full collection and update loop.

For an Active Graph whose outcome is explicitly known, the existing Pi tool
surface can record labels without creating a separate evaluation tool:

```text
nmg_remember action=feedback activeGraphId=<AG_ID>
  taskSuccess=true evidenceSufficient=true expansionUseful=false
  excessiveNoise=false noMemoryNeeded=false
```

Only provide fields actually observed. A user correction may set
`userCorrection=true`; no correction must not be recorded as `false` unless the
task was explicitly reviewed. The graph must belong to the current session and
`NMG_CONTROLLER_SHADOW=1` must be enabled. These labels affect the bounded
shadow log only; they do not rewrite memory or alter live retrieval.

Audit collection coverage before fitting anything:

```text
npm run eval:controller-shadow
```

The report reads the bounded log and its rotations, counts automatic/tool
retrievals, exact use, outcomes, explicit labels, semantic tasks, and actual
injected characters. `calibrationReady=false` is deliberate until a held-out
time/task split and matched shadow comparison have been performed; the command
does not turn sparse telemetry into a policy.

Once independently reviewed labels exist, build the leakage-safe joined data:

```text
npm run eval:controller-dataset -- --compact
```

The exporter joins retrieval, exact use, outcome, and feedback by Active Graph,
requires all four retrieval labels, and assigns whole `semanticTaskId` groups to
chronological train or validation splits. It reports blockers instead of
inventing labels or treating a query fingerprint as semantic-task identity.

Fit the candidate only after the exporter has no protocol blockers:

```text
npm run eval:controller-calibrate -- --compact
```

The calibration command prints a bounded readiness summary and writes the full
candidate, including learned parameters and rollback fingerprint, under
`evals/controller-shadow/results/`. Inspect the complete artifact only when
auditing or replaying the candidate; routine collection should use the summary
and its fail-closed gate.
