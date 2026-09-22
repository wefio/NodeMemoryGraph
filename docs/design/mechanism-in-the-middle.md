# Mechanism in the middle, adapters at both ends

**Status:** draft
**Created:** 2026-09-21

A layered model of the collaboration protocol, and the checks that decide whether the model earns a place in
the records. This document owns the model, the boundary test, and the checks. It does not restate the parts
inventory, which lives in [protocol-governed-collaboration.md](protocol-governed-collaboration.md), nor the
decisions, which live in three proposed records: [mechanism, not policy](../decisions/proposed/2026-09-21-mechanism-not-policy.md),
[the frame and its storage](../decisions/proposed/2026-09-21-the-frame-and-its-storage.md), and
[the program answers legality](../decisions/proposed/2026-09-20-the-program-answers-legality.md).

## The model

A drawing pipeline has four stages, and so does ours.

| Stage      | What it does                                                                                  | What it is here                                                                                                                             | Where it lives today                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Producer   | turns something into a buffer                                                                 | a work-shape adapter: validate the declaration, prepare the inputs, run, submit                                                             | `ooo-patch.ts`, `ooo-session-mechanism.ts`, `evals/ooo-execution/data-check-runner.ts`                                                                                                                         |
| Surface    | the shared, opaque exchange object with a role, commit, release and frame callbacks           | the board entry: `payload` plus a discriminator and a digest, delivery as commit, resolve and expiry as release, wake as the frame callback | `task_board_entries` with its added columns                                                                                                                                                                    |
| Compositor | stacking, occlusion, blending, timing, culling, and playing a snapshot when the owner is away | the board and the program: claim, lease, fence, serial and wake, expiry and reaping, the legal set                                          | `src/integration/ooo-board.ts`, `src/integration/ooo-dispatch.ts`, `task-semantics.ts`                                                                                                                         |
| Display    | mode, refresh rate, colour space, scaling - the same frame presented differently per device   | the presentation end: what a reader is shown                                                                                                | one presentation of a board entry exists - `taskBoardPreview`, 200 characters, plus raw fields - at six sites; the tier vocabulary lives only on the memory side (`tieredDisclosure`), never for board entries |

Three ownership classes follow, and they are the model's real content:

1. **Content and semantics** belong to the owner and are semantically opaque to the middle. The compositor
   reads pixels to blur or to know an occlusion shape, but it cannot read what a button means; for meaning it
   asks the owner. Our board may read declared structure and never reads payload semantics.
2. **Description** is the owner's obligation: geometry, level and parent relationships, shape and opaque and
   dirty regions, the terminal state of an animation, an identity for restoration, and a snapshot able to
   stand in for the owner. Ours is the discriminator, the digest, dependencies, scope and need, and the
   projection a protocol supplies.
3. **Arbitration** is only the middle's, because only the middle has the global view: stacking and occlusion
   are global properties, and so are visibility, focus, capture permission, timing and reaping. Ours is the
   legal set, claim and lease, wake, expiry.

The boundary test that replaces a slogan:

- the middle does not need to reason about the object, so the object stays opaque and belongs to its owner;
- the middle needs structure, so the owner must supply a description and the middle reads the description
  but not the semantics;
- the judgement is global, so only the middle can make it - which requires the description to be cheap and
  fresh, and requires staleness to have a meaning (an expired lease is a suspicion, not a death certificate).

Two consequences are already load-bearing elsewhere. The middle must compose in a form that is independent
of how it will be shown, so it never learns a reader's format. And presentation is not verifiable - a display
applies its own colour, crop and scaling - so an acceptance can only ever rest on the artifact and its digest,
never on how it was shown.

## Why this is a draft and not a record

- It was reached by stacking analogies, and each analogy was already partly overruled by a fuller view: first
  a kernel split, then a window split into frame and content, now four stages. The analogies are doing the
  reasoning, and that is the smell this section exists to record.
- One of the four stages is a name and nothing else. The presentation end has no seam, no owner and no tests;
  it is a description of scattered code.
- The only measurable claim made in this arc - that the mechanism/policy seam was narrow - was falsified by a
  grep within a minute: the patch assumption sits in six places, one of them a legality rule.
- Nothing has got smaller. No code changed, no concept was removed, and three prose records were added. On
  today's evidence the model is strictly more concepts than the thing it describes.

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
document - see the display row above. A board entry has exactly one presentation, so the fourth stage is
thinner than the table first claimed, and the tier vocabulary in it had been borrowed from the memory side
rather than found on the board side.

**(c) A second shape.** Not run yet.

## What the two checks say about the reduction test

Nothing has got smaller yet, and the checks say where a reduction would have to come from: three files in the
middle hold about a hundred and twenty policy-sense hits, and six sites present a board entry with no owner
between them. The reduction available today is in the middle's three files; whether it pays is what check (c)
measures. The counting earned its keep twice: it produced the word-and-path rule that the earlier prose could
not state, and it caught this document borrowing another subsystem's vocabulary as if it were the board's.
