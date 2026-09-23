# Mechanism in the middle, adapters at both ends

**Status:** draft
**Created:** 2026-09-21
**Updated:** 2026-09-21

A model of how a board entry travels, and the checks that decide whether the model earns a place in the
records. This document owns the model, the rule that says when a boundary earns a seam, and the checks. It
does not restate the parts inventory, which lives in [protocol-governed-collaboration.md](protocol-governed-collaboration.md),
nor the decisions, which live in three records: [mechanism, not policy](../decisions/proposed/2026-09-21-mechanism-not-policy.md),
[the frame and its storage](../decisions/proposed/2026-09-21-the-frame-and-its-storage.md), and
[the program answers legality](../decisions/implemented/2026-09-20-the-program-answers-legality.md).

## The model

A board entry is a medium with two faces, and the roles around it are three.

```
   producer ──[ producer-side interface · write ]──┐        ┌──[ presentation interface · read ]──▶ reader
                                                    ▼        ▲
                                     ┌────────────────────────────────────┐
                                     │  board entry (the medium)          │
                                     │    write face        read face     │
                                     └────────────────────────────────────┘
                                                    │        ▲
                                       Task-Unit Protocol ──▶ compositor
```

| Edge           | What it is                            | Where it lives today                                   | State                                                                                       |
| -------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| the write face | what a producer puts on the medium    | `put` and `deliver`; a body arrives as `content`       | three fillers - a patch artifact, a human broadcast, a `memory=<id>` pointer - and no shape |
| the read face  | what a reader is shown                | `boardEntryView` in `src/core/board-entry-view.ts`     | one rule, one home, one test                                                                |
| the middle     | the compositor, brought by a protocol | `ooo-board.ts`, `ooo-dispatch.ts`, `task-semantics.ts` | one protocol brings it: the Task-Unit Protocol                                              |

Three facts about the shape, each measured rather than assumed.

1. **The middle comes from a protocol, not from the board.** The board offers two faces and nothing else; a
   protocol names the constraints that put a compositor between them, and the Task-Unit Protocol is the one
   that brings ours. That is why "the program only answers legality" says the same thing: no declared
   legality, no judgement. Of the seven entry kinds, only `handoff` and `result` are ever claimed, delivered
   and judged - a note, a goal and a question travel from the write face straight to the read face.
2. **The roles are not files.** `src/core/store/base.ts` is the medium (columns and transactions), the
   compositor (the lease-based claim compare-and-set and the clock) and the reader's rule at once, and
   `src/cli/service.ts` is both the wire face and a formatter. So this is a map of roles, and a check can sit
   only on the artifacts that cross an edge, never on module imports.
3. **Feedback is a replay, not a reversal.** A reader becomes the next writer and enters through the write
   face again; the middle is never traversed backwards. The broadcast path in `.pi/extensions/nmg/index.ts`
   (it reads an entry, then writes a new one) is a place where two roles live side by side, and rejection
   followed by re-issue moves forward as well - the middle writes a new declaration onto the medium and the
   producer reads it from the write face.

## Which boundary earns a seam

**A boundary is built when it has a second implementation; with one, it is only declared.** The rule needs no
taste, only a count.

| Boundary       | Implementations today                                                                                             | Consequence                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| the write face | three fillers for one body                                                                                        | declared: a type is worth writing when a fourth filler appears               |
| the read face  | three truncation rules - 200 characters collapsing, a generic helper, and a bare 140 slice that collapsed nothing | **built**: one rule, one home, one test                                      |
| the middle     | one protocol                                                                                                      | declared only: a seam is built when a second protocol brings a second middle |

The alternative - building every seam now, each against a single implementation - is the mistake this
document already made once by stacking analogies. A seam designed against one shape is a seam designed
against an imagined second shape, and the imagined one is the one that gets built wrong.

## What landed with this document

- **The read face has one home.** `src/core/board-entry-view.ts` owns the rule: a lone `memory=<id>` pointer
  is returned whole, anything longer is collapsed to one bounded line, and the bound belongs to the caller,
  because how much of a body fits is the reader's decision. The store's compact read and the host adapter's
  broadcast both call it; the store's private copy and the adapter's bare slice are gone. One of the three
  rules was also wrong rather than merely duplicated: the 140-character slice in `.pi/extensions/nmg/index.ts`
  did not collapse whitespace, so a multi-line body reached a broadcast as a multi-line broadcast.
  `tests/core/task-board.test.ts` pins the rule directly. The adapter's `excerpt` helper stays for memory
  results, which are not board entries and keep their own rule.
- **The write face's type did not land.** The three fillers are three kinds of entry rather than one shape
  drawn three ways, so the trigger for a type is a fourth filler. Measured again here: the _artifact_ body
  inside a result already has a home (`artifactEnvelope` and `artifactFromText` in
  `src/integration/ooo-session-mechanism.ts`, which is why the worker's tool and its text channel obey one
  contract), while the _entry_ body that wraps it has one writer and two readers that are two different
  rules - the probe parses the loop's envelope and binds a verdict to the ticket's digest, and the product
  board reads the artifact of a body that may be the artifact itself, because an agent that delivers through
  the board tool writes the bytes it produced. Two rules with one implementation each are not a seam.
