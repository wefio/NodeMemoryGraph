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

| Directory                    | Entry point                              | Runs | What it is                                                                    |
| ---------------------------- | ---------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| `fusion-darm/`               | `plan-driver.ts run --session-runner`    | 6    | D arm: `fusion.unitsPerSession` 1 (control) against 2 (fused), 3 reps each    |
| `fusion-darm/spec-1.json`    | —                                        | —    | The spec the control arm ran (bound 1), frozen envelope limits included       |
| `fusion-darm/spec-2.json`    | —                                        | —    | The spec the fused arm ran (bound 2); `spec-1` differs only in that bound     |
| `fusion-darm/aggregate.json` | `node .temp/run-darm.mjs`                | —    | The six runs plus per-arm medians, which is what the record quotes            |
| `smoke/`                     | `plan-driver.ts run --session-runner`    | 4    | The mechanism smoke: two units in one session, and the runs that failed first |
| `speculation-earm/`          | `evals/ooo-execution/speculation-pilot.ts --live` | 8 | E arm: baseline against speculation, fact true and false, 2 reps each  |
| `speculation-earm/aggregate.json` | —                                   | —    | The eight runs plus per-(arm, fact) totals                                    |
| `speculation-earm/run2-2026-09-19T05-40-04/` | `evals/ooo-execution/speculation-pilot.ts --live` (3 reps) | 9 | Second E-arm run: every attempt's artifact bytes, the candidate tree its check ran in, the check's own output, one row per run, the aggregate, and a `CLEANABLE.md` saying the directory is scratch |
| `harness-three-way.json`     | `node .temp/p1-harness.mjs`              | 6    | The harness validation that had to come first: frozen stub, the fixture's canned answer and a wrong answer, through the same check |

**What is missing, and why that is now a plan item.** The E arm's first run stored no artifact bytes:
`speculation-pilot.ts` returned each candidate's verdict but deleted the candidate tree on failure, so
the run that reported "quality false in all four verified candidates" cannot be asked *why*. The
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
fed *every* artifact to `patchCandidate`, which reads patches only. The run's quality failures were
therefore reported through the wrong reader: eight of nine attempts in the second run answered with a
conclusion, which this unit's check cannot pass and the board would refuse, and the one attempt that
submitted a patch failed for a real reason (it wrote `rows: [...]` where the frozen interface requires
`lines: [...]`). The instrument now reads an artifact by its kind and records which reader was used.
