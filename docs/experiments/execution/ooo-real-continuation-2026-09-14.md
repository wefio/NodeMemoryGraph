# G7: one real handoff at a legal boundary, five structurally identical tasks

**Status:** evidence for ledger row G7. The objective (user, 2026-09-14) was to finish G5 and then G7,
with G7 designed as **five structurally similar but distinct tasks**, so that both the stability
across different tasks and the process on similar-shaped tasks are visible. This is that check.

**What G7 asks for** (`docs/design/task-unit-semantics.md`, and the ledger's own G7 row): _one real
handoff at a legal boundary, with another Agent session continuing the same parent task from the view
plus retrievable evidence, judged by the fixed parent check._ The design puts this after G1, and it
requires naming the model, the budget and the repeats; this document names all three.

**Model, budget, repeats** (the paragraph at the design's `:270` demands exactly this):

- provider `deepseek`, model `deepseek-v4-flash`, configured through `PI_PROVIDER` / `PI_MODEL`.
- One clean pass over all five tasks, plus extra passes on one task to sample it more than once.
- Nine model calls in the clean pass recorded **80 081 tokens** in total; each stage's wall time is in
  the table. A model call is the only thing that spends tokens here: the boundary check, the parent
  check and every verdict are deterministic and cost nothing.
- Execution envelope, frozen per task and bound into the digest: `turns 10`, `reads 5`,
  `timeoutMs 300 000` (raised from the 3/2/45 s default, which is sized for a one-line probe).
- **Failed attempts' token counts are not recorded.** A stage that throws exits before its record is
  written, so the numbers below cover the calls that produced an outcome. That is a defect of this
  runner, not a property of the tasks; it is named here so the cost table is not read as complete.

## The five tasks

One shape, five contents. Each task is a frozen module with a stub and a stated contract, a first
part whose cases are checked at the boundary, and edge cases that arrive only with the continuation:

| task       | module function                 | part 1 (checked at the boundary)  | part 2 (the continuation)                           |
| ---------- | ------------------------------- | --------------------------------- | --------------------------------------------------- |
| `chunk`    | `chunk(items, size)`            | ordinary split, short tail        | empty input, exact multiple, size 1, refusal        |
| `duration` | `parseDuration(text)`           | single-unit `ms` and `s`          | `m`/`h`, combinations, zero, `null` cases           |
| `merge`    | `mergeSorted(a, b)`             | two equal-length non-empty arrays | empties, duplicates, unequal lengths, no mutation   |
| `average`  | `movingAverage(values, window)` | input longer than the window      | window 1, short input, empty, refusal               |
| `paths`    | `normalizePath(path)`           | ordinary segments                 | `//`, `.`, `..`, root escape, trailing slash, empty |

The parent check of each task is one frozen case list, defined before any model call and never edited
during a run: `chunk` 6 cases, `duration` 8, `merge` 7, `average` 6, `paths` 7. Part 1 is judged
against its two cases, the parent against the whole list. Both lists live in
`evals/ooo-execution/live-continuation.ts`.

## Method: what makes the boundary real

Each role is a **separate process**, so nothing is handed over in memory:

1. `--role plan` creates one parent channel per task (`ooo-continuation:<task>`) and its part-1
   handoff. The parent is the channel; the continuation is a second handoff in it.
2. `--role part1` claims the handoff, calls the model on the frozen source, runs the part-1 cases,
   and delivers the candidate through the board (`deliverTaskBoardEntry`, digest computed from the
   bytes it just wrote).
3. `--role judge --stage part1` re-reads the artifact from the recorded ref, **recomputes the digest
   and refuses when it no longer matches**, runs the part-1 cases, and records the verdict. Only an
   accepted part 1 **opens the continuation** — that is the legal boundary.
4. `--role part2` claims the continuation, then retrieves the part-1 delivery _from the view_:
   it reads the delivered artifact's bytes and checks them against the digest the store recorded
   before it is allowed to continue. It calls the model with those bytes as the file to edit, under
   the part-2 instruction, then runs the **fixed parent check** and delivers.
5. `--role judge --stage parent` verifies the digest again and runs the same frozen parent check.
   When the stage it was asked about has no delivery, it **refuses** rather than falling back to
   another artifact.
6. `--role report` prints the table by reading the run's own JSONL back.

A continuation may legitimately conclude that the delivered bytes are already the answer. That is a
legal outcome (`no-change-needed`), and the model's artifact states it: the same bytes are carried
forward and the parent check still judges them. It happened once (`paths`).

## Clean pass: five tasks, one run, one store

| task       | part 1 | turns | tokens | wall    | boundary | part 2                                | turns | tokens | wall     | parent check                                        |
| ---------- | ------ | ----- | ------ | ------- | -------- | ------------------------------------- | ----- | ------ | -------- | --------------------------------------------------- |
| `chunk`    | 2/2    | 4     | 4 268  | 4 650ms | accepted | 6/6                                   | 6     | 14 230 | 12 571ms | accepted 6/6                                        |
| `duration` | 2/2    | 4     | 4 425  | 4 585ms | accepted | 8/8                                   | 5     | 22 262 | 26 900ms | accepted 8/8                                        |
| `merge`    | 2/2    | 4     | 5 018  | 6 749ms | accepted | **failed: `invalid patch structure`** | -     | -      | -        | **no verdict — refused, and recorded as a failure** |
| `average`  | 2/2    | 4     | 4 342  | 4 772ms | accepted | 6/6                                   | 4     | 5 177  | 5 367ms  | accepted 6/6                                        |
| `paths`    | 2/2    | 5     | 7 216  | 8 781ms | accepted | 7/7                                   | 6     | 13 143 | 10 020ms | accepted 7/7 (`no-change-needed`)                   |

Nine model calls, 80 081 tokens, 84 395 ms of recorded work across both stages. Every continuation
recorded the digest of the artifact it continued from, so each one provably started from what the
first session delivered rather than from the original stub.

Raw records: `archive/ooo-continuation-2026-09-14/run-logs/g7-run.jsonl` (the clean pass, 25 lines).

## What the process looks like when the tasks are alike

- **Part 1 is stable to the point of being boring**: in every attempt recorded here — and in the
  earlier exploratory passes — it submitted a candidate that passed its two cases on the first try,
  at 4 turns and 4.3–7.2k tokens. The variation is in the _content_, not in the shape of the work.
- **Part 2 is where the variation lives**: 4–6 turns and 5.2–22.3k tokens for the four that landed,
  with wall time from 5.4s to 26.9s. The `duration` continuation cost 22 262 tokens — four times
  `average`'s 5 177 — for two more cases, which is a property of the task's wording, not of the
  boundary.
- **The boundary itself is free and instantaneous.** Deciding it is a deterministic check over
  bytes; no model is involved, so a wider or narrower boundary costs nothing but changes what the
  second session has to do.
- **`merge` failed at the boundary, twice out of four attempts** (see the next table). The failure is
  in the _envelope_ the model submitted, not in the logic it wrote: the artifact did not parse as a
  patch. When that happens the stage delivers nothing, so the parent stage's judge finds no delivery
  and **refuses instead of judging the part-1 artifact** — the failure stays a failure instead of
  being absorbed by a verdict.
- **`pi turn error: This operation was aborted` appears on most sessions, including successful ones.**
  It is not by itself a failure signal: `chunk`'s part 1 printed it and then passed 2/2.
- **The same task is not the same run.** `merge`'s part 2 passed 7/7 in the five-task exploratory
  pass, failed twice in the samples below, and passed 7/7 again after its stale claim was released.
  Same instructions, same frozen source, same check.

### Extra samples of one task

| pass                                        | part 1     | part 2                                | parent check |
| ------------------------------------------- | ---------- | ------------------------------------- | ------------ |
| exploratory five-task pass (separate store) | 2/2, 4 560 | 7/7, 5 turns, 9 048 tokens            | accepted 7/7 |
| clean pass (above)                          | 2/2        | **failed: `invalid patch structure`** | refused      |
| retry in a fresh store                      | 2/2, 4 758 | **failed: `invalid patch structure`** | refused      |
| retry after releasing the stale claim       | —          | 7/7, 4 turns, 6 964 tokens            | accepted 7/7 |

Raw records: `archive/ooo-continuation-2026-09-14/run-logs/merge-retry.jsonl` (12 lines).

## Defects this run found in its own runner, and what they show

Running the check found three faults in the harness, each of which would have produced a confident
wrong answer:

1. **A stage-blind judge.** It judged "the latest delivery", so when `merge`'s continuation never
   arrived it silently judged the _part-1_ artifact with the parent check — and that artifact passed
   6/6 (a thorough part 1 implements the whole contract), which would have read as a clean success.
   Fixed: the judge selects the delivery of the stage it was asked about and refuses when it is
   absent. The refusal is what the `merge` rows above now show.
2. **A stage-blind continuation.** Part 2 initially read "the latest delivery" as its input, which
   during a retry could have been the wrong stage's bytes. Fixed the same way, with the digest check
   kept in front of it.
3. **A failed stage kept its claim.** The claim outlived the process that took it, so the retry was
   refused by its own predecessor's lease, and the board looked like someone was still working.
   Fixed: a failed stage releases its claim, and `--role release` releases a claim using the holder
   identity the store recorded.

Two of the three are the same mistake — a query that does not say **which stage it is asking
about** — and in both cases the correct behaviour was to fail closed rather than pick a plausible
artifact. That is the same rule the contract states for the product path, arriving here through a
research script instead.

## Honest limits

- The tasks are hermetic stubs, not edits to this repository. What is real is everything around them:
  the board as the transport, the frozen envelope and check, the digest-verified retrieval, the
  separate processes, and the model doing the work. A repository-editing task would add a code host;
  it would not change the boundary being measured.
- One provider and one model. Nothing here says how another model would behave.
- Five tasks is a sample, not a distribution. `merge`'s 2-of-4 failure rate is one task's sample, and
  it is reported as such.
- Failed attempts' token costs are missing (see the budget note above).

## Reproduction

```
RUN=.nmg/ooo-continuation/<name>
PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash \
  node --experimental-strip-types evals/ooo-execution/live-continuation.ts --role plan --run $RUN
# for each of chunk duration merge average paths:
#   --role part1  --task <t> --run $RUN --live
#   --role judge  --task <t> --stage part1 --run $RUN
#   --role part2  --task <t> --run $RUN --live
#   --role judge  --task <t> --stage parent --run $RUN
node --experimental-strip-types evals/ooo-execution/live-continuation.ts --role report --run $RUN
```

The store, the candidates and the JSONL log stay under `$RUN`; `--role release --task <t> --run $RUN`
clears a claim left by a process that died holding it.
