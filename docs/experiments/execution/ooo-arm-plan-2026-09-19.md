# Plan: what is left of the arm programme, and the data each step needs

**Status:** a plan, not a measurement. It exists because two paid runs were reported and their evidence
was either deleted or never written: the numbers in
[the arms record](./ooo-arms-pilot-2026-09-18.md) outlived nothing.

**Related:** [the arms record](./ooo-arms-pilot-2026-09-18.md) ·
[the rescued samples](./archive/ooo-arms-2026-09-19/README.md) ·
[the obligation ledger](../../design/task-unit-semantics-obligations.md)

## The rule this plan exists to keep

A step below may run only once its data list is fixed: which fields, where they are written, and what is
read off them. A field a claim needs is written _before_ the claim, into
`docs/experiments/execution/archive/<run>/`, which git tracks. No run deletes its own evidence; `.temp/`
holds working copies only, and a result a sentence depends on is not a working copy.

This is the second time on this branch that the rule had to be learned. Row G7's samples were rescued
into [`archive/ooo-continuation-2026-09-14/`](./archive/ooo-continuation-2026-09-14/README.md), whose
README states the failure mode exactly; the D and E arm runs repeated it, and were rescued unread into
[`archive/ooo-arms-2026-09-19/`](./archive/ooo-arms-2026-09-19/README.md). A lesson recorded in prose
in one directory did not survive two sessions, which is why P4 below asks for a check instead.

## P1 - Why did every published candidate fail its own check? (offline; one unit, ~11 k tokens)

**Question.** The E arm's first run reported `quality: false` for all four verified candidates, so by the
design's own rule it could claim nothing. The report cannot be acted on, because the run stored no bytes.

**Data to collect.** One fresh attempt through `evals/ooo-execution/speculation-pilot.ts`, writing per
attempt: `artifactId` (sha256 of the artifact bytes), `artifactPath`, `candidatePath` (the kept tree),
`checkStdout`, `checkStderr`, `checkExit`, `checkMs`, `frozenDigest`, `interfaceDigest`, `tokens`,
`turns`, `workMs`, `instruction`.

**Analysis.** One three-way table, all three run by hand against the same check: the frozen stub, the
model's candidate, and the fixture's own canned answer (known good), plus a diff of the candidate against
the stub.

**Decisive.** The table itself. Canned passes and the model's fails: `quality: false` is a result about
the model's work - an unverified guess produced a bad patch - and the arm's next question is about
verification, not about the harness. If the _canned_ answer also fails, the harness is broken and nothing
else may be concluded from the first run.

## P2 - The E arm's economics (paid; at most 150 k tokens, 3 reps per condition)

