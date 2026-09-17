# A granularity and cost sweep before any paid call - 2026-09-17

**Status:** offline measurement. No model call was made; nothing here is a result about model quality.
**Related:** [task-unit semantics design](../../design/task-unit-semantics.md) ·
[its obligation ledger](../../design/task-unit-semantics-obligations.md)

The design orders the arms as "离线模型先覆盖不同粒度、依赖密度、共享上下文、事实命中率及验证成本；它只能
发现逻辑错误和成本转折点，不能预测真实模型质量", and says the real-model stage "须另行明确模型、预算与
重复次数". The repository had no such offline layer: `rg "simulat|离线|stub worker"` over `evals/` and
`docs/experiments/` found nothing. This record is the first pass of one, and what it changed about how
the paid pilot should be run.

## The instrument

`evals/ooo-execution/cost-model.ts` (advisory, `--sweep` and single-vector modes) plus
`evals/ooo-execution/cost-model.test.ts` (8 cases).

Plan shape: `units` (granularity), `density` (the fraction of possible forward edges that exist, so 0
is fully independent and 1 is a chain), `seed`. The graph is **derived** from the seed rather than
written by hand, so a gain cannot come from a shape picked to produce one.

Cost vector, with what each term stands for:

| Term                    | Stands for                                                  | Status                                     |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `workMs`                | one agent call's latency                                    | measured range in earlier rounds (seconds) |
| `rederiveMs` × ¬hitRate | re-deriving an artifact a fact hit would have removed       | **assumed**, swept                         |
| `verifyMs`              | one host candidate check, one at a time                     | measured order (~1.5 s)                    |
| `contextMsPerUnit`      | a legal session boundary                                    | **assumed**, swept                         |
| `coarseContextSaving`   | what one session saves by not paying that boundary per unit | **assumed**, this is the term to argue     |
| `slots`                 | execution slots                                             | the arm's manipulated variable             |

The schedule is greedy list scheduling over `slots`, followed by **one host check queue**: a candidate
check never runs concurrently with another check. A dependency is satisfied by an _accepted_ artifact,
so a unit waits for its predecessor's check, not for its model call — which is the difference the
out-of-order round exists to exploit.

## What the model got wrong first

Its initial self-check demanded that four independent units on four slots finish in "one unit plus one
check". It did not, and the model was wrong, not the check: the host serialises four checks, so the
floor is one unit **plus four** checks. That number is now the check. The same instrument without the
queue would have reported a concurrency gain no round can have.

## The sweep

Base vector: work 8 s, re-derive 6 s, hit rate 0.5, verify 1.5 s, context 1.2 s per unit, coarse
saving 0.5, 4 slots. Milliseconds.

| density | units | coarse | fine, 1 slot | fine, multi-slot | saved by slots | critical path | gain vs coarse |
| ------- | ----- | ------ | ------------ | ---------------- | -------------- | ------------- | -------------- |
| 0       | 1     | 11 900 | 13 700       | 13 700           | 0              | 13 700        | **−1 800**     |
| 0       | 2     | 23 800 | 25 900       | 15 200           | 10 700         | 13 700        | +8 600         |
| 0       | 4     | 47 600 | 50 300       | 18 200           | 32 100         | 13 700        | +29 400        |
| 0       | 8     | 95 200 | 99 100       | 30 400           | 68 700         | 13 700        | +64 800        |
| 0.25    | 2     | 23 800 | 27 400       | 27 400           | 0              | 27 400        | **−3 600**     |
| 0.25    | 4     | 47 600 | 51 800       | 30 400           | 21 400         | 27 400        | +17 200        |
| 0.5     | 4     | 47 600 | 51 800       | 41 100           | 10 700         | 41 100        | +6 500         |
| 1       | 4     | 47 600 | 54 800       | 54 800           | 0              | 54 800        | **−7 200**     |
| 1       | 8     | 95 200 | 109 600      | 109 600          | 0              | 109 600       | **−14 400**    |

## What it says, and what it does not

1. **One slot never buys anything, and splitting on one slot is always a loss.** This is the design's
   B arm, and the model says B should be _worse_ than A on cost: it pays a session boundary per unit
   and overlaps nothing. A pilot that reports B cheaper than A has a measurement problem, not a
   finding.
2. **The split only pays when independence and slots are both real.** A single dependency edge among
   two units (density 0.25, units 2) turns the gain negative; a chain (density 1) is negative at every
   granularity (−14.4 s at 8 units), because the boundaries are added and nothing is overlapped.
3. **The host check queue is what caps fine granularity.** Every unit adds a serial check, so the
   fine arm's floor is one unit plus _units_ checks; the coarse arm pays the same number of checks in
   this vector, which is why the gain does not grow without limit with independence alone.
4. **It cannot say anything about quality, and it does not pretend to.** `cost-model.test.ts` fails if
   the result object ever grows a key matching `/quality|pass|accept|correct|success/i`, so a simulated
   pass rate cannot quietly become a reported one. The design's caveat stays true by construction.

## Consequences for the paid pilot

- Choose a parent task whose legal refinement yields **several** units (≥ 4) with **density well below
  0.5** and per-unit checks that do not dominate the unit's work. A refinement that yields two units or
  a chain is predicted to lose, and running it would spend tokens to confirm the model.
- Expect A < B on cost and A ≈ B on quality, with the gain (if any) appearing only at C. A pilot that
  shows a B-arm cost saving contradicts this sweep and needs its instrument checked first.
- Fix the model, budget and repetitions separately, as the design requires; this record fixes none of
  them and used no paid call.

## Commands

```
node --experimental-strip-types evals/ooo-execution/cost-model.ts --sweep --out .temp/cost-sweep.json
node --experimental-strip-types --test evals/ooo-execution/cost-model.test.ts   # 8 pass / 0 fail
```
