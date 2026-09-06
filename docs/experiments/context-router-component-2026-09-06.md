# Context router component probe — 2026-09-06

Status: measured custom component experiment; no default activation.

## Protocol

Command: `node --experimental-strip-types evals/controller-shadow/context-probe.ts`.
The runner creates a fresh `.nmg/context-probe/<timestamp>/` containing
`events.jsonl`, `evidence.json` (rendered contexts and source IDs) and `report.json`; it refuses to overwrite an existing event file.
No embedding provider, main LLM, or LLM judge is invoked.

- Dataset: local LoCoMo `locomo10.json` through the existing retrieval dataset loader.
- SHA256: `553cd5a15e25f2ceccc6ed185221eba645080c93e5b91087560a91aa5961f365`.
- 1532 questions with evidence, 6128 actually executed context actions.
- Source-user hash partitions: 5 train, 2 validation, 3 test groups.
- Fixed custom lexical message ranking; not the product NMG retrieval path.
- All four actions executed on identical per-question source snapshots; assignment
  is deterministic enumeration (probability 1 per branch), not randomized natural use.
- Equal hard envelope: 4000 context characters, at most one retrieval invocation.
- `resurface`: first ranked message; `retrieve`: first five, fitting whole fragments.
- Reward: gold-evidence coverage, no main-model answer or downstream success metric.
- 132-parameter linear head, learning rate 0.01; 1/5/20 epochs selected on validation.
- Cost penalty fixed at zero; token count is character/4 estimate, not provider usage.
- History features missing because these are independent question snapshots.

## Result

Validation selected one epoch; all 331 validation decisions selected retrieve.
On the 354 held-out questions:

| Policy | Evidence coverage | Estimated context tokens/question | Actions |
| --- | ---: | ---: | --- |
| Fixed retrieve | 0.3505885122 | 258.0763 | 354 retrieve |
| Linear router | 0.3505885122 | 258.0763 | 354 retrieve |

All 6128 outcome rows were admitted by the component scorer binding; no rows
were excluded. This verifies the exercised collection/replay/training/report
path with real benchmark source data, not external verifier attestation.

## Review follow-up: costs, independence and durability

A/B review prompted an awaited journal barrier, execution-result fingerprints,
executor-call lower-bound checks and local append/fsync trial logging. These
protect the component sample path, not production model exposure or distributed
recovery. Source contexts and IDs are retained in `evidence.json`.

The report now exposes per-group row counts rather than just question totals:
train 5 groups/3388 rows, validation 2 groups/1324 rows, test 3 groups/1416 rows.
The test groups contribute 600, 324 and 492 rows respectively. Those 1416 action
rows represent only **three independent source units**, not 1416 independent
observations. Sparse-group warnings are transparency notices, not statistical
power or activation gates.

A validation-only diagnostic scans cost multiplier lambda using pinned illustrative
pre-action token estimates `[0,21,200,800]` and latency estimates `[0,0,1,10]` ms;
prices are 1 per thousand tokens and 1 per second. These are not measured provider
costs or fitted optimal prices. Q is trained on unpenalized coverage; selection
subtracts cost once, avoiding double charging the learning target.

| Lambda | Validation decisions | Evidence coverage | Estimated context tokens/question |
| --- | --- | ---: | ---: |
| 0 | 331 retrieve | 0.3456493654 | 268.4592 |
| 0.1 | 331 retrieve | 0.3456493654 | 268.4592 |
| 1 | 331 none | 0 | 0 |

This demonstrates cost sensitivity, **not improved utility**. Synthetic regression
tests separately verify a small retrieval marginal gain switches to resurface
under token or latency prices, without changing permissions or model Q values.
The already-inspected test set is not reused to tune lambda or claim a fresh
independent confirmation. Static matched snapshots cannot measure sequential
history by construction; adding historical nodes here would not repair that.

## Interpretation and limits

No benefit over the fixed rule was observed. This is unsurprising: an evidence-only
coverage objective gives no value to cue and favors adding ranked source content.
The experiment cannot justify a larger router, recurrent state, historical-node
attention, natural task convergence or default activation. Three test groups are
not a broad generalization claim. No significance or causal full-task benefit is
asserted.

Next efficacy experiments must include model-exposed context, official answer
scoring, matched end-to-end budgets and sequential task outcomes for any history
claim. This test set has now been inspected; later tuning against it is exploratory,
not another independent held-out confirmation.

Owning specification: [agent convergence feedback](../design/agent-convergence-feedback-design.md).