**Data to collect.** Everything in P1, plus `arm` (baseline | speculation), `fact` (true | false), `rep`,
`outcome` (from `speculationOutcome`), `sessionReusable`, `ticketId`, `sessionId`, `reusedSession`,
`verifyMs`, `postFactMs`, `wasteTokens` (speculation's spend when the fact turned out false). Aggregates
are medians and ranges per (arm, fact), never a single run.

**Analysis.** The design's three terms kept apart rather than netted: latency saved when the fact held,
tokens wasted when it did not, and the quality term for every published candidate. Break-even hit rate
`p* = waste / (saved + waste)` over the measured numbers, reported as a threshold with its sample size.

**Decisive.** Quality parity inside the compared cells is a precondition, not a result: if a published
candidate fails its check, the arm reports that as its outcome and claims no speedup. Otherwise
feasibility is settled by one cell in which a published candidate _is_ verified and its post-fact
latency (verification included) is below the control's post-fact work. The hit-rate threshold is the
analysis, and no further spend is needed to state it.

## P3 - landed 2026-09-19, one half of it

The rule that matters is now pinned in : an artifact is read
by its kind, and the patch reader refuses a conclusion by name. The mutant half is not done - the host
reader lives in , which is not a mutation target, and adding a target is a
sweep of its own rather than a line in this plan. The claim that the extension was laxer than the host
was wrong and is corrected in three places (the arms record, the ledger and the archive README).

## P3 (original statement) - The envelope's two readers must agree (offline, no model)

**The defect.** The extension accepted an artifact whose keys were
`digest, kind, conclusion, summary, evidence, citations` with no `files`; `patchCandidate` refused the
same bytes as "invalid patch structure". A submission the adapter admits and the board can never accept.

**Data to collect.** An acceptance matrix in a test, no model call: artifact shapes (the refused one, a
minimal valid one, one with extra keys, one whose digest is wrong) against the two readers' verdicts.

**Analysis.** The matrix must contain no cell in which the extension accepts and the host refuses.

**Decisive.** The test fails on the current code and passes after the fix, and a named mutant that
loosens the extension's reader back is caught by it.

## P1 and P2: answered (2026-09-19)

The diagnosis is in the archive's README and the arms record: eight of nine attempts produced a
conclusion artifact, the one patch failed on `rows` against `lines`, and no envelope defect existed -
the instrument read by the wrong reader. The economics are measured: cost real, gain unrealised
(0 of 3 holding reps published), the candidate's admissibility the binding constraint.

## P5 - A measured cost model: tried with autodiff, and the data is what fails (2026-09-19)

The design names autodiff as the reuse target for "cost or action scoring", and the arms need a cost
model rather than a declared bound, so the terms were fitted to the paid runs with `src/lab/autodiff.ts`:
one stacked design-matrix matmul over all rows (never a loop of per-run subgraphs - 9.6x in earlier
work), no compiled tape (its O(graph) compile cost does not amortize for a one-shot fit), standardised
features and target, plain gradient descent.

**Result: the fit is not a model.** Leave-one-out residuals across the 19 paid runs run to -15 955 and
+11 805 tokens against a mean of 11 184, so it predicts nothing about a row it has not seen. And the
session-startup term fitted out as **0 ms** where the D arm measured ~1 900 ms directly - which is the
more useful half of the finding: it says the term is _not identifiable_ from these runs, because the
D arm holds `units` at 2 (bound 1 = 2 sessions, bound 2 = 1 session), leaving `units` collinear with the
intercept and only three runs per level.

**The blocker is the data, not the optimiser.** What follows is therefore not a better fit but a better
design matrix, and the cheap half of that is offline:

1. build the design matrix with canned workers (no model calls) over per-session unit counts 1, 2 and 3,
   so `units` varies instead of being constant - the session term only becomes estimable when both
   features move independently;
2. record the features that can carry signal, because the measured spread inside one arm was wider than
   the difference between arms: the union tool surface's own token count (payable in every turn - the
   D arm's first unit cost ~0.7 k more), turns, snapshot size, and per-unit tokens;
3. re-fit with the same autodiff call, and report leave-one-out residuals again. A term enters the
   planner only when its confidence interval excludes zero.

**Standing constraint.** Autodiff prices _legal_ options; it never decides legality. Whether two units
may share a session stays a predicate over declared facts (`sharedSessionLegal`), and no fitted number
may widen it.

## P6 - The A-D comparison on one parent task (paid; no run may start before its budget is named)

**Question.** The review asks for A-D on one parent task before any fusion policy is declared. Which
cells of that comparison are already stored, and which would have to be run?

**What already exists, and it is a controlled comparison.** `archive/ooo-arms-2026-09-19/cap-cache/`
holds the four-unit fine plan at `--slots 1`, the same worker (`pi`, `deepseek-v4-flash`), the same envelope
limits (`turns: 6`, `reads: 3`, `timeoutMs: 120 000`) and the same parent check. The three specs differ by
**exactly one field** - `fusion.unitsPerSession` 1, 2, 4 - which was checked by diffing them, so fusion is
the only variable and every run comes from one instrument (`plan-driver.ts run`). After a third rep was
bought for two of the cells (2026-09-19), the stored values and the ranges they imply are recomputed from
the report files into `cap-cache/aggregate-3rep.json`:

| `unitsPerSession` | reps | wall (all reps)             | tokens (all reps)        | cache read / tokens   |
| ----------------- | ---- | --------------------------- | ------------------------ | --------------------- |
| 1                 | 3    | 25 270 / 26 186 / 27 053 ms | 33 941 / 45 482 / 45 887 | 0.607 / 0.806 / 0.847 |
| 2                 | 3    | 17 427 / 17 735 / 17 998 ms | 35 444 / 37 693 / 41 806 | 0.690 / 0.798 / 0.802 |
| 4                 | 2    | 16 480 / 16 810 ms          | 54 834 / 55 738          | 0.834 / 0.836         |

**The wall-clock effect survives the third rep; the token reading does not.** The cap1-to-cap2 saving is
8 451 ms on the medians (8 753 at two reps) against within-cell spreads of 1 783 ms and 571 ms, so the
saving is about five times the larger spread. The token columns behave the other way: cap 1's own spread
is 11 946 tokens, wider than the 7 789-token median gap to cap 2, and the cache-read share of tokens moves
from 0.607 to 0.847 inside a single cell - so at three reps this experiment cannot say that fusion changes
the token count in either direction, and the "80-84 % of tokens are cache reads" reading in the fusion
planning document was a two-rep artefact. Per-unit tokens over the thirty-two units stored here span
7 105 to 19 163. That is why the 2-unit D arm's weak result and this experiment's strong one are both
true - different plan shapes, and the D arm's spreads (1.2 s each) exceeded its 1.9 s median gap.

**What is missing, and the hypothesis each cell would distinguish.**

1. **Done, 2026-09-19: the third rep on cap 1 and cap 2.** It cost 80 404 tokens for the pair - 33 941 and
   35 444 for the two runs, plus 11 019 for one refused run kept in the archive as
   `bound2-rep3-without-session-runner.json` - and it settled both halves: the wall saving is a rate, and
   the token direction is not resolvable. See "What the third rep settled" below.
2. **A third rep on cap 4 too (+55 k).** The knee claim (cap 2 rather than cap 4) rests on 1.2 s of
   extra wall for 15 k more tokens, measured twice.
3. **A (coarse, 1 unit) and C (fine, slots 2) through the driver (~41 k: 11 k + 30 k).** The arms record
   ran A/B/C through `pilot.ts`, which supplies the worker itself; the fixture, plans, limits and model
   match, the entry point does not. Without these two cells any A-D table mixes instruments, and a table
   that mixes them has to say so in the same sentence as its numbers.
4. **A priced comparison - no runs, an instrumentation change.** The per-run records carry `tokens`,
   `cacheRead` and `cacheWrite` per unit, never output tokens separately, so `tokens - cacheRead` mixes
   output into input and is not a price. Cost needs the three recorded apart; more reps of the same cells
   would not fix it.

**What the third rep settled, and what it cost.** The saving is a rate rather than one lucky pair, and the
token and cache columns cannot carry a claim at any rep count this experiment can afford. Two facts came
out of executing it. The fused cell's third rep ran with a newer chain prompt than its first two - the
exclusivity line and the admitted-tools list that were added to `patchSessionInput` earlier on 2026-09-19 -
so those three reps are not the same instrument version; the post-fix rep is the fastest and
lowest-token of the three, which says the change did not hurt the cell, not that it helped it. And one run
had to be repeated because the command was guessed from the usage line: without `--session-runner` the
driver refuses a fused live continuation by name, spends only the first unit's tokens, and records the
refusal in `incomplete` - the guard working, and the refusal is archived rather than deleted.

**A/B/C's samples are not in the repository.** The arms record quotes A 33 677, B 94 601 and C 59 830
tokens with per-run times, but only the D and E arms and the cap experiments were rescued, and searching
the repository for those totals finds the record's own table and nothing else. So a same-task A-D table
cannot be assembled from what is stored: for the coarse and slot arms there is a summary, not a sample.
That is a reason to re-run those cells rather than to compare against them.

**Ceiling and stop rule.** No cell above may be paid for until the user names a ceiling for this step; the
only recommended purchase is the first one (~85 k), and it is worth paying only after the priced-
comparison gap is closed, because a wall-clock saving with no price beside it cannot decide a policy. A
run that fails is reported as a failure and not retried; the round stops at the ceiling rather than
stretching it. A fused spec is never run as an unfused control - the driver refuses it - so every cell
below stays self-identifying in the archive.

## P4 - Retention, kept light (free)

The user's reading, recorded here because it is the rule to follow: a run's evidence is needed _while the
work is being done_, so it is written to a marked scratch directory (`.temp/.../CLEANABLE.md`) and may be
deleted later - the failure was never that scratch existed, it was deleting the data before the record
that needed it was written. The instrument now writes every artifact, candidate tree and check output,
marks the directory cleanable, and copies the run into the tracked archive when a record quotes it. No
`docs:check` rule: this needs a place to keep things, not a gate.
