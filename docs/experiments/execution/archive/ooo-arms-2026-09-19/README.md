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
