# Position relative to published work

[中文](related-work.zh-CN.md) · [Terms used](related-work.terms.yaml)

**Status:** draft; external metrics below are reported by the cited sources and were not rerun here.
**Authority:** [Parent scope](../ooo-execution-bootstrap.md).

## Maturity and published-system comparison

This section records external comparisons; it does not restate this design's own contracts. The [five-level self-improvement scale](https://d2i-ai.github.io/awesome-recursive-self-improving-agents/) separates “can propose, apply, verify” from “can rewrite the improvement mechanism itself”: L1 manual; L2 assisted (the system can propose candidates and diagnostic evidence, while a human verifies and applies changes and maintains the improvement mechanism); L3 programmatic self-improvement (the system can autonomously propose, apply, and verify changes to runtime components, while the improvement mechanism is fixed or externally maintained); L4 bounded RSI (the system can also rewrite its improvement mechanism); L5 general RSI.

By this scale, **the project snapshot recorded here is L2**: people prewrite and approve each round's instructions, case list, verifier, and promotion; no round automatically makes a candidate the next baseline. In this snapshot, S1 had one round, one model, and one check. Its exit criterion (a useful change independently accepted and used by the next round) is the step from L2 toward L3, and had not yet been reached. Later research samples can add experimental evidence, but do not by themselves prove product-runtime integration.

The cited published systems describe themselves at L3 and report measurable gains:

