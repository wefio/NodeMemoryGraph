# Reusing autodiff, HA and MGR

[中文](autodiff-ha-mgr-integration.zh-CN.md) · [Terms used](autodiff-ha-mgr-integration.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.md).

## Reusing autodiff, HA and MGR

Reuse existing computation and reasoning capabilities; do not build a differentiable engine, activation system or reasoning-graph store for OoO. The task dependency graph describes execution constraints, the autodiff graph describes numerical operations, and the MGR graph describes memory associations. They may be connected through versioned projections, but their node and edge semantics are not interchangeable.

| Capability and owner | Reuse direction for task collaboration | Boundary to preserve |
| --- | --- | --- |
| [autodiff](../../../src/lab/autodiff.ts) Tensor/UOp and gradient computation | Numerical foundation for an explicitly constructed cost, utility or action-scoring model | Agent calls, discrete scheduling and tool side effects do not become differentiable merely by representing them as a graph; do not claim gradients through an entire Agent task |
| [HA: Hierarchical Activation](../hierarchical-activation.md) | Score activation and retention of context needed by a task; study signals for the value of context reuse | An activation score does not change semantic confidence, access permission, hard budgets or task dependencies; temporal state remains owned by the session/branch |
| [MGR: MemoryGraphReasoner](../../../src/lab/memory-graph-reasoner.ts) | Use existing traversal and what-if reasoning to suggest sourced context, paths or bounded assumption candidates | Soft gating by `MemoryNode.requires` does not establish a task dependency; a what-if result is not a real check and cannot enable speculative execution |
| Shared task semantics and coordinator | Generate the legal-action set, validate suggestions, and perform atomic claim and commit | A scoring model does not own legality or acceptance; deterministic execution remains available when suggestions are stale, unavailable or disabled |

The future wiring order is: shared semantics computes legal candidates → optional HA/MGR sources offer context or suggestions → shared policy ranks within the legal set → the claim/commit point revalidates. Refuse an out-of-set action rather than letting a higher score authorize it. A suggestion requiring a new task or dependency must use an explicit plan revision; it cannot silently rewrite the frozen plan. Associate it with existing run/task/attempt and AG-projection identities; add no second task ID or board kind.

Projection and artifact lifecycles follow the [session AG design](../session-active-graph-runtime-design.md): HA/MGR consume only bounded, authorized projections, and reasoning artifacts retain provenance, assumption markers and TTL. Evidence chosen as a basis for real execution must be accepted by the host and frozen into task input. An expired temporary projection or assumption cannot silently change a frozen ticket. These sources do not write board judgments or automatically write assumptions to STG/LTG.

Recomputability does not mean the current graph alone is sufficient. Reproducing a numerical suggestion also requires its parameter/implementation version, input projection, necessary initial temporal state and observation order; random state is needed when selection is random. HA's recursive temporal projection cannot be reconstructed from a current snapshot alone. Trainable parameters remain owned by versioned Lab/controller state; session fast state follows existing isolation and cleanup rules. OoO adds no second store for either. Without these conditions, rescore and mark a new suggestion rather than claiming to reproduce an old score. Actions actually taken remain in run facts; they are not recovered by rescoring.

First establish deterministic semantics and a rule baseline. Then compare, over the same legal-action set, no HA/MGR, HA only, MGR only and both together; report quality, context overhead, latency and misleading assumptions separately. Training signals come from attributable outcomes. The effect of an unadopted suggestion remains unknown; the model's own score is not ground truth. If gains are not stable, keep the rule policy.

This section records a reuse direction; it does not mark existing experiment engines as connected to the task runtime, change current enablement gates or add a switch. Future wiring and gate changes remain with the relevant capability owner and hidden-feature registry. Harnesses remain thin adapters; they do not each implement scoring or reasoning policy.

**Only the wiring seam itself has landed** ([`task-advisers`](../../../src/integration/task-advisers.ts)): `selectableTasks` supplies the legal candidate set (the rules still have one owner, and `nextTask` is its head); optional sources can only rank within that set; shared policy orders it, and claim revalidates. Sources receive a bounded projection. A suggestion can only name an existing task: it cannot add a task or dependency (there is no such field). `assumptions` are provenance only and never affect legality, so a soft premise cannot make anything legal. Unmodelled actions such as `fuse` and `prepare` are refused at the action field. Mismatched parameter/projection versions, observation order or initial state are rescored and marked as new suggestions; cross-session/branch provenance is refused. Disabled or failing sources fall back to rule policy with a reason. The default has no sources, so the rule policy itself remains the default: no HA/MGR implementation is connected, and gates and switches are unchanged. The four comparison arms remain budgeted in group F.
