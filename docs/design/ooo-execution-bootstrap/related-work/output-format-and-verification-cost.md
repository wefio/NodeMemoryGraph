# Output format, artifact submission, and verification cost: external comparison with observed results

[中文](output-format-and-verification-cost.zh-CN.md) · [Terms used](output-format-and-verification-cost.terms.yaml)

**Status:** draft; external results are cited, not reproduced. Historical research-instrument details below are not product-runtime integration evidence.
**Authority:** [Parent scope](../related-work.md).

## Format compliance and verification cost

**“Analytical roles answer in prose while target-oriented roles answer in JSON” is not unique to this work.** Published results point to a more precise mechanism and a different remedy than my initial guess of “change the wording”:

- Explicit reasoning can **reduce** instruction compliance. An evaluation of 15 models on IFEval and ComplexBench found that CoT-style reasoning significantly harmed compliance with format constraints ([When Thinking Fails](https://huggingface.co/papers/2505.11423)). A's reasoning happened in the answer channel rather than outside the answer.
- Stacking constraints can degrade compliance nonlinearly. When 24 verifiable instructions were increased from 1 to 20, compliance fell nonlinearly ([Instruction Stacking Collapse](https://arxiv.org/html/2608.02639v1)); the recommendation was “prompt compilation”—converge on fewer, non-overlapping constraints. This work restated the same format rule in four places (patchPrompt, system prompt, check-tool response, and retry prompt), exactly the opposite pattern.
- Format cost depends on **remaining capacity**: a constraint's overhead is related to the model's spare capacity and can be absorbed when that capacity is sufficient ([Capacity, Not Format](https://arxiv.org/html/2606.09410)). A's task was heavier (reason first, then inspect check results), leaving less capacity.
- **Changing role/persona wording is not the remedy.** Personas in system prompts did not improve objective task performance, and expert personas could hurt accuracy ([Personas in System Prompts](https://doi.org/10.18653/v1/2024.findings-emnlp.888), [Expert Personas Damage Accuracy](https://doi.org/10.48550/arxiv.2603.18507)).

**An available architecture-level remedy is tool submission with constrained sampling.** Industry guidance is direct: do not merely ask for JSON in a prompt; use provider structured output to make out-of-schema text unreachable during decoding ([Structured Output and Constrained Decoding](https://sesen.ai/blog/structured-output-llm-constrained-decoding)). The SDK used by this repository supports this: `Tool.constrainedSampling` accepts `{type:"json_schema",strict:"prefer"|"require"}`, and `defineTool` forwards it. The appropriate shape is a submission tool whose argument schema is the artifact shape and that requests constrained sampling. The model may still reason, but the answer must be in the tool call.

Keep host verification. Constrained decoding nearly eliminates syntax errors, but structural and semantic errors remain ([Empirical Study for Structured Output Control](https://arxiv.org/html/2606.09395v1)); it can remove parse failures, not verification.

**Verification cost dominates in published work too, not only this project's bill.** In the reported round, local host checks took 21.9 s, the model used 117k tokens, and the external wait being covered was only 1.6 s. Related literature reports:

- “Generating complex candidates is no longer the hard part; reliably verifying them is,” and every verifier is only a proxy for human intent ([The Verification Horizon](https://doi.org/10.48550/arxiv.2606.26300)).
- Verification cost worsens with output complexity; generation is polynomial while recognizing “plausible but wrong” approaches NP-hard ([Verification Scarcity](https://www.jimmont.com/ai-model-agentic-verification)).
- Calibration audits have a “verification tax”: the stronger the model, the harder it is to statistically verify its calibration ([The Verification Tax](https://doi.org/10.48550/arxiv.2604.12951)).
- Benefits at delivery can sharply decay between “can write code” and “can ship reliable software,” making review, integration, and testing the bottleneck ([Beyond Code Generation](https://arxiv.org/abs/2609.04681)).

For this work, verification overhead is a primary cost term, not a scheduler side effect. The value ceiling for hiding a wait with speculation must be compared with verification cost, not just wait duration. Also, in multi-turn tool use, cost is largely driven by context resent on every turn (input tokens often dominate a trajectory), so B's 78k tokens should prompt inspection of snapshot resend count, not just generated output.

## Artifact submission and visible sets

### Submit artifacts with a tool, not a prompt

Do not pile format constraints into the prompt; make submission a tool call. The `submit_artifact` argument schema is the artifact contract and requests provider-constrained sampling (`constrainedSampling: {type:"json_schema",strict:"prefer"}`). The model can still reason, but its answer must be in the tool arguments. After recording the artifact, the tool body immediately ends the attempt so later prose cannot contradict the submission.

Host verification remains. Constrained decoding nearly eliminates syntax errors, but structural and semantic errors remain; it removes only parse failures, not validation. Keep one prompt constraint pointing to the tool instead of restating the shape. In observed work, restating the same rule in four places was the “constraint stacking” pattern that lowered compliance.

Tool submission alone is not enough. Round 6 exposed the next layer: **do not offer choices the host will certainly reject**. Two real failures had this shape:

- The envelope checked only that fields existed, so `kind:"no-change"` plus a prose conclusion reached the host unchanged and caused a structural error.
- The tool schema offered all three conclusions for every task, so a task that had to submit files answered `promote-candidate` (valid only for a composition task).

Derive the schema from **frozen acceptance rules**, not a global enum. Include each task's `admittedConclusions` with its visible set in the digest, and expose only channels that can be accepted for that task at runtime. The discriminator is the tool's own shape (`files` means patch), not a model-supplied string.

### Visible sets and tickets

**Trim the visible snapshot per task.** The full baseline used to be resent every round (round 5 baseline: 59,874 bytes, over 30k tokens per round). The host declares the visible set and binds it into the digest (`visible`). Writable paths must never be hidden (that would be contradictory); list frozen-but-hidden filenames in the prompt, so shrinking the view does not hide the rules. The host still verifies against the full baseline.

**Carry frozen work in the ticket.** Tickets used to enumerate fields by hand, so each new field could be silently omitted and driver/coordinator digests could disagree; this failed twice in a row. Tickets now expand the frozen work directly, and the driver rebuilds from the ticket. Digest mismatch errors list the **differing fields**. Both mismatches were caught by the digest (default visible set ordered by input-key order; default conclusion set sorted only over explicit branches), showing the binding doing its job.

Cost measurements must record the provider's cache accounting (`cacheRead`/`cacheWrite`). In one observed provider, prefixes were cached (132k of B's 177k tokens were `cacheRead`; A and C were about half), so ignoring cache would systematically understate worker spend.