- **The identity of work has one home.** `src/integration/work-identity.ts` owns the rule a verdict binds
  to: sha256, hex, full length, over exactly the bytes or the JSON text the caller froze. Four modules had
  written the same two lines - twice as an identical private `digestOf(value)` - and two of those callers
  had folded their own shortening into it, so a twelve-character report identity and a sixteen-character
  branch identity read as part of the rule instead of a caller's choice. Canonicalisation stays the caller's
  and the module says so: JSON key order is whatever the caller built, which is why freezing a patch is what
  makes its digest stable. Two named mutants make the convention checkable - another encoding, and a JSON
  variant that does not digest JSON. Sites that differ on purpose (a base64url search content hash, a
  session id, a protocol-visible `sha256:` prefix) keep their own convention, and the module names them, so
  a later sweep cannot unify three different rules.
- **The middle's seam did not land.** Check (c) says why.
- **The port has a third implementation, and it is the product's.** `src/integration/ooo-runner.ts` is the
  store's own board: it projects the run's frozen table and its board entries into the facts the shared
  rules read, and it carries no legality rule of its own. Three implementations satisfy `DispatchBoard` now
  - the probe board, the dispatch test's stub, and this one - and only the projection differs between them,
    which is the abstraction working rather than a claim that it does.
- **The port's read answers why, not only which.** `legality()` is that read: the ordered legal set, the
  room the run has left, and a named cause for every unit the rules do not have on offer. The causes are
  computed inside the rules' own `selection`, so a cause names a gate rather than restating its condition,
  and a plan-level gate is attached to the units it holds back; `candidates()` is that answer's `legal`, so
  the two cannot disagree. The answer names nobody - who claimed, delivered or judged stays a board fact -
  and asking changes nothing: no entry, no claim, no budget, no wake.
- **Who can be asked.** The process that owns the run's workspace, through its board. A plan is compiled
  from the caller's files and the daemon holds only their frozen paths, so this read cannot be answered from
  the store alone; that is a property of where the plan lives, not a surface the daemon is missing.
- **The projection has one contract that is easy to get wrong.** The shared acceptance rule binds a verdict
  to the artifact a run carries: it compares the verdict's digest against the artifact value, so a verdict
  about a different artifact cannot pass as acceptance. Reporting the store's own deliverable hash in that
  field instead makes every accepted unit read as unaccepted, and the symptom is silent - the next unit is
  never released and nothing reports an error. Both identities are legitimate; only the artifact value
  belongs in that field.
- **Where the port's verbs meet the product's lifecycle.** A product run keeps a deliverable on the entry a
  unit was claimed on, so the port's "put a result" is that delivery and its "submit" is the judgement of
  it: one entry per unit, not two, because a second result entry would be a record nothing reads. The unit
  is resolved from the claim the loop has just taken rather than from the body, because a body's shape
  belongs to its owner while a claim is the board's own fact.

## Why this is a draft and not a record

- The pipeline form of this document - four stages borrowed from a drawing pipeline - was reached by stacking
  analogies and was **retired on 2026-09-21** in favour of the two-faces model above, which came from
  measurement instead: roles cohabit files, feedback replays rather than reverses, and a protocol is what
  brings the middle.
- The only measurable claim made in this arc - that the mechanism/policy seam was narrow - was falsified by a
  grep within a minute: the patch assumption sits in six places, one of them a legality rule.
- One thing has got smaller: the read face's three rules are now one, in one home, with one test. The middle's
  hundred-and-twenty policy-sense hits and the write face's unshaped body have not.
- The model is still more concepts than the code it describes, so it stays a draft.

## The eligibility rule

**An analogy earns a place in a record only when a check can falsify it.** The model above is allowed to stay
in this document while its checks are pending, and it may be promoted into a record only if the checks come
out in its favour. If they do not, this document is archived rather than promoted.

## The checks

Predictions are recorded before the measurement, so a surprise is visible rather than rationalised.

**(a) Policy words in the middle.** Grep the middle layer - `src/core/store/`, `src/integration/ooo-board.ts`,
`src/integration/ooo-dispatch.ts`, `src/integration/task-semantics.ts`, `src/integration/ooo-execution.ts`,
`src/integration/ooo-candidate.ts` - for the policy word list: `patch`, `editable`, `instruction`, `checks`,
`files`, `repair-first`. Report every hit with its path, not just a count, because a word can be mechanism at
one path and policy at another. Prediction: fifteen or more hits, concentrated in the board and the legality
module. Expected finding: the board's own ticket type and the freeze method are the centre of it.

**(b) The two ends.** Enumerate every site that translates between the board's canonical form and a producer
or reader format. Prediction: the producer end is concentrated and separable (about four sites), while the
presentation end is scattered across the store's preview function, the tier rendering, the prompt file, the
CLI and the extension, with no seam at all. If the presentation end cannot be separated, the fourth stage is a
name for a fact rather than a design, and it should be dropped rather than built.

