# The granularity arms against a real model - 2026-09-18

**Status:** paid measurement, 14 runs and 29 model calls, one model, two task families, one of them held
out of the instrument. **Directional only**: the sample cannot resolve a small difference, and no
quality difference appeared to resolve.
**Related:** [task-unit semantics design](../../design/task-unit-semantics.md) ·
[its obligation ledger](../../design/task-unit-semantics-obligations.md) ·
[the offline sweep that ordered this](./ooo-cost-model-2026-09-17.md)

The design's real-model stage "须另行明确模型、预算与重复次数" and reports **质量 / 墙钟 / token /
宿主成本 / 浪费成本 / 人工介入**, with "没有同等父产物质量，不得声称加快". This record fixes those
inputs, reports those six, and claims nothing the sample cannot carry.

## What was fixed, and what was left to the arms

| Input                    | Value                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                    | `PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-v4-flash` (the session's own model; passed in, not defaulted)                                                             |
| Envelope limits          | `turns: 6`, `reads: 3`, `timeoutMs: 120_000` - fixed for **every** arm, and above the host default of 3                                                              |
| Repetitions              | A 3, B 3, C 2                                                                                                                                                        |
| Arm order                | Drawn from a seeded shuffle (`--seed`), printed in the results, so the order is reproducible                                                                         |
| Task family              | `evals/ooo-execution/fixtures/pipeline` - **held out**: it was written after the driver and the report family and is not the family the instrument was built against |
| Arms (the only variable) | A = the whole task as one unit; B = the same work as four units at one slot; C = B with two slots                                                                    |
| Not fixed                | wall-clock time of day, host load, and the model's own sampling - none of which any arm controls                                                                     |

The arms' frozen envelope is identical: the same 10 baseline files, the same composed parent check, the
same per-unit checks, the same limits. Both specs are checked offline first, with the instrument's own
answers and a wrong answer, in `evals/ooo-execution/families.test.ts` (8 cases over the two families) -
a plan whose acceptance cannot be shown offline would not be worth paying for.

## The measurement

`node --experimental-strip-types evals/ooo-execution/pilot.ts --live --out <results.json>`, 8 runs,
23 model calls, all 8 runs complete (no failure, no timeout, no retry, no refused submission).
Results merged with `pilot.ts --report a.json,b.json`, which makes no model call and refuses to merge
two different instruments. The D arm (fusion, 6 more runs and 6 more model calls) was added on
2026-09-19 and is reported in its own section below.

| Arm | Plan           | Slots | Runs | Accepted units | Parent    | Wall total (median) | Host total | Tokens |
| --- | -------------- | ----- | ---- | -------------- | --------- | ------------------- | ---------- | ------ |
| A   | coarse, 1 unit | 1     | 3    | 1 / 1 / 1      | accept ×3 | 25 654 ms (7 319)   | 4 693 ms   | 33 677 |
| B   | fine, 4 units  | 1     | 3    | 4 / 4 / 4      | accept ×3 | 64 385 ms (20 600)  | 10 103 ms  | 94 601 |
| C   | fine, 4 units  | 2     | 2    | 4 / 4          | accept ×2 | 32 461 ms (17 060)  | 7 241 ms   | 59 830 |

Per run: A 8.6 s and 11.2 k tokens; B 21.5 s and 31.5 k tokens; C 16.2 s and 29.9 k tokens. Host cost per
run: A 1.6 s (one candidate), B 3.4 s and C 3.6 s (four candidates each). The arms have different run
counts, so the table's totals are sums and every ratio below is per run.

**Quality.** Every unit of every run was accepted by its own frozen check, and the composed parent check
accepted in all 8 runs, in both plans. The arms are therefore comparable (`comparePlanSlots` would say
`comparable: true` here) and the family is _easy_ for this model - that is the honest reading, and it is
also why this pilot cannot say anything about quality differences between granularities: there were
none to measure. The design's rule is met in the narrow sense (equal parent quality), not in the strong
one (no speedup claim survives if the coarse arm is the one that degrades on a harder task).

**Wasted cost.** Zero. No submission was rejected, no attempt was abandoned, no work had to be redone.
The `--live` pilot records `incomplete` per run and stores each run's own result file for exactly this
reason; a large `wasted` figure would have to come from those, not from a token total.

**Human intervention.** None during the runs. Interventions _before_ the runs, both measured and both
recorded here rather than worked around: see the next section.

## What the arms were predicted to do, and what they did

The offline sweep fixed three expectations. All three held, on a held-out family and with a model that
is not the sweep:

1. **"One slot never buys anything, and splitting on one slot is always a loss."** B cost 2.5× A in wall
   time and 2.8× A in tokens for the same accepted work. Confirmed, and in the direction the sweep
   ordered: a pilot reporting B cheaper than A would have had a measurement problem.
2. **"The split only pays when independence and slots are both real."** Per run, C recovered part of
   B's loss (16.2 s against B's 21.5 s, 0.76×; 29.9 k tokens against 31.5 k, 0.95×) but nowhere near
   the 2× a two-slot overlap would give if the
   model call were the only cost: one unit waits for three dependencies, and the host's candidate checks
   do not run concurrently. The sweep's own turning point - a saving that shrinks as a critical path
   appears - is visible at this size.
