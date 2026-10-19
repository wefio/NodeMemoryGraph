# QPP engineering lessons: two audit failures

[English](engineering-notes.md) | [简体中文](engineering-notes.zh-CN.md) · [Terms](engineering-notes.terms.yaml)

> **Status:** Historical retrospective from the work between commits `dd41829` (QPP shadow wiring) and `d86b658` (the squash fix), with a later correction at `86c837f`. These incidents explain how the prototype changed; they are not a description of the current score. See the [current QPP design](../../design/retrieval-confidence-controller.md).

## Failure 1: clamping saturated the score and erased gradation

**Observed at the time:** On a seven-question LongMemEval run, `audit-qpp-signal.ts` produced two QPP clusters: about `0.15` for empty retrieval and `1.35` for non-empty retrieval. Both buckets had `0.33` accuracy, so the score did not discriminate within this tiny sample.

**Cause:** A result-mapping path assigned `combinedScore` the raw lexical score (measured around `84`), rather than the bounded `hybridScore`. `contextUsefulness` inherited that scale. The prototype clamped usefulness to `[0,1]`, so non-empty results saturated at `1.0`; `Top1` became constant and variance became zero. The formula collapsed to “did retrieval return anything?”

**First attempted fix:** Replace the clamp with a bounded squash, `s(x) = max(0,x)/(max(0,x)+10)`. It mapped `84 → 0.894`, `20 → 0.667`, and `5 → 0.333`, restoring gradation for the observed raw-scale values. Commit `d86b658` records this intermediate repair.

**Later correction:** The audit's raw lexical scale did not describe every live path. The same `combinedScore` field could be a bounded hybrid score on one path, raw lexical-scale (~84) on another, or zero for `#resultsForNode`. No single squash constant preserved both scales. The final score path recomputes `hybridScore` from `selections.scores.{lexical,vector,route}` and uses that bounded `[0,1]` value as strength. See commit `86c837f` and the current [`qpp.ts`](../../../src/core/qpp.ts).

**Lesson:** Do not infer scale from a field name. Inspect the producing paths and real traces before applying clamp, sigmoid, or squash. Tests need examples from every scale-bearing path, not only clean `[0,1]` fixtures.

## Failure 2: `intentCoverage` had no variation in benchmark traces

**Observed at the time:** All seven benchmark questions had `intentCoverage=0.5` (neutral), so the signal had no variation in that sample.

**Cause:** LongMemEval ingest stored records as `conversation_evidence`; the benchmark import paths did not produce preference, fact, event, or state types. In addition, many AutoRecall queries did not match the intent patterns. The feature therefore had no expected type to check or no matching typed record to find.

**Lesson:** A feature can depend on the data shape, not only the algorithm. Check its distribution on the target traces before training weights; a constant feature has no discriminating value there. The current runtime retains `intentCoverage` for diagnostics but excludes it from the QPP score.

## Method lessons

1. **Shadow-first makes failures cheap to observe.** The prototype recorded QPP without changing retrieval behavior. Shadow traces made it possible to find the saturation bug before it could silently cause false triggers or missed triggers.
2. **Pure-function replay can avoid model calls.** When a metric is a pure function of persisted selections and records, historical traces can be recomputed without rerunning an LLM or paying provider cost. `audit-qpp-signal.ts` was an example of this approach.
3. **Audit before calibration.** First inspect feature distributions and path scales on real traces. Tuning weights on a tiny sample or on constant features learns noise, not a reliable policy.

## Historical next steps

The original note proposed typed ingest as a prerequisite for an informative `intentCoverage` signal and additional trace review before calibration. Stage-0 progressive wiring has since been implemented; current defaults, score composition, and remaining calibration boundaries are owned by the [current QPP design](../../design/retrieval-confidence-controller.md). This retrospective does not claim that a calibrated trigger or general retrieval improvement followed from the seven-question audit.