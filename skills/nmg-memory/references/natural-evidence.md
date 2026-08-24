# Natural evidence loop

Use this procedure when NMG should improve from ordinary Agent work. The goal is
to collect attributable observations as a side effect of real tasks, not to
manufacture labels or silently tune production behavior from benchmark data.

## 1. Enable passive collection

For ordinary interactive Pi sessions, enable the shadow recorder without
changing retrieval:

```text
NMG_CONTROLLER_SHADOW=1
```

Leave `NMG_SHADOW_COLLECTION_ORIGIN` unset. Headless probes, benchmarks, scripted
smokes, and synthetic tasks must set it to `controlled`; never remove that marker
to make an experiment look natural. The adapter automatically records bounded
retrieval features, budgets, candidates, costs, injected size, and session/task
identity. It does not infer success from silence.

## 2. Preserve the observable evidence chain

During a real task:

1. Search normally and pass the returned `activeGraphId` to exact `get` calls.
   This distinguishes candidates shown from evidence actually disclosed. The Pi
   adapter can recover an omitted ID from its bounded, session-owned search
   trace; other harnesses must preserve it explicitly, and Agents should still
   pass it when available rather than depend on recovery.
2. Let the task proceed normally. Do not ask extra questions merely to create a
   training example.
3. When an outcome is directly observable, record only the known fields:

   ```text
   nmg_remember action=feedback activeGraphId=<AG_ID>
     taskSuccess=true evidenceSufficient=true expansionUseful=false
     excessiveNoise=false noMemoryNeeded=false
   ```

4. When a particular saved claim is independently supported or contradicted,
   use `nmg_remember action=claim_outcome` with the smallest exact current-session
   user excerpt or successful tool-result excerpt. Retrieval, answer reuse, task
   completion by itself, silence, and lack of correction are not claim evidence.
5. Reuse one stable semantic task identity for retries or follow-up turns so one
   conversation cannot create several independent votes.

With shadow collection enabled, Pi may show a one-shot reminder on the next user
turn. It includes only the exact memory IDs disclosed by `get`, plus the owning
Active Graph and semantic task. A search preview alone cannot trigger this claim
review. The reminder is an opportunity to inspect new evidence, not permission to
infer an outcome.

Do not fill every boolean merely because the API accepts it. Examples:

- An explicit user correction may establish `userCorrection=true` and usually
  `taskSuccess=false` for the preceding answer.
- A successful test or authoritative tool check may establish task success and
  claim support.
- No complaint does not establish `userCorrection=false` or task success.
- A task that never needed memory may set `noMemoryNeeded=true` only when that is
  evident from the task, not merely because search returned nothing.

## 3. Audit without changing policy

From the NMG checkout, periodically run the read-only summaries:

```text
npm run eval:natural-readiness -- --project-dir <REAL_PROJECT>
npm run eval:controller-shadow
npm run eval:controller-dataset -- --compact
npm run eval:natural-maintenance -- --project-dir <REAL_PROJECT>
```

Use `eval:natural-readiness` first. It combines the other read-only views into
one Agent-facing action packet and may be persisted with `--out <FILE>`. Its
`required`, `available`, and `blocked` actions state what to collect or run next.
It never activates a controller candidate, changes maintenance policy, or treats
an empty evidence category as validation. Use the component reports only when
the packet points to a gap that needs diagnosis.

Use the reports as a readiness contract:

- dataset blockers identify missing labels, replay inputs, verified claim
  attribution, or independent train/validation groups;
- `natural-maintenance` reports natural claim outcomes, STG posteriors,
  materialization/retraction examples, identity proposals, transforms, rollbacks,
  and explicit evidence gaps;
- `controlled` and `legacy` rows validate plumbing or preserve audit history but
  never satisfy natural readiness.

Run the audit after new real tasks have accumulated or after a material model,
prompt, embedding, retrieval, or memory-distribution change. Do not poll it every
turn, and do not use a fixed row count as proof of quality.

## 4. Let the Agent update only after readiness

If `eval:controller-dataset -- --compact` has no blockers, create a candidate:

```text
npm run eval:controller-calibrate -- --compact
```

This command writes a rollbackable candidate artifact; it does not activate it.
The Agent may update a controller configuration or checked-in policy only after:

1. the candidate and frozen baseline are compared on held-out semantic tasks;
2. the candidate actually changes the intended retrieval decisions;
3. evidence/answer sufficiency does not regress;
4. token, tool-call, depth, and latency costs remain within their hard envelopes;
5. the effective configuration, feature version, data window, source-log hash,
   tests, and rollback target are recorded.

When those gates pass and repository write authority exists, the Agent may apply
the smallest source/configuration change, run the matched regression suite, and
commit it with the candidate artifact or an immutable reference to it. If any
gate fails, retain the candidate as shadow evidence and keep the current policy.
Never hand-edit QPP constants merely because the sample count grew.

## 5. Maintenance learning uses stricter evidence

Controller readiness does not authorize unattended STG promotion or node merges.

- Change STG-to-LTG consolidation only after natural supported and contradicted
  outcomes demonstrate both precision and reversible retraction.
- Change automatic identity merging only after natural true-pair, same-name
  false-pair, scope-conflict, alias, source-actor, and rollback cases exist.
- Empty categories and zero observed failures are missing evidence, not proof
  that a threshold should be relaxed.

The Agent may improve audit tooling or propose a shadow candidate while these
gaps remain, but must keep the corresponding production actuator disabled.