**(c) A second shape.** Run one unit through the dispatch loop whose work is not a patch, with a minimal
resolver (patch stays the default; an unknown shape is refused by name rather than failed). Count the files
that have to change. Prediction: five or more.

## The reduction test

The model earns its place only by making something smaller, and the four things it must make smaller are
named in advance:

- **Less code:** taking the seam means the middle loses a type and a freeze method, and the shape's field
  validation moves to the adapter that owns the shape. If the net is an increase, the model failed.
- **Fewer concepts:** the three ownership classes must _absorb_ the two lists they replace - the mechanism
  list and the policy list - rather than being added beside them. If a reader has to hold both, the model is
  a restatement, not an abstraction.
- **Fewer change points:** the six sites must become fewer, or the same six in one place instead of six. The
  number that matters is how many places a _new_ shape must touch.
- **Better maintainability:** a new shape adds files under one owner and changes no test in the middle; the
  middle's suite passes untouched with a shape it has never seen.

## Results

**(a) Policy words in the middle.** The prediction was fifteen or more hits. Measured 195 raw across the
listed files: `patch` 106, `files` 39, `checks` 23, `editable` 14, `instruction` 12, `repair-first` 1. The
concentration is where it was predicted: `src/integration/ooo-board.ts` carries 53 `patch` hits,
`src/integration/task-semantics.ts` 27 `patch` and 9 `editable`, `src/core/store/base.ts` 13 `patch`.

The measurement forced two corrections. First, the raw count overstates the case, which is the caveat this
check was written with: `files` in `src/core/store/writes.ts` and `src/core/store/retrieval.ts` is a mechanism
word - a path inside a store - and `checks` in `src/integration/ooo-candidate.ts` names the check _runner_,
which is mechanism too. The word list should therefore drop `files` and `checks` and keep `patch`, `editable`
and `instruction`. Second, what remains is still about 120 hits, so "the middle is policy-free" is false as a
description of today, at a scale an order of magnitude past the prediction. What the model has is directional
support: the leak is real, large, and concentrated in three files, which is exactly what a seam would have to
remove.

**(b) The two ends.** The producer end was predicted concentrated and separable, and measured four to six
functions over three files: `preparePatchWork`, `patchPrompt`, `patchCandidate` and `patchSubmission` in
`src/integration/ooo-patch.ts`, `snapshotText` in `src/integration/ooo-session-mechanism.ts`, and `runTestFile`
in `evals/ooo-execution/data-check-runner.ts`. The prediction held. The presentation end was predicted
scattered with no seam, and measured six sites: the preview text in `src/core/store/base.ts`, the entry and
preview types in `src/core/types.ts`, the wire shape in `src/cli/protocol.ts`, the service in
`src/cli/service.ts`, the agent-facing renderer in `.pi/extensions/nmg/index.ts`, and the generated tool
descriptions from `src/prompts/nmg-prompts.yaml`. That prediction held too, with one correction against this
document: a board entry has exactly one presentation, and the tier vocabulary in the old table had been
borrowed from the memory side rather than found on the board side. A later pass over the same sites found
what the count alone could not: the six sites are a chain, not six formatters, and the duplication sits in
three of them - the store's preview rule, the adapter's generic helper, and a bare slice in the adapter's
broadcast path.

**(c) A second shape.** The prediction was five or more files. The change was made on a throwaway branch and
then reverted: the loop was made shape-agnostic by replacing `DispatchTicket.patch?: PatchWork` with an opaque
`declaration?: {shape, digest, frozen}`, pointing `PlanWorker` at that declaration, and deleting the
`preparePatchWork` call from the unit dispatcher - one file, fifteen insertions and eighteen deletions. Two
results followed, and neither was the result the prediction was aiming at.

- `tsc --noEmit` reported **zero errors**. The coupling is invisible to the compiler: the field is optional,
  and structural typing still lets the board's ticket, which carries `patch`, satisfy the port, so the change
  produced no compile-time signal at all.
- The suite reported **25 failing tests**, every one with the same cause - "the claim admits no work". A second
  shape today would not fail as a new shape; it would refuse every unit.

The coupling's surface, counted by grep: three source files name the frozen patch work (`ooo-dispatch.ts`,
`ooo-patch.ts`, `ooo-session-mechanism.ts`, the last with about ten uses), the board must change although it
never reads the field, seven test files read `ticket.patch` directly, and the worker side couples through the
`PlanWorker` type, which breaks the driver's three worker kinds. The prediction held and then some, and the
decision it forced is the opposite of building: the seam is prepaid cost, deferred with a named trigger - the
first non-patch unit an adopter declares - rather than built now against a single shape.

## What the checks say about the reduction test

One thing is smaller: three rules for showing a board entry became one rule in one home with one test, and the
rule that disappeared was the wrong one. Everything else stands. The middle's three files still hold about a
hundred and twenty policy-sense hits, and the write face's body still has no shape. The counting earned its
keep three times: it produced the word-and-path rule that the earlier prose could not state, it caught this
document borrowing another subsystem's vocabulary as if it were the board's, and it turned "should the seam
exist" from a matter of taste into a measured file count.
