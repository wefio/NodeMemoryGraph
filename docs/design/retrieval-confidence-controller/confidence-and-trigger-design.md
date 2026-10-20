# QPP score, progressive trigger, and controller wiring

[English](confidence-and-trigger-design.md) | [简体中文](confidence-and-trigger-design.zh-CN.md)

**Authority:** [Parent scope](../retrieval-confidence-controller.md).

## Current score and trigger

QPP rebuilds each candidate strength with `hybridScore(scores.lexical, scores.vector, scores.route)`. It does not use `combinedScore` or `usefulness`: those values can have path-dependent scales. The recomputed strength is bounded to `[0,1]`; score-based components use direct selections, not `graph_expansion` selections.

The current score is:

```text
C = Top1 + 0.5 × NQC
NQC = clamp(stdev(direct strengths) / mean(direct strengths), 0, 1)
```

`Top1` is the maximum direct strength. `NQC` is `0` with fewer than two direct candidates or a near-zero mean. `variance`, `intentCoverage`, `reasonHealth`, `topGap`, `expansionDependence`, and `expansionRisk` are returned for diagnostics, but do not contribute to `C`. In particular, the earlier weighted formula using variance, intent coverage, and reason health is not the current runtime score.

The default threshold is `0.55`; `C < threshold` triggers `below_threshold`. The deterministic guardrails trigger independently of that threshold:

- no candidates: `guardrail_empty`;
- at least one direct candidate and `reasonHealth === 0` (every direct candidate is a `hybrid_match` fallback): `guardrail_all_fallback`;
- `Top1 < 0.2`: `guardrail_low_top1`.

These rules estimate retrieval sufficiency, not answer truth. `reasonHealth` is the share of direct selections whose reason is not `hybrid_match`; `intentCoverage` is neutral `0.5` when no recognized query-intent family matches.

## Progressive re-selection

The second pass re-selects cumulative Fibonacci prefixes from one over-sampled candidate pool; it does not launch another ANN/FTS search. The current walk uses the original graph-hop ceiling: the larger evidence envelope does not mean relation expansion is progressively rerun.

- `initialEvidenceTarget` defaults to `13`. If the relative `Top1`-to-`Top2` gap is at least `0.05`, the initial target is reduced to at most `3` (`strongHitInitialTarget`).
- Targets remain Fibonacci rungs. The caller's `limit` is a hard ceiling; the walk does not synthesize an intermediate rung. If the ceiling is below the initial rung, no tier at that rung is visited.
- At a visited rung, QPP stops the walk when sufficient. Candidate-pool exhaustion, the caller limit, or the expanded evidence budget can also stop it. `QppTriggerDecision.expansion` records visited targets, selected counts, estimated tokens, decisions, and the stop reason; it does not record per-tier memory IDs.

### Caller-specific activation

| Caller | Default | Meaning |
| --- | --- | --- |
| `searchContext()` | `secondPass` off | Computes the initial QPP decision but does not walk tiers unless the option is true. |
| `searchContextWithSecondPass()` | `secondPass` on | Convenience wrapper; an explicit option can override it. |
| CLI `nmg search` | off | `--second-pass` opts in. |
| Pi extension | `NMG_QPP2_MODE=off` | Active QPP2 turns on progressive retrieval and attempts the learned fold; the fold still needs an actuating controller channel. |
| `OmniMemEvalBridge` | `secondPass` on | Its constructor option can override this evaluation-specific default. |

Do not read one caller's default as the product-wide default. The Pi `NMG_QPP1_MODE` is separate: it defaults to `shadow`; allocation is wired only for an explicit Pi search without a caller-supplied `limit`, and the returned budget remains hard-bounded.

## Calibration and evidence limits

`DEFAULT_QPP_WEIGHTS` fixes the NQC coefficient at `0.5`; `DEFAULT_QPP_THRESHOLD` is `0.55`. These are conservative uncalibrated operating points, not a matched, production-certified optimum. The default initial target `13` is tied to a bounded LoCoMo measurement; see [progressive recall](../fibonacci-progressive-recall.md).

The 2026-08 LoCoMo signal experiment used session-grouped folds. The normalized-dispersion feature reached AUC `0.667` for `complete@20` and `0.470` for `multi_evidence`; these results do not establish evidence-count prediction or generalize beyond that sample. See the [experiment record](../../experiments/qpp/evidence-signal-experiments-2026-08-02.md).

[`tau-worker.ts`](../../../evals/controller-shadow/tau-worker.ts) writes a candidate artifact; it does not change runtime configuration. It uses explicitly labelled `expansionUseful` rows, chronological train/validation splits, at least 50 total rows and 10 validation rows, both labels in both splits, a maximum threshold move of `0.05`, and a held-out balanced-accuracy check. The artifact always reports `eligibleForActivation: false`; the default threshold remains `0.55` (callers may explicitly override it through search options).

## Learned-controller execution boundary

`ControllerPolicyChannel` separates scoring from actuation. `NMG_CONTROLLER_RUNTIME_MODE` defaults to `shadow`; `shadow` can score but cannot allocate, fold, or rerank. `controlled` requires a trained candidate and `NMG_SHADOW_COLLECTION_ORIGIN=controlled`. `active` additionally requires an activation receipt binding the candidate hash, feature protocol, retrieval/controller/product gate artifacts, and a distinct loadable rollback target.

The Pi `ControllerShadowBridge` is an optional adapter, not the universal retrieval path. Its `allocate()` call is used by explicit Pi searches only when QPP1 is `active` and the caller omitted `limit`. The daemon Lab operation `controller_shadow` is hard-coded to shadow mode. These paths do not make research calibration a default or establish an online training loop.

## Non-goals

- Do not infer `single` versus `multi` evidence needs from the score; the cited experiment found that target near chance.
- Do not treat answer-text overlap, injection, or fetching as positive training labels. Use explicitly attributable feedback or verified evidence under the relevant data contract.
- Do not equate QPP with `MemoryRecord.confidence`, answer correctness, or a guarantee that the reader will use every returned record.

## Source references

The core score and walk live in [`qpp.ts`](../../../src/core/qpp.ts) and [`retrieval.ts`](../../../src/core/store/retrieval.ts). Caller settings are in [`config.ts`](../../../src/integration/config.ts), the evaluation default is in [`OmniMemEval bridge`](../../../evals/omnimemeval/bridge.ts), and controller gating is in [`controller-channel.ts`](../../../src/integration/controller-channel.ts), [`controller-shadow.ts`](../../../.pi/extensions/nmg/controller-shadow.ts), and the [Pi extension](../../../.pi/extensions/nmg/index.ts).