# Tiered Disclosure Design

[English](tiered-disclosure-design.md) | [简体中文](tiered-disclosure-design.zh-CN.md) · [Terms](tiered-disclosure-design.terms.yaml)

The sequential tier-opening path is implemented and opt-in for general search; Pi automatic recall enables it. Calibrated SPRT remains future work. The original 2026-08-25 rollout table below is a historical report, not a current verification receipt.

**Updated:** 2026-10-16

**Related:** [Progressive recall](fibonacci-progressive-recall.md), [progressive retrieval](design/progressive-retrieval.md), [implementation lineage](implementation-lineage.md), and the [retrieval design](design.md).

## Current source contract

Without `tieredDisclosure`, direct retrieval searches through the caller/budget tier ceiling in one pass. With `tieredDisclosure: true`, retrieval starts at tier 0 and opens deeper tiers in order while deterministic QPP says the current direct evidence is insufficient, stopping at the tier ceiling. `tiersOpened` records the path. This does not claim an SPRT or calibrated probability.

- General callers opt in through `SearchOptions.tieredDisclosure`; the CLI flag is `nmg search --tiered-disclosure`. Omitting the flag does not enable sequential tier opening.
- Pi automatic recall sets `tieredDisclosure: true`; this caller-specific default does not make it the default for every `searchContext` caller.
- `maxTier` / the active-graph budget bounds the available tier ceiling. The gate does not create a new tier or override that ceiling.
- `progressiveWarmDisclosure` and `--full-warm` govern a separate presentation window within warm results. They are not the same mechanism as opening storage tiers.
- The deterministic QPP trigger controls continuation; no calibrated likelihood ratio is used. Core selection and caller defaults are described in [Progressive recall](fibonacci-progressive-recall.md).

The current path is implemented in [`retrieval.ts`](../../src/core/store/retrieval.ts), with its option in [`types.ts`](../../src/core/types.ts). The CLI mapping is in [`commands.ts`](../../src/cli/commands.ts); Pi automatic recall wiring is in [`.pi/extensions/nmg/index.ts`](../../.pi/extensions/nmg/index.ts).

## Design rationale and proposed statistical extension

The design treats tier as a sequential gate over the existing evidence and token budgets, not as another independent budget dimension. In sequential mode, tier 0 is inspected first; deeper tiers open only when the deterministic sufficiency signal triggers, and previously opened tiers remain in the query. A shallow miss is preferable to an unbounded deep scan when the budget is exhausted.

A calibrated sequential probability ratio test (SPRT) was proposed as a future alternative. Its likelihood ratio would compare “evidence sufficient with opened tiers” against “still insufficient”; upper and lower thresholds would stop or open another tier. The proposal requires calibrated probabilities. Current QPP components are deterministic scores, so the runtime uses the deterministic QPP decision instead. The Wald references and stopping-time formula in the earlier draft are theoretical motivation, not an implemented controller or NMG performance claim.

The design also distinguishes tier opening from warm-result presentation. The `progressiveWarmDisclosure` two-window path can expose a warm prefix and later load deferred IDs; tiered disclosure decides whether to retrieve deeper storage tiers. Both may be used in one caller, but neither implies the other.

## Evaluation boundary

Latency, deep-evidence recall, context economy, and tier dynamics were stated as falsifiable evaluation targets, not established outcomes. The 2026-08-25 rollout table recorded implementation and then-current targeted test reports, with scale/recall evaluations still pending. Those reports are historical; no tests or benchmarks were run in this documentation pass. Consult the current test/evaluation artifacts before making a new performance claim.

The dated note also proposed using access counts to inform maintenance. Tier-open frequency is a demand signal, not proof of semantic usefulness; promotion, retention, and answer evidence remain separate decisions.

## Historical rollout snapshot (2026-08-25)

The original rollout report recorded `maxTierBudget`, `tiersOpened`, and `deepEvidence`; an opt-in CLI tiered-disclosure path; Pi automatic recall wiring; and bounded headers with `nmg_get` as the exact unlock. It reported targeted unit/adapter tests as passing while scale, recall, and agent-utility evaluations remained pending. This table is retained as a dated report only; it is not a fresh test receipt and must not be used to imply current run status.

Implementation history and current owners are indexed in [implementation lineage](implementation-lineage.md).

## Non-goals

- No additional memory tier; the gate operates within the existing tier and retention model.
- No independent learned quota for every tier.
- No LLM call in the deterministic insufficiency signal.
- No change to tier assignment solely by enabling sequential disclosure.

## Source references

- [`SearchOptions` and tier budgets](../../src/core/types.ts)
- [Sequential tier retrieval and QPP continuation](../../src/core/store/retrieval.ts)
- [CLI option](../../src/cli/commands.ts)
- [Pi automatic-recall caller](../../.pi/extensions/nmg/index.ts)
- [Progressive-recall design](fibonacci-progressive-recall.md)
- [Progressive-retrieval design](design/progressive-retrieval.md)
- [Current implementation lineage](implementation-lineage.md)