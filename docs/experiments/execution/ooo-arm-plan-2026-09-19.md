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

## P6 - The measurement plan: every cell, what it is for, and how cells are compared

This section is the plan, and it is the home of the arm programme's measurement rules. The other
documents point here instead of restating them. The tables come from the stored reports, not from a
summary: `.temp/arm-matrix.py` reads each archived report, refuses a missing one or one whose token total
does not equal its four parts, and writes
[`matrix.json`](archive/ooo-arms-2026-09-19/matrix.json) beside those reports.

### The questions, each naming the decision it informs

| question | the reading                                                                             | the decision it informs                                                           |
| -------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q1       | granularity: one coarse unit against four fine units on the same parent task            | whether splitting a unit into a fine plan is offered at all                       |
| Q2       | slots: a second concurrent slot on the plain path                                       | the slot budget's default                                                         |
| Q3       | surface: what declaring fusion costs when a session holds one unit, so nothing is fused | whether the chain surface is entered by default, or only when fusion is asked for |
| Q4       | fusion: a chain of two against its own same-surface control and against the plain path  | whether fusion is offered                                                         |
| Q5       | length: a chain of four against a chain of two                                          | the declared bound's default                                                      |
| Q6       | price: what each arm costs in money, per rep                                            | the rule for when fusion is worth buying                                          |
| Q7       | speculation: whether preparing a guess pays                                             | whether the E arm is offered                                                      |

### The cells

Eight cells on two surfaces. The surface is part of the cell's identity, not a detail: a plain cell runs
one worker call per unit, a chain cell runs a session whose worker submits artifacts turn by turn under
`patchSessionInput`, so a plain cell and a chain cell are never read as the same condition.

