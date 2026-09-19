# Plan: what is left of the arm programme, and the data each step needs

**Status:** a plan, not a measurement. It exists because two paid runs were reported and their evidence
was either deleted or never written: the numbers in
[the arms record](./ooo-arms-pilot-2026-09-18.md) outlived nothing.

**Related:** [the arms record](./ooo-arms-pilot-2026-09-18.md) ·
[the rescued samples](./archive/ooo-arms-2026-09-19/README.md) ·
[the obligation ledger](../../design/task-unit-semantics-obligations.md)

## The rule this plan exists to keep

A step below may run only once its data list is fixed: which fields, where they are written, and what is
read off them. A field a claim needs is written *before* the claim, into
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
verification, not about the harness. If the *canned* answer also fails, the harness is broken and nothing
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
feasibility is settled by one cell in which a published candidate *is* verified and its post-fact
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

## P4 - Retention, kept light (free)

The user's reading, recorded here because it is the rule to follow: a run's evidence is needed *while the
work is being done*, so it is written to a marked scratch directory (`.temp/.../CLEANABLE.md`) and may be
deleted later - the failure was never that scratch existed, it was deleting the data before the record
that needed it was written. The instrument now writes every artifact, candidate tree and check output,
marks the directory cleanable, and copies the run into the tracked archive when a record quotes it. No
`docs:check` rule: this needs a place to keep things, not a gate.