| System | Scope of self-change | Acceptance | Reported gain |
| --- | --- | --- | --- |
| [MOSS](https://arxiv.org/html/2605.22794v1) | Harness layer: routing, state, dispatch, hooks, session lifecycle | Plan review + code review + rerun in a short-lived trial container; after convergence, the user must still explicitly run `moss evo apply` to promote | Four-task mean 0.25 → 0.61 |
| [DGM](https://arxiv.org/html/2505.22954v3) | Its own Python codebase; empirical evidence substitutes for provable improvement | Measured on coding benchmarks; only versions that compile and retain editing ability are archived | SWE-bench Verified 20.0% → 50.0%; Polyglot 14.2% → 30.7% |
| [SICA](https://arxiv.org/abs/2504.15228) | Its own implementation, using basic coding tools | Benchmark measurement | SWE-bench Verified subset 17% → 53% |
| [AHE / evolvable harness](https://arxiv.org/html/2608.08466v1) | Prompts, tools, memory, state, execution policy | External reward signal; runs directory, tracer, verifier, and model configuration are read-only | BabyAI +39.3, Crafter +33.0, TextWorld +25.0, MiniHack +15.0 |

The overlap with this design is established practice, not new contribution: keep verifier/reward signals outside the self-improvement loop ([harness self-improvement survey](https://lilianweng.github.io/posts/2026-07-04-harness/): “The evaluator and permission control should likely sit outside the loop”); make directories, tracers, verifiers, and model configuration read-only when they are outside the surface under test; and require explicit human approval for promotion. DGM reports an actual verification bypass: its agent deleted logs that marked tool calls and thereby evaded a hallucination detector that was invisible to that agent. This design structurally rules out that path: the worker cannot change the verifier, approve itself, or supply an authoritative `passed` flag.

Three identifiable differences:

- **Object.** Published systems optimize prompts, skills, memory, tools, or an entire codebase; [HarnessX](https://arxiv.org/abs/2606.14249) and [self-evolving harnesses](https://jxzhangjhu.github.io/blog/2026/self-evolving-agentic-harnesses/) evolve the harness as a whole. This work treats the **waiting structure itself** as the development object: fixed order, explicit dependencies, at most one waiting task and one executing task, no preemption, and no speculation. Permission to pass the queue head comes from a real external-check event, not a prediction. Harness self-improvement discussions recommend parallelism and background tasks (“make parallelism explicit and inspectable”), but do not make them dimensions of self-improvement.
- **Handling waits.** A published way to turn tool latency into a gain is speculative execution. [PASTE](https://arxiv.org/html/2603.18897v1), for example, uses offline-mined patterns to pre-run likely calls on idle resources and reports a 48.5% average reduction in task completion time. Its prediction depends on forecasting the next step (about 27.8% Top-1) and it must be able to preempt speculative work. This design neither predicts nor preempts: it uses wait time for work that is already required and independent of A. This is another point in the design space, not an improved version of the same method.
- **Acceptance semantics.** Published systems use benchmark scores or a scorer as the signal. This design requires each case to resolve to checkable evidence and distinguishes “cannot complete” (a blocker) from “no change needed” (a resolved conclusion).

This work also **lacks** the field's evidence standard: measured gains, repeated trials (MOSS uses multiple short-lived containers to expose flakiness), held-out task sets, and cross-model checks. In the snapshot described here, S1 has only one round/model/check. Even an adopted change would not establish a speed or quality gain; S4 comparisons should use repeated trials and held-out task sets. See the later [arm pilot](../../experiments/execution/ooo-arms-pilot-2026-09-18.md), whose conclusions remain bounded by its sample and research instrument.

### Out-of-order execution: the true analogue is “out-of-order execution + in-order commit”

The processor analogue is not “parallelism” but **out-of-order execution + in-order commit**: instructions enter functional units out of order, while the reorder buffer makes their effects visible in program order at retire/commit, yielding precisely recoverable state ([Out-of-order execution](https://en.wikipedia.org/wiki/Out-of-order_execution), [Reorder buffer](https://wwang.github.io/teaching/slides/Comp_Arch/Reorder_Buffer.pdf)). The design maps nearly one-to-one: workers run out of order (B before blocked A); the plan and tickets act as the reorder buffer; the coordinator is the sole retire stage; A's input binds only after the check's terminal event. The acceptance rule (accept/reject/undecidable) defines what counts as commit.

Speculation is the difference. Much of classic OoO's benefit comes from speculative execution and rollback (branch prediction, squash), which requires discarding state on the wrong path. This design **does not speculate or roll back**: it reorders work that must be done anyway, and a real external event permits passing the queue head. It therefore needs no squash mechanism, but its benefit ceiling is also plainly lower. Preserve that distinction honestly; do not compare it as a faster version of the same approach.

### Agent out-of-order execution: the domain default is unbounded parallelism, this design is stricter

Dependency-aware DAG scheduling is mainstream: plan-as-DAG plans the dependency graph before parallel execution ([LLMCompiler](https://www.agentpatternscatalog.org/patterns/llm-compiler/)); production fan-out reports 36–50% lower wall time and dependency-aware DAGs about 1.35× versus serial execution, while “parallelize everything without dependencies” sacrifices correctness ([DAG orchestration](https://particula.tech/blog/dag-agent-orchestration-fan-out-fan-in-latency-parallel-execution)). Another way to use tool latency is to predict the next call ([PASTE](https://arxiv.org/html/2603.18897v1), −48.5% average completion time). This design is **stricter than all of these**: fixed order, at most one waiting and one executing task, no preemption, no speculation. Its value claim must therefore be acceptance semantics (provable gaps, host verification, and no self-approval), not parallel throughput; comparisons must reflect that position.

Background delegation, durable session snapshots, reconnect, and human pause/resume are now standard harness capabilities ([Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/concepts/harness), [Mastra durable agents](https://mastra.ai/docs/harness/durable-agents), [Inngest durable agents](https://www.inngest.com/docs/learn/durable-agents)). If S3 adds submit/query/cancel, it should align directly with these existing shapes rather than reinventing a round script. A similar round-tool shape was historically implemented and later retired; see the [S3/S4 tooling record](historical-round-tooling.md). That record does not prove that the product's existing `nmg_board` host path invokes the extracted dispatch loop.

### Distributed coordination: existing mechanisms already have names

Read the complete responsibility: [Distributed coordination: existing mechanisms already have names](related-work/distributed-coordination.md).

### Improvements derived from this comparison

Read the complete responsibility: [Improvements derived from this comparison](related-work/improvement-opportunities.md).

### Where speculation could fit (the decision owns rules; this section only lists candidates)

Read the complete responsibility: [Where speculation could fit](related-work/speculation-integration.md).

### State machines, LLM guesses, and LLM rejection

**Adopt a task-registration state machine.** Each task declares its state and readiness conditions; the host computes transitions from recorded facts. This addresses the classic blackboard weakness of “no control structure” (an explicit control component is needed) and enables S2 replay: durable orchestration represents state as an event-sourced append-only history, replays decisions after a crash, and requires deterministic orchestration code with side effects isolated in activities and their results recorded ([Durable Task replay](https://github.com/Azure/durabletask/blob/main/docs/concepts/replay-and-durability.md), [orchestration-code constraints](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-code-constraints)). Therefore **only host rules may evaluate transitions over recorded facts; an LLM must never write transitions**. A model may produce an artifact or declaration for host rules to consume.

**LLM task guessing has two forms; one is forbidden.** Guessing the plan itself (which tasks to do next) is automatic replanning. It breaks both the acceptance properties of a fixed plan and the loop in which the host proves a gap before assigning work; it is out of scope. The only potentially allowed form guesses the outcome of a declared condition (the gated speculation above), with the assumption included in the frozen envelope and bound by its digest.

**A second LLM may advise, not judge.** This is a published position, not a personal preference: self-improving agents should demote the evaluator from oracle to advisor, with its result only one input among several ([LLM-as-a-Judge Is Not an Oracle](https://arxiv.org/abs/2609.02246v1)). In measurements, paired preferences from judges flipped 13.6% of the time on average ([The Coin Flip Judge?](https://arxiv.org/html/2606.13685v1)). A reference-free judge rates **plausibility**, not **correctness**, leaving a false-positive basin of “sounds reasonable but is wrong” for a policy to exploit ([Self-Play Reward Hacking of Reference-Free LLM Judges](https://arxiv.org/html/2607.05904v1)). This work observed the same pattern: B's round-2 citation looked like coverage, but semantic support was not established.

The resulting asymmetric rule is: **an advisor may say “no”; only the host may say “yes.”** A second LLM's rejection may be a cheap prefilter (early exit, saving one host check), but it can never establish acceptance or replace a deterministic check. On tasks with an existing deterministic check, replacing a free local check that resolves in seconds with a paid probabilistic 20–50 s judgment is a regression. Pay for it only on assertions with **no deterministic check** (design coherence, intent match, or evidential support), and prefer **host-parseable citations** (the mechanism established in round 3) over another model's opinion.

One related external result: in code-RL environments, 28.5% of tasks had test suites so weak that Docker-verified incorrect patches passed ([Auditing Reward Hackability](https://arxiv.org/pdf/2606.16062)). That is why round 3 switched to mutation evidence.

### Output format, artifact submission, and verification cost

Read the complete responsibility: [Output format, artifact submission, and verification cost](related-work/output-format-and-verification-cost.md).

Research-instrument details on tool submission, visible sets, tickets, and cache accounting are documented in that comparison.