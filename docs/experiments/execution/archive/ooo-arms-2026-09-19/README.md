# Archive: the arms' paid runs (2026-09-19)

**Why this is here.** The D arm (fusion) and the E arm (bounded speculation) were run from a worktree
whose scratch lives in `.temp/`, which `.gitignore` excludes. The records before this directory quoted
numbers - 22 498 against 22 533 tokens, 12 948 against 11 048 ms, the E arm's quality failures - and the
files those numbers came from would have gone with the next temp cleanup. This is the second time on
this branch: `archive/ooo-continuation-2026-09-14/README.md` was written for the same failure mode after
row G7, and the lesson did not survive the session it was learned in. Every sample a claim in
`ooo-arms-pilot-2026-09-18.md` depends on is now inside the repository.

**What was run.** Provider `deepseek`, model `deepseek-v4-flash`, `--live` required in both entry points.
Every run's own report is kept verbatim; nothing here was edited after the fact.

| Directory                                    | Entry point                                                | Runs | What it is                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fusion-darm/`                               | `plan-driver.ts run --session-runner`                      | 6    | D arm: `fusion.unitsPerSession` 1 (control) against 2 (fused), 3 reps each                                                                                                                          |
| `fusion-darm/spec-1.json`                    | —                                                          | —    | The spec the control arm ran (bound 1), frozen envelope limits included                                                                                                                             |
| `fusion-darm/spec-2.json`                    | —                                                          | —    | The spec the fused arm ran (bound 2); `spec-1` differs only in that bound                                                                                                                           |
| `fusion-darm/aggregate.json`                 | `node .temp/run-darm.mjs`                                  | —    | The six runs plus per-arm medians, which is what the record quotes                                                                                                                                  |
| `smoke/`                                     | `plan-driver.ts run --session-runner`                      | 4    | The mechanism smoke: two units in one session, and the runs that failed first                                                                                                                       |
| `speculation-earm/`                          | `evals/ooo-execution/speculation-pilot.ts --live`          | 8    | E arm: baseline against speculation, fact true and false, 2 reps each                                                                                                                               |
| `speculation-earm/aggregate.json`            | —                                                          | —    | The eight runs plus per-(arm, fact) totals                                                                                                                                                          |
| `speculation-earm/run2-2026-09-19T05-40-04/` | `evals/ooo-execution/speculation-pilot.ts --live` (3 reps) | 9    | Second E-arm run: every attempt's artifact bytes, the candidate tree its check ran in, the check's own output, one row per run, the aggregate, and a `CLEANABLE.md` saying the directory is scratch |
| `harness-three-way.json`                     | `node .temp/p1-harness.mjs`                                | 6    | The harness validation that had to come first: frozen stub, the fixture's canned answer and a wrong answer, through the same check                                                                  |

**What is missing, and why that is now a plan item.** The E arm's first run stored no artifact bytes:
`speculation-pilot.ts` returned each candidate's verdict but deleted the candidate tree on failure, so
the run that reported "quality false in all four verified candidates" cannot be asked _why_. The
instrument no longer deletes a tree, and
`docs/experiments/execution/ooo-arm-plan-2026-09-19.md` fixes the fields every later run must write
before it is allowed to run - artifact bytes, check output, exit code and the frozen digest - so the
next paid run is diagnosable without paying twice.

**The rule this directory exists to keep.** A run's evidence is written where git tracks it, in the same
change that reports its numbers, and no run deletes its own evidence. Scratch under `.temp/` is for
working copies; a result that a sentence in a record depends on is not scratch.

**Correction (2026-09-19, after the second run's evidence).** The paragraph above recorded a defect
that was not one. `artifactEnvelope` builds two legitimate shapes - a patch (`digest, files`) and a
conclusion (`digest, kind, conclusion, summary, evidence, citations`) - and the E arm's first harness
fed _every_ artifact to `patchCandidate`, which reads patches only. The run's quality failures were
therefore reported through the wrong reader: eight of nine attempts in the second run answered with a
conclusion, which this unit's check cannot pass and the board would refuse, and the one attempt that
submitted a patch failed for a real reason (it wrote `rows: [...]` where the frozen interface requires
`lines: [...]`). The instrument now reads an artifact by its kind and records which reader was used.

## cap4-darm/ - the cap experiment (2026-09-19)

Tests the offline ceiling's prediction that one session carrying four units saves about 5 700 ms.
Entry point: `aggregate.json` (per-bound medians and the measured saving); the four runs are
`bound{1,4}-rep{1,2}.json` and the two specs are `spec-{1,4}.json`, built from
`evals/ooo-execution/fixtures/pipeline/fine.spec.json` with the canned answers stripped, so the units
really run. Measured: 5 796 ms saved against the predicted 5 700 ms, with tokens up 1.3-1.9x.

## cap-cache/ - the cap experiment with cache accounting (2026-09-19)

Re-runs the cap experiment recording cache reads beside tokens, because a chain carries its context
forward and most of what it resends is served from cache. Entry point: `aggregate.json`.
Measured: cap 1 to cap 2 saves 8 753 ms (predicted 3 800 ms, so the startup constant is plan-dependent),
fresh input stays flat at 7 925 / 7 942 / 9 142 tokens, and cap 2 is the knee - it takes most of the
available wall clock at the fewest tokens. The earlier `cap4-darm/` reading of a 1.3-1.9x token
multiplier came from unpaired medians and is superseded.

## Later note (2026-09-19, after this archive was written)

Two corrections to the text above, both found while planning the A-D comparison
([the arm plan](../../ooo-arm-plan-2026-09-19.md), P6). Neither changes a stored report.

**The scope of "every sample".** The claim above covers the D and E arms and the cap experiments, which
is what was rescued. It does not cover the A, B and C arms: the arms record quotes their totals (33 677,
94 601, 59 830 tokens) and those per-run files are not in the repository, in this directory or anywhere
else. For the coarse and slot arms there is a summary, not a sample.

**"Fresh input" was a misnomer, and "stays flat" was not measured.** `tokens - cacheRead` is the tokens
not served from cache: it still contains every output token, and the reports do not say whether the cache
figure is nested inside the total at all. The third rep for caps 1 and 2 also puts that cell's token
spread (11 946) wider than the gap it was being compared across, so the flatness in the sentence above is
a two-rep reading rather than a measurement. It is a reading of counts, not a price; pricing needs uncached input, cache reads and
output recorded apart. `cap-cache/aggregate.json` already carries this caveat in its own note, and the
live reading of the column is corrected in
[the fusion planning document](../../../../design/ooo-fusion-planning.md).

## cap-cache/, third rep (2026-09-19, later the same day)

Bought because [the arm plan](../../ooo-arm-plan-2026-09-19.md) needed the A-D cells to carry a range rather
than a two-point gap: one more rep for bound 1 and one for bound 2 of the cap experiment.

- `bound1-rep3.json` - 4/4 accepted, parent accept, wall 25 270 ms, tokens 33 941, cacheRead 20 608.
- `bound2-rep3.json` - 4/4 accepted, parent accept, wall 17 427 ms, tokens 35 444, cacheRead 24 448, two
  sessions. Run with `--session-runner`, which `spec-2.json` requires: a fused live continuation is refused
  without it.
- `bound2-rep3-without-session-runner.json` - that refusal, kept as evidence. The driver named the session
  it could not continue, recorded it in `incomplete` and stopped after the first unit, so guessing the
  command from the usage line cost 11 019 tokens instead of producing a wrong measurement.
- `aggregate-3rep.json` - both cells recomputed over all their stored reports (caps 1 and 2 at three reps,
  cap 4 still at two, nothing copied from a sentence). It is the entry point for the current numbers;
  `aggregate.json` keeps the original two-rep reading, whose medians (26 620 / 17 867 ms) are 26 186 /
  17 735 ms once the third reps are in.

**Provenance, and what the reports do not record.** The report carries the spec, the worker, the model,
the envelope limits and the session grouping; it does not carry the instrument's commit or a prompt digest.
What can be established from outside is the timing:

| runs                                    | `measuredAt` (UTC)  | instrument                                                                                               |
| --------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| caps 1, 2, 4 rep 1 and rep 2            | 06:54:14 - 06:56:06 | not recorded; earlier the same day than the chain-prompt fix, whose commit `7004f971` is dated 12:11:24Z |
| caps 1 and 2 rep 3, and the refused run | 12:32:22 - 12:33:06 | a clean tree at `4b0ba09a`, after that fix                                                               |

So the first two reps of each cell are a controlled pair - same spec, same day, minutes apart, one declared
variable - and the third rep is a later observation of the same spec under a changed prompt. The saving is
not an artefact of that change: the two-rep pair alone separates (26.2-27.1 s at cap 1 against 17.7-18.0 s
at cap 2). Recording the commit and the prompt digest with each run would remove the need for this table;
until the driver does that, comparisons say which runs share an instrument version.

**What the third rep changed.** The wall saving is 8 451 ms against within-cell spreads of 1 783 ms and
571 ms, so it is a rate. The token and cache columns are not: cap 1's own token spread (11 946) is wider
than its median gap to cap 2 (7 789), and the cache-read share of tokens runs from 0.607 to 0.847 inside a
single cell - so "80-84 % of tokens are cache reads" was a two-rep artefact. The fused cell's third rep also
ran with a newer chain prompt than its first two (the exclusivity and admitted-tools lines added earlier the
same day), which is why the runs here are read as dated measurements rather than as one instrument version.

## granularity-abc/ - the A, B and C cells on the plain path (2026-09-19)

How every cell here is compared - one declared field per pair, the grade a reading gets, and when a
spread means the sample cannot resolve an effect - has one home: [the measurement
plan](../../ooo-arm-plan-2026-09-19.md#p6---the-measurement-plan-every-cell-what-it-is-for-and-how-cells-are-compared).
The computed reading of each cell, pairs included, is stored as [`matrix.json`](matrix.json).

Bought to finish the same-parent comparison the review asked for, after the cap experiment's own cells
turned out not to be the B cell: all three cap specs declare `fusion` (bounds 1, 2, 4), so every cap cell
runs the **chain surface** - one session per slot, the loosened artifact schema, the chain prompt - even
at bound 1. `cap 1` is therefore the fused arms' same-surface control, not the plain unfused arm, and A,
B and C had to be run on the plain path to be a granularity comparison.

`spec-a.json` is `fixtures/pipeline/coarse.spec.json` (the whole pipeline as one unit) and `spec-b.json` is
`fixtures/pipeline/fine.spec.json` (four units), both with the fixture's canned answers stripped and the
cap experiment's worker and envelope substituted: `pi`/`deepseek-v4-flash`, `turns: 6`, `reads: 3`,
`timeoutMs: 120 000`, the same fixture baselines and the same parent check. C is `spec-b.json` at
`--slots 2`. Built by a script that refuses a fixture that is not the offline canned one, a fixture that
already declares fusion, a missing provider or model, an existing spec file, and a cell whose unit count is
not the one the comparison needs.

A and B/C were then repeated once each on 2026-09-19 (`b-rep2.json`, `c-rep2.json`, 30 178 and 30 472
tokens) to lift the two plain cells from a single observation to a pair, which is what the plan's grade
rule needed for Q2 and Q3. One rep per run; the medians below are over the two reps where there are two.

| arm | shape          | slots | reps | wall            | wall median | tokens          | tokens median | input         | output        | cache read      | cost (provider)     |
| --- | -------------- | ----- | ---- | --------------- | ----------- | --------------- | ------------- | ------------- | ------------- | --------------- | ------------------- |
| A   | coarse, 1 unit | 1     | 1    | 9 726 ms        | 9 726 ms    | 9 018           | 9 018         | 2 377         | 1 521         | 5 120           | 0.000773            |
| B   | fine, 4 units  | 1     | 2    | 21 885 / 23 273 | 22 579 ms   | 29 962 / 30 178 | 30 070        | 8 940 / 7 248 | 3 230 / 3 346 | 17 792 / 19 584 | 0.002206 / 0.002006 |
| C   | fine, 4 units  | 2     | 2    | 18 565 / 19 336 | 18 950 ms   | 30 674 / 30 472 | 30 573        | 7 238 / 3 813 | 3 596 / 3 491 | 19 840 / 23 168 | 0.002076 / 0.001576 |

Every unit was accepted, every parent check accepted, `slotsUsed` was the slot count asked for, and the
reports are `a-rep1.json`, `b-rep1.json`, `b-rep2.json`, `c-rep1.json`, `c-rep2.json` beside
`aggregate.json` and the computed [`matrix.json`](matrix.json). These are the first runs whose report
carries the usage split and the instrument:

- `tokens` is exactly `input + output + cacheRead + cacheWrite` (A: 2 377 + 1 521 + 5 120 = 9 018), so the
  column that the cap experiment could only argue about is now decomposable, with the provider's own
  `cost` beside it.
- `promptDigest` is recorded per unit: A's single unit and each of B's four carry their own digest, which
  is the evidence that the plain path gives every unit a fresh strict prompt (and the reason a chain has to
  be argued about differently).
- `instrument.commit` is `f1583087656383c56f90c9288b9ec0d60eb17cf8` for the first three runs - the
  instrumentation was written but not yet committed, so HEAD was still the previous commit - and
  `19dbc72199ff54588554fcbf5527cc9cc086ceab` for the two later ones. That gap is one command wide, and it is
  the whole of it: `git diff --stat f1583087..19dbc721 -- evals/ooo-execution/plan-driver.ts