| cell | question it serves         | surface | shape          | slots | bound                   |
| ---- | -------------------------- | ------- | -------------- | ----- | ----------------------- |
| A    | Q1                         | plain   | coarse, 1 unit | 1     | -                       |
| B    | Q1, Q2, Q3, Q4             | plain   | fine, 4 units  | 1     | -                       |
| C    | Q2                         | plain   | fine, 4 units  | 2     | -                       |
| cap1 | Q3, Q4                     | chain   | fine, 4 units  | 1     | 1 (the surface control) |
| cap2 | Q4, Q5                     | chain   | fine, 4 units  | 1     | 2                       |
| cap4 | Q5                         | chain   | fine, 4 units  | 1     | 4                       |
| D1   | Q4 (the pilot's own shape) | plain   | pilot, 2 units | 1     | -                       |
| D2   | Q4 (the pilot's own shape) | chain   | pilot, 2 units | 1     | 2                       |

| cell | surface | shape          | slots | bound | reps | wall per rep (ms)     | wall median | tokens per rep        | tokens median | cost per rep | accepted | instrument |
| ---- | ------- | -------------- | ----- | ----- | ---- | --------------------- | ----------- | --------------------- | ------------- | ------------ | -------- | ---------- |
| A    | plain   | coarse, 1 unit | 1     | -     | 1    | 9726                  | 9726        | 9018                  | 9018          | 0.000773     | all      | f1583087   |
| B    | plain   | fine, 4 units  | 1     | -     | 1    | 21885                 | 21885       | 29962                 | 29962         | 0.002206     | all      | f1583087   |
| C    | plain   | fine, 4 units  | 2     | -     | 1    | 18565                 | 18565       | 30674                 | 30674         | 0.002076     | all      | f1583087   |
| cap1 | chain   | fine, 4 units  | 1     | 1     | 3    | 26186 / 27053 / 25270 | 26186       | 45482 / 45887 / 33941 | 45482         | n/a n/a n/a  | all      | none       |
| cap2 | chain   | fine, 4 units  | 1     | 2     | 3    | 17735 / 17998 / 17427 | 17735       | 41806 / 37693 / 35444 | 37693         | n/a n/a n/a  | all      | none       |
| cap4 | chain   | fine, 4 units  | 1     | 4     | 2    | 16480 / 16810         | 16645       | 54834 / 55738         | 55286         | n/a n/a      | all      | none       |
| D1   | plain   | pilot, slots 1 | 1     | -     | 3    | 11902 / 12948 / 14066 | 12948       | 22498 / 22435 / 22922 | 22498         | n/a n/a n/a  | all      | none       |
| D2   | chain   | pilot, slots 1 | 1     | 2     | 3    | 11812 / 9584 / 11048  | 11048       | 22533 / 17592 / 26299 | 22533         | n/a n/a n/a  | all      | none       |

### The pairs, and the reading each one carries

A pair differs in exactly one declared field. `cap1` is on the chain surface, so `B vs cap1` varies the
surface while `cap1 vs cap2` varies fusion _on the same surface_ - which is why the fusion reading is
taken from the second pair and not from a fused cell against a plain one.

| pair         | one differing field                | wall: rep values, then median                                                  | median gap | larger spread | separates                                            |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------ | ---------- | ------------- | ---------------------------------------------------- |
| A vs B       | plan shape (1 unit vs 4)           | A 9726 (med 9726); B 21885 (med 21885)                                         | 12159 ms   | 0 ms          | graded single observation: below the three-rep floor |
| B vs C       | slots (1 vs 2)                     | B 21885 (med 21885); C 18565 (med 18565)                                       | 3320 ms    | 0 ms          | graded single observation: below the three-rep floor |
| B vs cap1    | surface (plain vs chain, bound 1)  | B 21885 (med 21885); cap1 26186 / 27053 / 25270 (med 26186)                    | 4301 ms    | 1783 ms       | graded single observation: below the three-rep floor |
| cap1 vs cap2 | fusion bound (1 vs 2)              | cap1 26186 / 27053 / 25270 (med 26186); cap2 17735 / 17998 / 17427 (med 17735) | 8451 ms    | 1783 ms       | separates                                            |
| cap2 vs cap4 | fusion bound (2 vs 4)              | cap2 17735 / 17998 / 17427 (med 17735); cap4 16480 / 16810 (med 16645)         | 1090 ms    | 571 ms        | graded pair: below the three-rep floor               |
| D1 vs D2     | fusion bound (1 vs 2), pilot shape | D1 11902 / 12948 / 14066 (med 12948); D2 11812 / 9584 / 11048 (med 11048)      | 1900 ms    | 2228 ms       | no - cannot resolve                                  |

### How cells are compared: the rules

1. **One declared field per pair**, and the two specs' only difference must be that field. A pair that
   varies two things is two readings pretending to be one.
2. **Same instrument, or say they are not.** Every report names the commit it ran from
   (`instrument.commit`) and, per unit, a `promptDigest`. Two runs may be read as one condition only when
   the commits agree; otherwise they are two observations of the same spec, and the report must say so.
   Spec equality is not running-condition equality.
3. **Wall clock first, tokens second, and never mixed.** `wallMs` is the run's own wall; `hostMs` is the
   host's serial check time and is reported apart, because host time is serial in every arm.
4. **A difference is graded, not binary.** One rep is a _single observation_, two a _pair_, three or more
   a _rate_. Only a rate may be called separated by the spread rule (a gap wider than the larger cell's
   own spread); a pair or a single observation is called separated only when the gap exceeds the larger
   spread by a factor of two (pair) or five (single observation), which is why Q1's 12 159 ms across a
   zero-spread single pair is a reading while Q2's 3 320 ms is not.
5. **A wider spread than the gap means the sample cannot resolve the effect** - not that the effect is
   absent. `D1 vs D2` is exactly that, at the grade the pilot declared.
6. **A cell counts only if every unit and the parent check accepted**, `failures: 0`, and `slotsUsed`
   equals the cell's slots. A refused or incomplete run is archived, named, and excluded from the
   comparison rather than retried.
7. **Cost comes from the provider's own price** (`cost`, per rep), never from tokens: `tokens` counts
   input and output together, so `tokens - cacheRead` is not a billed-input lower bound and was renamed
   as soon as that was noticed.
8. **Aggregates pair per rep.** Sorted arrays exist only to compute a median; wall, tokens and cache reads
   are never sorted independently and read by position.

### What is deliberately not a cell, and why

- **Coarse at two slots.** One unit is one claim, so there is nothing for a second slot to overlap: the
  cell would measure the scheduler, not the plan.
- **Three or four slots on the fine plan.** The declared slot budget says a run holds one claim; C shows a
  second slot works and saves 3 320 ms. Scaling the slot count is a different question with a different
  instrument.
- **A third bound (cap 3).** The bound's default needs a direction, and the direction is between one and
  two; a cell between two and four would sharpen a hypothesis nobody is acting on.
- **A fused cell against a plain cell as the fusion reading.** That pair varies fusion _and_ surface; it is
  reported, and it is not the fusion reading.
- **A priced fused cell (Q6)** and **a paid E arm at another shape (Q7)**: see the end state.

### The end state

The plan is complete when every question above is either answered at the grade its decision needs, or
closed with its reason on the record. That is the state as of 2026-09-19, and it is closed rather than
pending:

- **Answered.** Q1 (12 159 ms, far beyond the programme's widest observed spread of 2 228 ms), Q3 (4 301 ms
  against a 1 783 ms spread, on the same plan and slot count), Q4 (8 451 ms at three reps each, the one
  reading at rate grade), Q5 as a hypothesis (1 090 ms against 571 ms at two reps - a pair, and no policy
  turns on it).
- **Closed unmeasured, with the reason.** Q6: no stored cap report carries the price split, and one rep of
  the shape that failed at three would not price it, so the cost of fusing stays qualitative and every
  document says `unpriced` where that is the state. Q7: the E arm's instrument ran one shape, its measured
  outcome was cost without gain, and no further shape is scheduled.
- **Optional, priced, and not a to-do.** Q2 and Q3 are single observations because their plain cells have
  one rep each while their chain cells have three. Buying two more plain runs - `B` and `C` again, about
  60 k tokens at the prices above - would lift both to pair grade. Nothing in the design turns on that
  conversion today; it is written here so the decision is a decision, not a drift.

### Spending

Three purchases were made under one rule - no cell is paid for until the user names a ceiling for that
step - and no further cell is bought from this plan without the same. The cap cells' third reps cost
80 404 tokens, A/B/C cost 69 654; earlier, the fusion pilot cost about 75 k and the E arm about 43 k. A
run that fails is reported as a failure, not retried, and a fused spec is never run as an unfused control
because the driver refuses it.

## P4 - Retention, kept light (free)

The user's reading, recorded here because it is the rule to follow: a run's evidence is needed _while the
work is being done_, so it is written to a marked scratch directory (`.temp/.../CLEANABLE.md`) and may be
deleted later - the failure was never that scratch existed, it was deleting the data before the record
that needed it was written. The instrument now writes every artifact, candidate tree and check output,
marks the directory cleanable, and copies the run into the tracked archive when a record quotes it. No
`docs:check` rule: this needs a place to keep things, not a gate.
