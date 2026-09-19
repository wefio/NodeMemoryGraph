# Fusion quality field trial, 2026-09-19

Two arms, one real model, one board run each. The question the trial exists to answer is whether
continuing a session buys anything in quality or cost at a boundary; the arms differ in one
declaration, so anything else that differs is not the comparison.

## What ran

`plan-driver.ts run --slots 1 --live` over `fixtures/pipeline/fine.spec.json`, whose four units
(`normalize`, `scale`, `total`, `summarize`) each patch one file and are checked by their own test,
with the composed pipeline as the fixed parent acceptance.

| Arm     | Spec                | Difference from the other arm    |
| ------- | ------------------- | -------------------------------- |
| control | `control.spec.json` | nothing (the fixture as it is)   |
| fusion  | `fusion.spec.json`  | `fusion: { unitsPerSession: 2 }` |

`make-specs.mjs` builds both from the offline fixture, refuses a fixture that already declares
fusion, refuses to guess the provider or model, and refuses a pair that differs in anything other
than the arm's id and the fusion declaration.

## Result

The control arm ran and passed: 4/4 units accepted, the composed parent accepted, `failures` 0.

| Term            | Control                                |
| --------------- | -------------------------------------- |
| `wallMs`        | 24 849                                 |
| `tokens`        | 30 000                                 |
| `cacheRead`     | 17 408                                 |
| `cacheWrite`    | 0                                      |
| `hostMs`        | 5 145                                  |
| `hostChecks`    | 4                                      |
| `slotsUsed`     | 1                                      |
| `sessions`      | `[]`                                   |
| per unit tokens | 7 524 / 7 339 / 7 246 / 7 891          |
| per unit worker | 6 955 / 4 148 / 3 930 / (summarize) ms |

The fusion arm did **not** produce a measurement. It fails on the first unit, before the plan
reaches a second one:

```
normalize: Pi snapshot task did not finish within its bounded contract:
stopReason=error, turns=4, reads=1, artifact=no artifact
```

That path is the one only the fusion arm takes: `piSessionWorker` with `--session-runner`, which
holds one runner per session and creates the first one with `chain: true`. The control arm's worker
calls `executePiPatch` instead, which creates a session per call (`chain: false`), and it works with
the same provider and model.

## This is not the layer move

The same spec, run with `02964663` (the commit before the session mechanism moved from
`.pi/extensions/nmg/ooo-execution.ts` into `src/integration/ooo-session-mechanism.ts`), fails with
the identical line - same `turns`, same `reads`, same `stopReason`, no artifact. `fusion-premove.json`
is that run. So the failure is in the live `chain: true` path and predates the move; the move is not
the cause, and no measurement was lost by it.

What the move did break was found the same way and is fixed: `plan-driver.ts` still asked the adapter
for `patchSessionInput`, which the adapter no longer owns, and the run said
`patchSessionInput is not a function`. `tests/integration/ooo-session-layering.test.ts` now checks
that rule over static imports, awaited dynamic imports and type-position imports.

## What is left before the fusion numbers mean anything

Fix the live `chain: true` path, then run this same pair again with `--runs` above 1: one failure is
not a rate, and the fusion arm has never once completed a live unit, so nothing here says fusion is
good or bad - only that the arm could not be measured yet.

The raw results and specs are this directory; the run's own stdout, which contains the delivered
artifact bytes, stays in the worktree's `.temp/trial/` and is cleanable.