src/integration/ooo-session-mechanism.ts .pi/extensions/nmg/ooo-execution.ts` reports 135 insertions and
  36 deletions, exactly the instrument commit `9803ce7a` and nothing else, so the two reps of one cell ran
  the same execution code. The cap cells recorded earlier the same day name no commit at all.

**What the two surfaces cost, measured.** B and `cap 1` are the same plan at the same slot count, one on
each surface: B's 22 579 ms median against cap 1's 26 186 ms, and 30 070 tokens against 45 482 - a
difference of 3 607 ms and 15 412 tokens. Under the plan's grade rule that wall difference separates at
pair grade (3 607 ms against a threshold of 2 x 1 783 ms) by 41 ms, which is worth saying out loud: it is
the narrowest reading in the matrix. Declaring fusion at a bound of one, which fuses nothing, is therefore
not free - the chain surface re-sends and re-reads its context on every turn - and the token side of that
difference does not separate (15 412 against a spread of 11 946), because the cap cells have no usage split.
And fusion still wins against both baselines: `cap 2`'s 17 735 ms median is 4 844 ms below plain B and
8 451 ms below cap 1, while spending 7 623 tokens more than B. That last comparison is the one this
programme left unpriced - no stored cap report carries `input`/`output`/`cost`, because they were recorded
before the split existed, and one rep of the shape that failed at three would not price it.
