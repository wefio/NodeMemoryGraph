# Fusion quality field trial, 2026-09-19

Two arms, one real model, one board run each. The question is whether continuing a session buys
anything in quality or cost at a boundary; the arms differ in one declaration, so anything else that
differs is not the comparison.

## What ran

`plan-driver.ts run --slots 1 --live` over `fixtures/pipeline/fine.spec.json`, whose four units
(`normalize`, `scale`, `total`, `summarize`) each patch one file and are checked by their own test,
with the composed pipeline as the fixed parent acceptance. Provider `deepseek`, model
`deepseek-v4-flash`, the default declared limits for both arms.

| Arm     | Spec                | Difference from the other arm    | Sessions                             |
| ------- | ------------------- | -------------------------------- | ------------------------------------ |
| control | `control.spec.json` | nothing (the fixture as it is)   | four, one unit each                  |
| fusion  | `fusion.spec.json`  | `fusion: { unitsPerSession: 2 }` | two, two units each (`fusion6.json`) |

`make-specs.mjs` builds both from the offline fixture, refuses a fixture that already declares
fusion, refuses to guess the provider or model, and refuses a pair that differs in anything other
than the arm's id and the fusion declaration.

The two stored spec files are the trial's inputs as they were recorded, and they carry the check
declaration of their day (`{label, command, args}`). The arms' driver now declares a check as the
fixture test file it runs (`{label, test}`) and refuses the older form by type, so re-running this
plan means regenerating the pair with `make-specs.mjs` from the current fixture
([decision](../../../decisions/implemented/2026-09-20-tests-need-no-filesystem.md)).

## Result

Both arms accepted all four units and the composed parent; neither produced a rejected unit, so this
pair says nothing about quality differences and everything about cost.

| Term            | Control                       | Fusion                        | Fusion / control              |
| --------------- | ----------------------------- | ----------------------------- | ----------------------------- |
| units accepted  | 4 / 4                         | 4 / 4                         | -                             |
| parent verdict  | accept                        | accept                        | -                             |
| `tokens`        | 30 000                        | 34 601                        | **1.15x**                     |
| `cacheRead`     | 17 408                        | 24 064                        | **1.38x**                     |
| `cacheWrite`    | 0                             | 0                             | -                             |
| `wallMs`        | 24 849                        | 16 054                        | **0.65x**                     |
| `hostMs`        | 5 145                         | 4 089                         | 0.79x                         |
| `hostChecks`    | 4                             | 4                             | -                             |
| `sessions`      | 4 fresh                       | 2 fused                       | -                             |
| per-unit tokens | 7 524 / 7 339 / 7 246 / 7 891 | 7 873 / 9 635 / 7 601 / 9 492 | 1.05x / 1.31x / 1.05x / 1.20x |

So on this fixture, this model and one rep each: fusion did not save tokens, it spent 15% more, and
the per-unit deltas are all positive. The wall clock was 35% lower. The second unit of a fused
session is where the spend is, and it is higher, not lower - a warm context is a longer context, and
the claim that a continued session spends less on the next unit is not what this pair shows.

## What the arm cost to measure, and the two defects it found

The fused arm first produced no measurement at all: it died on its first unit, aborted at turn 4 of a
declared 3. The failures were legible only after the instrument was fixed - the error line now prints
turns and reads against their limits, the tools the unit called, and the envelope's last refusal.
With that, in order:

1. `stopReason=error, turns=4/3, reads=1/2` - an abort, with no reason visible.
2. `calls=read_snapshot,run_check,submit_artifact, artifact=no artifact` - the model spent a turn on
   `run_check`, a tool the session exposes for its other units and which this unit has no check for.
3. `last refusal: a patch carries files only; it cannot also carry a conclusion` - the submission was
   refused because it carried both answer channels, a rule that lives in the envelope and that no
   schema can express. A single attempt gets a literal union for the conclusion, so it rarely guesses;
   a fused session fixes its surface at creation and can only loosen that union to a string, so both
   rules moved out of the schema and into the prompt for that path alone.

`patchSessionInput` carries them now, gated on `looseConclusion`, and the strict path is
byte-identical to what it was (asserted in `tests/integration/ooo-session-chain-contract.test.ts`), so
the control arm recorded above still describes the code that produced it.

## What this does not say

One rep per arm, so no spread is known here and none of the ratios above is established. The D arm ran
three reps per arm on another two-unit plan and its per-run token spread was 17.6k - 26.3k, wider than
the 15 % difference this pair shows, so the direction is a direction. `control.json`, `fusion5.json`
(the diagnostic run) and `fusion6.json` (the measured one) are the raw results; `--runs` above 1 would
make a rate out of them. Nothing here separates the cost of a warm context from the cost of running two
units under one surface, and the fixture's units are small enough that a session's startup may still
dominate.
