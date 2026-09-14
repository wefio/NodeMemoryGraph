# G7 follow-up: the stable baseline, compared against the other samples

**Status:** analysis of the runs behind ledger row G7, prompted by the observation that the first
stage looked "boringly stable" and that a stable sample is an asset worth comparing against. It is
not a new experiment: it re-reads every stage record the continuation check has produced, classifies
each failure by **who caused it**, and compares cost and process across conditions.

**Where the data comes from.** Four run directories hold `run.jsonl` logs, written by
`evals/ooo-execution/live-continuation.ts`, from the passes described in
`ooo-real-continuation-2026-09-14.md`: the clean five-task pass, a four-attempt `merge` sample, an
exploratory pass, and the matched repetition set (`merge`, twelve plus ten repetitions). Model
`deepseek/deepseek-v4-flash` throughout. The user suggested pi's own session records as a source;
they do not exist for these runs — the adapter builds its sessions with `SessionManager.inMemory()`
(`.pi/extensions/nmg/ooo-execution.ts:585`) so a probe never litters the session history. The cost of
a failed call had to come from the adapter's return value instead, which is why the runner now
records usage on the failure path too.

## The two conditions

Same task shape, same frozen check, same model. The only difference is **which stage of the parent
task the session is asked for**:

- **part 1 — the stable baseline.** One instruction, two cases checked at the boundary, a stub to
  implement. 35 samples.
- **part 2 — the continuation.** A second session, a second channel entry, the part-1 artifact
  retrieved from the view and digest-verified, then the remaining edge cases plus the whole parent
  check. 38 samples.

## The numbers

| condition                        | samples | passed | naive failures | mean tokens | range          | mean turns | mean wall |
| -------------------------------- | ------- | ------ | -------------- | ----------- | -------------- | ---------- | --------- |
| part 1 (baseline)                | 35      | 34     | **1**          | 5 653       | 4 164 – 10 508 | 4.4        | ~6.1 s    |
| part 2 (continuation), all tasks | 38      | 19     | 19             | 8 406       | 2 798 – 22 262 | 4.4        | ~6.0 s    |
| — `merge` only                   | 32      | 14     | 18             | 7 286       | 2 798 – 14 936 | 4.2        | —         |
| — the other four tasks           | 6       | 5      | 1              | 12 213      | 5 177 – 22 262 | 5.0        | ~12.2 s   |
| all passing stages               | 53      | 53     | 0              | 6 963       | 4 164 – 22 262 | 4.5        | ~7.4 s    |

The baseline is genuinely stable: **one failure in 35 samples** (2.9%), and that one is real — the
model returned a `mergeSorted` that dropped the tail (`expected [1,2,3,4], observed [1,2,3]`), part 1
was rejected at the boundary, and no continuation was opened, which is the boundary behaving
correctly.

The continuation's naive failure rate looks like 50%. It is not. Reading each failure's cause:

| cause                                                                                       | count | whose fault                       |
| ------------------------------------------------------------------------------------------- | ----- | --------------------------------- |
| artifact path reused across repetitions, so the recorded digest no longer matched the bytes | 10    | the harness                       |
| a failed stage kept its claim, so the retry was refused by its own predecessor              | 2     | the harness                       |
| the upstream part 1 never passed, so no continuation existed to claim                       | 1     | the harness (upstream)            |
| `no-change-needed`, read from the kept artifacts (r14, r19), misread as a malformed patch   | 2     | the harness (misclassification)   |
| `cannot-complete`, read from the kept artifact (r22), a legal conclusion kind               | 1     | the model                         |
| `promote-candidate` but not parseable (the earliest kept artifact)                          | 1     | the model                         |
| `invalid patch structure`, artifact not preserved                                           | 2     | unknown — the bytes were not kept |

So **13 of 20 failures were the harness's own defects**, and reading the kept artifacts split the
rest: two were legal `no-change-needed` conclusions the harness misread as malformed patches, one was
`cannot-complete`, and one was submitted as `promote-candidate` but could not be parsed. Two failures
still have no preserved bytes, so their cause is not claimed. The apparent instability of the continuation was mostly an
artefact of the instrument. That is the single most useful thing this comparison produced, and it is
exactly the failure mode the check exists to catch: an instrument that reports its own faults as
task variance.

The `invalid patch structure` cases deserve a note. Of the four, two were preserved and both
declare the same thing - `merge`, repetitions r14 and r19:

```
{"kind":"conclusion","conclusion":"no-change-needed","summary":"The delivered merge.ts already
 satisfies all remaining cases of the contract. ..."}
```

That is a legal answer — the model is saying the delivered bytes are already the answer — and the
runner rejected it as malformed because it only understood file-promoting patches. The check now
reads the artifact's own `kind`/`conclusion` instead of string-matching an error message, and the
repetitions run afterwards show the corrected classification working: `cannot-complete` is reported
as `conclusion=cannot-complete`, not as a broken patch.

## Cost: the shape of the work, not its size

- A stage costs **4.4 turns on average in both conditions** — first pass and continuation are the
  same shape of work. What differs is the outcome class, not the number of turns.
- The continuation costs **1.3×** the first stage for `merge` (7 286 vs 5 480 tokens) but **2.2×** for
  the other four tasks (12 213 vs ~5 650): the price of a continuation is set by the edge cases it
  has to handle, not by the fact that it is a continuation. `duration`'s continuation alone cost
  22 262 tokens, four times `average`'s.
- Reads stay at 1–2 per stage: the model is not thrashing through the file.
- Wall time per stage is ~6 s for a passing stage and up to 27 s for the heaviest one; failure and
  verdict decisions add nothing, because the checks are deterministic.

## What the process looks like when the tasks are alike

The two conditions converge on turns and reads, and diverge on **what the model says when it stops**:

| stopping conclusion         | part 1 | part 2 |
| --------------------------- | ------ | ------ |
| `promote-candidate` (edits) | all 34 | 17     |
| `no-change-needed`          | 0      | 2      |
| `cannot-complete`           | 0      | 1      |

The first stage always promotes an edit; the continuation sometimes concludes that the work is
already done, and once concluded it could not finish. That is the boundary doing its job: a
continuation is a fresh judgement about the same parent task, and a legitimate one may be "nothing
more is needed". Before this analysis the harness could not even express that answer, which is why
two of the "failures" were not failures at all.

## Honest limits

- One model, one provider, small n. The baseline's 1-in-35 is a sample, not a rate; the continuation's
  corrected model-side rate rests on six events, five of them with the artifacts unpreserved.
- `merge` carries most of the samples (26 part-1, 32 part-2), so the per-task comparison outside it
  rests on six continuation samples.
- The harness was being fixed while the data was collected, so the earlier records are less complete
  than the later ones. Every class of harness defect listed above has since been fixed and the fixed
  behaviour is what the last ten repetitions exercised.
- Wall-clock means exclude the records whose timer defaulted to zero on a failure path (a defect in
  the failure record itself, fixed here).

## The takeaway

The stable sample was the right thing to compare against, but the comparison's value turned out to be
in the opposite direction from the expectation: the baseline needed no defending, and the
continuation's bad-looking numbers were mostly the instrument. **Count failures by cause, not by
verdict** — a harness that misattributes its own defects to the model will make every structure look
unstable.