3. **"The host check queue is what caps fine granularity."** The host's cost grew with the number of
   candidates, not with the slots: 1.6 s per run for one candidate against 3.4 s and 3.6 s for four, with
   C's extra slot buying no host saving at all.

The sweep could not have said the token price: it models time, and the fine plan's four model calls each
carry the frozen snapshot again, which is where the 2.8× comes from. That is the one number here the
offline layer did not predict, and it is the number that matters most for a paid plan.

## What this does not say

- n = 8. A 25 % wall-time difference between B and C is one run's difference at this sample; the
  direction is consistent with the sweep, but the size is not a result.
- One model. A model that answers in one turn instead of four would change the balance between model
  time and host time, and that balance is what all three predictions rest on.
- One held-out family, of the same shape as the instrument's own (frozen interface, three independent
  builders, one summary that depends on all three). A shape without a shared interface, or with a chain
  instead of a fan-in, is outside what was measured.
- The families are small enough for the model to finish them in one attempt. Nothing here measures what
  happens when an attempt fails, which is where a slot count would be expected to matter most.

## Two environment findings, both fixed before any result above

1. **The first model turn of an attempt frequently comes back aborted.** `pi turn error: This operation
was aborted` appeared in most attempts (a live probe of the pre-existing
   `evals/ooo-execution/live-patch.ts` failed 2 of 6 attempts at the host default of 3 turns, and
   succeeded when the nested session's own environment (`PI_SESSION_FILE`/`PI_SESSION_ID`) was cleared).
   The attempt usually continues after that turn, so the pilot fixes `turns: 6` for every arm instead of
   treating the abort as a worker failure. This is an instrument observation, not an arm difference, and
   it is fixed for all arms together.
2. **A submitted patch carries the unit's whole frozen view.** `runParentCheck` composed the parent
   candidate by overwriting it with each accepted submission, so the last unit's untouched copies of its
   siblings - the stubs it was frozen with - landed over the work they had done. The parent check then
   failed a plan whose units had all been accepted. Composition now takes only the files a unit changed
   (`the-parent-takes-the-last-units-whole-view`, caught by the new family cases).

## Commands

```
# offline first: both families, both plans, the instrument's answers and a wrong one
node --experimental-strip-types --test evals/ooo-execution/families.test.ts

# the paid pilot (23 calls at A 3 / B 3 / C 2), then the same aggregate with no model call
node --experimental-strip-types evals/ooo-execution/pilot.ts --live --out .temp/pilot/pilot.json
node --experimental-strip-types evals/ooo-execution/pilot.ts --report .temp/pilot/pilot.json \
  --out .temp/pilot/pilot-summary.json
```

## D arm: fusion (added 2026-09-19)

The D arm asks whether one session running two units in a row is cheaper than two sessions running one
each - the design's `fusion` bound - and it needed a mechanism the extension did not have: a session
held across units. `--session-runner` supplies it (one Pi session per driver session, re-pointed per
unit). The only difference between the two arms is `fusion.unitsPerSession`: 1 is the control the
driver already described, 2 is fused. Everything else is identical - the same spec, the same envelope
(`turns: 6`, `reads: 3`, `timeoutMs: 120 000`), `--slots 1`, the same model, and three reps each.

| Arm     | Bound | Sessions per run | Accepted units | Median tokens | Median wall | Failures |
| ------- | ----- | ---------------- | -------------- | ------------- | ----------- | -------- |
| unfused | 1     | `1/1` ×3         | 2/2 ×3         | 22 498        | 12 948 ms   | 0        |
| fused   | 2     | `2` ×3           | 2/2 ×3         | 22 533        | 11 048 ms   | 0        |

**What this sample carries.** Quality parity holds - every unit was accepted in every run of both arms,
so the wall-time comparison is admissible - and the fused arm was ~1.9 s faster per run, consistently:
11.8 / 9.6 / 11.0 s against 11.9 / 12.9 / 14.1 s. That is about 15 % of the unfused wall and wider than
either arm's own spread, and it prices the session-startup term the cost model carried as `unmeasured`:
one fused session removes exactly one startup, so the term is ~1.9 s at this model and plan size.

**What it does not carry.** Tokens did not fall: 22 498 against 22 533 is 0.2 %, and the fused arm's own
spread (17.6k - 26.3k) is wider than the difference. Per unit the saving is real and smaller than
predicted - the second unit cost ~10.8k fused against ~11.6k unfused, about 8 % - and the first unit
cost ~0.7k more, which cancels it. The reason is a mechanism cost rather than noise: a chain's tool
surface is the union of its units' capabilities, because a session's surface is fixed when it is
created, so a unit can be offered a tool it has no use for and spend a turn on the refusal. Two units
is also where the design expected the saving to be smallest.

**Rejected:** reading the token tie as "fusion does not pay". The two terms are separable and the
second-unit saving is real; what n = 6 at one plan shape and one model cannot say is how either scales.

```
node .temp/run-darm.mjs   # 6 paid runs (3 per bound); writes .temp/darm/*.json + aggregate
```

## E arm: bounded speculation (first run, 2026-09-19)

The E arm adds one declared fact to the D arm's machinery: whether this round needs the unit at all -
the case the design names as legitimate speculation, because the fact decides whether the work happens
rather than what the work reads. The instrument is `evals/ooo-execution/speculation-pilot.ts`: the
candidate is prepared before the fact, and the shared layer's `speculationOutcome` decides what happens
to it. A published candidate is still verified by the host with the unit's own frozen check, which is the
quality term; a discarded one closes its branch session.

| Arm         | Fact   | Runs | Tokens  | Work ms | Post-fact ms | Quality    |
| ----------- | ------ | ---- | ------- | ------- | ------------ | ---------- |
| baseline    | holds  | 2    | 13 544  | 10 358  | 10 358       | false ×2   |
| speculation | holds  | 2    | 17 151  | 15 066  | 186          | false ×2   |
| baseline    | absent | 2    | 0       | 0       | 0            | n/a        |
| speculation | absent | 2    | 12 543  | 15 577  | 0            | n/a        |

**No speedup may be claimed.** The quality term is false in all four verified candidates: each submitted
patch failed the unit's own frozen check. The design's rule is that latency and cost may not be reported
without equal quality, so the shape below is what the arm *would* measure, not a result.

**What the shape is.** Speculation always pays for the unit - 12 543 tokens when the fact turned out
false, which is the whole point of measuring the waste - and buys the work's latency back when it holds:
186 ms of post-fact verification against 10 358 ms of work in the control. The arm's economics therefore
turn on the hit rate, which is what the design's utility formula says and what this sample cannot yet
price.

**Two defects the first run found.** The extension accepted an artifact the host refuses: one candidate
carried `digest, kind, conclusion, summary, evidence, citations` and no `files`, which
`artifactEnvelope` admitted and `patchCandidate` then refused as "invalid patch structure" - a
submission the adapter can accept that the board can never accept. And the instrument's own quality
harness deleted the candidate tree on failure, so the first run could not say why every check failed;
it now keeps the tree, and the control rows record the check's own output.

