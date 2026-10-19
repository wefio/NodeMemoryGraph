# Next executable slices and stop conditions

[中文](next-slice-and-stop-conditions.zh-CN.md) · [Terms used](next-slice-and-stop-conditions.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.md).

## Next executable slices and stop conditions

Test the semantics before building a general scheduler. The next implementation slice is limited to a pure-data compiler in the shared layer and an offline execution model. Reuse existing identity types; do not call a model, change board tables, enable multi-actor execution or run paid speculation. For later product integration, first complete the ordinary-board scenario above and add only capabilities it actually needs; migrating every research caller is not a prerequisite to testing task decomposition. Transaction, permission and lifecycle constraints still apply to every path in that scenario; a small slice does not waive them.

Input is the existing frozen task contract, parent contract and recorded facts. Derive Task IR internally; output a legal plan or a refusal located by task/field/obligation, plus an analysis of permitted actions. The offline model does not publish or persist run state. The selected future target of one database and one writer is not a reason to create a database in this first slice. Use repository context to find owning modules and test routes; research enumeration and cost simulation remain advisory. Only mature version, permission and error-publication invariants become product-blocking tests.

Minimum discriminating cases:

- P and T may prepare from the same frozen interface; J waits for both to be accepted. Concurrent proposals to the same file do not automatically become mergeable.
- Reject a split that drops a parent obligation or expands child permission; a control assumption cannot fill a false data dependency.
- On mid-fusion failure, keep only the accepted prefix; a successor cannot run before acceptance; batch claiming cannot swallow cancellation.
- Input drift, lease replacement, cancellation and a late result racing before commit must not publish incorrectly.
- Speculation results `true`, `false` and `unknown` respectively take verified publication, invalidate-and-retry, and remain-unaccepted paths; an invalidated session cannot be reused for the real path.
- Without a suitable fusion or speculation opportunity, fall back to baseline; do not invent waiting to meet the success criterion.

Before persistence integration, also prove that equal `taskId`s in two runs do not collide; retries do not duplicate delivery; transaction failure cannot write a judgment without its association; retained board entries survive TTL; status and dependency-unlock views agree; generic board operations cannot bypass managed-task fences; and JSONL export failure does not change terminal state. Field mapping checks must catch budget-unit confusion, `requires`/`deps` confusion and silent dropping of unknown fields.

Recomputation checks must show that deleting all derived caches yields the same view; crossing a lease-expiry boundary invalidates an old view; concurrent readers of the same ready task allow only one legal claim; and an unknown external result in a crash window is not guessed to be successful or unexecuted.

If HA/MGR is optionally integrated, prove that the highest-scoring illegal action is still refused; soft premises and assumptions cannot unlock real dependencies; disabled or failing sources fall back to rule policy; state does not leak across sessions/branches; parameter or projection changes do not reuse an old suggestion; and missing history does not claim exact reproduction. These do not expand the first offline semantics slice.

Enumerate legal event interleavings for at most four units, checking obligations, inputs and provenance for each publication; use mutants that deliberately remove key conditions to prove the cases catch errors. Passing establishes only the listed properties for this finite model; it does not prove arbitrary Agent programs correct.

### Auxiliary validation: real-task continuation

After the ordinary-board product path works, first change Agent sessions at one legitimate handoff boundary in a real parent task. The receiving Agent gets no raw conversation; it receives the task view above and can retrieve necessary evidence to finish the same parent task. Record omitted constraints, duplicated work, mistaken completion, actions based on stale support, recovery time and context cost. A fixed parent-level acceptance check evaluates the final artifact. Check counts and ledger completion rates do not replace this result.

To isolate a context-handoff problem, save a controlled input at the same handoff point and compare three context policies: full visible history, a same-budget summary, and task view plus on-demand evidence. Fix model, task permissions, tools and parent acceptance; count retrieval and view-construction cost. Visible history excludes hidden reasoning. This supporting comparison is not a gate for every experiment in the table. One scenario can expose a gap but cannot prove general long-task gains. Live model calls still require the budget and repetition rules below; this design record does not start a paid experiment.

### Main validation: granularity, concurrency and fusion

Choose a parent task with genuinely independent work. State which data or control dependency ceases to block independent work under a legal refinement, while retaining composition acceptance. Merely splitting tests into ordinary and boundary groups and serially changing sessions does not prove concurrency was found. The existing [continuation experiment](../../experiments/execution/ooo-real-continuation-2026-09-14.md) and [follow-up analysis](../../experiments/execution/ooo-real-continuation-comparison-2026-09-14.md) diagnose handoff and runner defects; they do not establish the main hypotheses below.

Prioritize A–D; evaluate E independently after evidence for concurrency and fusion:

| Arm | Change | Question |
| --- | --- | --- |
| A: coarse-task baseline | Original parent task and acceptance | What are the real cost and quality baselines? |
| B: fine tasks, one execution slot | Split into independent sessions | How much handoff and verification cost does splitting add? |
| C: same fine plan, multiple slots | Change only slot count/legal order | How much can deterministic concurrency shorten the critical path? |
| D: same fine plan/slots, fusion | Change only legal session reuse | Do savings exceed context burden and waiting? |
| E: D plus bounded factual speculation | Add only budgeted candidate preparation | Is there still a gain after extra cost and recovery on misses? |

A/B compare task decomposition and cannot claim to change dispatch order alone. B/C, C/D and D/E control their other variables respectively. Keep parent acceptance fixed and separately record the checks and planning cost needed for decomposition. The offline model first covers varied granularity, dependency density, shared context, fact-hit rate and verification cost. It can find logical errors and cost turning points, but cannot predict real-model quality.

For the real-model phase, declare the model, budget and repetitions separately; randomize arm order; freeze model settings, inputs and validation rules; retain failures and timeouts; and use held-out tasks. Report parent-level quality, completion rate, wall-time distribution, input/output/cache tokens, actual cost, host cost, wasted-work cost and human intervention. Unequal quality is not a speedup claim; simulated tokens or hit rates are not measurements.

If most tasks lack checkable boundaries, stop automatic decomposition and retain coarse tasks. If fusion improves cost but harms quality, narrow the fusion scope. If speculation has no net gain, retain the semantics layer and deterministic concurrency without treating speculation as a required deliverable.
