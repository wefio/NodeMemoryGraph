# Mechanism, not policy

[中文](2026-09-21-mechanism-not-policy.zh-CN.md)

**Status:** proposed
**Relates to:** [The program answers legality](2026-09-20-the-program-answers-legality.md), [The frame, its data format, and its storage](2026-09-21-the-frame-and-its-storage.md), [Board governance and capability addressing](../implemented/2026-09-06-board-governance-addressing.md), [Protocol-governed collaboration: the parts, the gaps](../../design/protocol-governed-collaboration.md), [Task unit semantics](../../design/task-unit-semantics.md)

## Problem

Two proposed records each need the same sentence, and neither states it. The legality record says what the
program does and what it refuses to decide. The frame and storage record says what the core knows and what
it never parses. Those are the same division, seen from the side of the decision and from the side of the
data, and because nothing names it, the division has to be re-argued every time a field or a rule appears.

The cost is already visible. The assumption that work means a patch reached six places, and one of them is a
legality rule written in the kernel's own vocabulary: `refuseWidening` decides permission closure by reading
`parent.patch.editable`, so a rule about write sets is expressed in terms of a work shape the kernel is not
supposed to know.

The split also needs to be sharp enough to settle an argument rather than to serve as a slogan. "Keep policy
out of the core" does not decide whether `effect` or `operation` may be a column, or whether a legality rule
may live in the program at all.

## Proposal

Take Hydra's principle - a kernel provides mechanisms and refuses policy - and state it as two contracts.

**Mechanism contract** (the core: the board, the store, the program):

- one claim: compare-and-set, lease, attempt fence
- an opaque declaration with a digest
- an opaque artifact with a digest
- a verdict given by someone else
- the lifecycle: expiry, reaping, wake delivery, compact read
- the legal set: which units are legal now, in order, cut to the declared slot budget, with a reason per unit

**Policy contract** (above the core: the protocol, the plan, the agents):

- what a unit's inputs are, the artifact class, how the artifact is judged, how the work runs (synchronous
  or detached, interruptibility, whether abandoning it midway is safe), and its concurrency preconditions
- the wording and the enablement of legality rules: named by the protocol, enabled by the plan
- who is chosen, in what order, who adopts, who judges

**The decision procedure.** For each field, type and code path, ask whether it is mechanism or policy. A
rule's _check_ is mechanism; the rule's _name, wording and enablement_ are policy.

**The mechanically checkable rule.** No policy word may appear in the mechanism layer's code, type
declarations or schema paths. The list is maintained - `patch`, `editable`, `files`, `instruction`,
`checks`, `repair-first` - and a hit is a leak rather than a style question. The list may grow, and adding
a word is recorded. A word alone is not enough to judge: `files` is a policy word in a ticket type and a
mechanism word at a filesystem boundary, so the check carries the path.

**Rows deliberately left undecided**, so that they are not settled by accident:

- `task_run_tasks.effect`, the declared write set, is mechanism only if the mechanism must enforce that
  write sets do not overlap. If enforcement is a protocol obligation, it is policy data.
- the granularity of `input` and `dependencies`: dependencies affect legality and order, which is mechanism,
  but whether an input carries content or only a digest is a separate question.
- `operation`, which may be policy.

## What this makes of the work shape

A work shape is not a core concept. It is the policy layer's name for the declaration-and-artifact pair
that the core carries without understanding it. The six sites where the patch assumption lives classify as
follows.

| Site                                                                         | Mechanism or policy                                   | Where it belongs                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `BoardTicket.patch?: FrozenPatchTask & { digest }`                           | policy                                                | the ticket carries an opaque `declaration` with a digest                                                                               |
| `patchFrozen()` calling `preparePatchWork`, and the `not a patch task` throw | policy inside the core                                | freezing and field validation move into the shape adapter; the core only hands back the opaque declaration                             |
| `refuseWidening` reading `parent.patch.editable`                             | check is mechanism, wording and enablement are policy | permission closure becomes a declared constraint the program enforces and reports reasons for                                          |
| the ten `FrozenPatchWork` signatures in the session mechanism                | mixed                                                 | rendering a declaration into a prompt and submitting an artifact are policy; session lifecycle, metrics and cancellation are mechanism |
| `task_run_tasks.patch_files` / `patch_editable`, parsed in the store         | policy in the schema                                  | belongs in the payload document; the mechanism part is the run, task, revision, input, dependency and operation columns                |
| drivers asserting `ticket.patch!.digest`                                     | policy assertion                                      | the mechanism assertion is that a declaration carries a digest, that a claim binds the attempt, and that a delivery binds the digest   |

The legality rule found today is the clearest case of the refinement this record adds: its check belongs to
the program, while permission closure's name and enablement belong to a declaration. The fix is therefore not
to move the check out of the program but to stop hard-wiring the rule in the kernel's vocabulary - the same
shape of fix as plan step 3 of the legality record, where repair-first becomes a declared constraint rather
than shared planning policy. Two independent fixes taking the same shape is evidence that the classification
is the right one.

## Alternatives considered

- **Keep the slogan and decide case by case.** Rejected: that is what produced six sites, and it offers no
  test to apply.
- **Put the principle in the frame record.** Rejected: the principle is wider than the frame - it also
  governs the program's share of decisions - so the frame record would become the owner of a rule about the
  program.
- **Put it in the legality record.** Rejected for the same reason in reverse: that record is narrower, being
  about the program's decisions, and what the core may know is not a legality question.
- **A plugin framework with a registry above the core.** Rejected: no second policy exists to justify the
  machinery; one default adapter plus one other shape tests the seam.
- **Decide the undecided rows now.** Rejected: choosing them by preference is precisely what this record
  replaces with evidence.

## Acceptance criteria

- The classification covers every site that mentions a policy word, each row marked mechanism, policy, or
  undecided.
- No policy word appears in the mechanism layer's read and write paths, type declarations, or schema paths,
  from a maintained list and checked mechanically.
- A legality rule's name and enablement come from a declaration, while its check runs in the program and
  returns a reason per unit.
- Adding a second work shape changes no mechanism code, demonstrated by the value work the data-check
  runner already performs.
- Every undecided row is marked as undecided and is resolved by an experiment rather than by preference.
- The legality record and the frame record both point here, so the division has one home.

## Risks

- **Gutting the core.** Hydra's lesson cuts both ways: a kernel with no default policy is unusable. The
  practical form is that the core may carry one default policy, patch work, and must not require it.
- **The policy-word list can ossify.** A word may be mechanism in one place and policy in another, so the
  check needs the path rather than the word alone, and the list has to accept additions.
- **An undecided row can become permanent.** A row marked undecided without an experiment behind it is a
  policy nobody declared.
- **A policy word may legitimately remain for a release.** This record does not require a big-bang rename; it
  requires that each remaining occurrence is listed.
- **A grep check can be gamed by synonyms.** The check is a floor, not a proof of separation.

## Plan

1. This record. No code.
2. The classification table, with the undecided rows marked.
3. The check: a maintained policy-word list plus a script, wired into the static set.
4. Both records point here.
5. Then the work-shape slice: the mechanism side carries an opaque declaration, with patch as the default
   adapter rather than a type.
