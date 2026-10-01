# Mechanism, not policy

[中文](2026-09-21-mechanism-not-policy.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [The program answers legality](2026-09-20-the-program-answers-legality.md), [The frame, its data format, and its storage](../proposed/2026-09-21-the-frame-and-its-storage.md), [Board governance and capability addressing](../implemented/2026-09-06-board-governance-addressing.md), [Protocol-governed collaboration: the parts, the gaps](../../design/protocol-governed-collaboration.md), [Task unit semantics](../../design/task-unit-semantics.md)

## Problem

The legality and frame/storage records need the same ownership rule. The legality record says what the
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

## Decision

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

**The mechanically checkable rule.** Every vocabulary hit on the declared mechanism surface is
classified as `mechanism`, `policy`, or `undecided`, with a rationale and an exact occurrence count.
[The maintained list and classification table](../../../tools/policy-word-list.ts) own the vocabulary,
scan paths, and classifications. A word alone does not decide its role: `files` can name a ticket payload
or a filesystem boundary. Roles are not files.

[`check:policy-words`](../../../tools/policy-word-check.ts) is blocking in the shared static contract.
It scans TypeScript identifiers and string/template literals, including SQL, but ignores TypeScript
comments. Camel, snake and kebab spellings count; `dispatch` does not count as `patch`. Each record is
keyed by repository path, enclosing named declaration/method chain (or `<module>`), and word. Line
numbers are diagnostic only; a multiline literal is located at its starting line. Whitespace and
comment changes do not change a record's identity. `npm run check:policy-words -- --list` prints the
classified sites, observed locations and reasons.

Existing policy hits are explicitly grandfathered, not declared clean. A new site, a count change in
either direction, a stale or duplicate record, invalid classification, invalid TypeScript or missing
scan path fails the check. Removing a leak requires retiring or reducing its record. New occurrences
require an explicit classification and rationale in the same reviewed change; the checker never
refreshes counts automatically. Vocabulary additions are recorded here with their rationale.

The scope is bounded by the maintained path list, not all source, tests or drivers. Source imports and
schema literals on those paths count too. This implements the approved classification and static-check
slice (original Plan 2–3), not the work-shape conversion. The frame/storage proposal remains proposed.

**Rows deliberately left undecided**, so that they are not settled by accident:

- `task_run_tasks.effect`, the declared write set, is mechanism only if the mechanism must enforce that
  write sets do not overlap. If enforcement is a protocol obligation, it is policy data.
- the granularity of `input` and `dependencies`: dependencies affect legality and order, which is mechanism,
  but whether an input carries content or only a digest is a separate question.
- `operation`, which may be policy.

## Deferred

### Work-shape boundary

The work-shape conversion (original Plan 5) is not part of the approved slice. The patch assumptions
below remain; their classification does not assert that an opaque adapter seam has been implemented.

A work shape is not a core concept. It is the policy layer's name for the declaration-and-artifact pair
that the core carries without understanding it. The six sites where the patch assumption lives classify as
follows.

| Site                                                                         | Mechanism or policy                                   | Where it belongs                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `BoardTicket.patch?: FrozenPatchTask & { digest }`                           | policy                                                | the ticket carries an opaque `declaration` with a digest                                                                               |
| `patchFrozen()` calling `preparePatchWork`, and the `not a patch task` throw | policy inside the core                                | freezing and field validation move into the shape adapter; the core only hands back the opaque declaration                             |
| `refuseWidening` reading `parent.patch.editable`                             | check is mechanism, wording and enablement are policy | permission closure becomes a declared constraint the program enforces and reports reasons for                                          |
| `FrozenPatchWork` signatures in the session mechanism                | mixed                                                 | rendering a declaration into a prompt and submitting an artifact are policy; session lifecycle, metrics and cancellation are mechanism |
| `task_run_tasks.patch_files` / `patch_editable`, parsed in the store         | policy in the schema                                  | belongs in the payload document; run, task and revision are mechanism, while input/dependency granularity and operation remain undecided                |
| drivers asserting `ticket.patch!.digest`                                     | policy assertion                                      | the mechanism assertion is that a declaration carries a digest, that a claim binds the attempt, and that a delivery binds the digest   |

The legality rule found today is the clearest case of the refinement this record adds: its check belongs to
the program, while permission closure's name and enablement belong to a declaration. The fix is therefore not
to move the check out of the program but to stop hard-wiring the rule in the kernel's vocabulary - the same
shape of fix as step 3 of the legality record, which landed on 2026-09-23: repair-first became a declared
constraint rather than shared planning policy. Two independent fixes taking the same shape is evidence that the classification
is the right one.

### Field experiments and separation evidence

- `task_run_tasks.effect`, input/dependency granularity and `operation` remain undecided. Their owning
  field must be exercised under an alternative declaration before deciding ownership; this gate does
  not include those words or resolve them.
- The `files` groups in schema migration and `TaskUnit` are marked `undecided`: a group combines
  patch-specific paths with another role. Resolve them by separating the DDL subjects or exercising
  an alternative input declaration, not by relabelling the entire group mechanism.
- The remaining permission-closure name/enablement coupling needs a declared constraint while its
  check continues to execute in the program and return reasons.
- Zero policy hits and a second work shape requiring no mechanism changes are unverified separation
  goals, not consequences of passing this ratchet. The draft's [second-shape experiment](../../design/mechanism-in-the-middle.md#results)
  remains evidence of coupling, not a completed adapter migration.

## Alternatives considered

- **Keep the slogan and decide case by case.** Rejected: that is what produced six sites, and it offers no
  test to apply.
- **Put the principle in either narrower record.** Rejected: it governs both what the core knows and the
  program's share of decisions; neither the frame nor legality record owns the full rule.
- **A plugin framework above the core.** Rejected: one default adapter plus one other shape can test the
  seam without building a registry framework.
- **Decide undecided rows by preference.** Rejected: the field experiments remain the deciding evidence.
- **Fail every existing policy hit immediately.** Rejected: the approved slice inventories the debt;
  it does not authorize a big-bang work-shape rewrite.
- **A file-level word exemption or a maximum count.** Rejected: it silently admits replacement sites or
  leaves dead exemptions. Named-scope exact counts expose moves and reductions for review.

## Consequences

- **Gutting the core.** Hydra's lesson cuts both ways: a kernel with no default policy is unusable. The
  practical form is that the core may carry one default policy, patch work, and must not require it.
- **The policy-word list can ossify.** A word may be mechanism in one place and policy in another, so the
  check needs the path rather than the word alone, and the list has to accept additions.
- **An undecided row can become permanent.** A row marked undecided without an experiment behind it is a
  policy nobody declared.
- **A policy word may legitimately remain for a release.** This record does not require a big-bang rename; it
  requires that each remaining occurrence is listed.
- **The ratchet can be gamed.** Synonyms and same-count replacements within one named scope can evade it.
  Classifications and scope changes need review. The check is a floor, not proof of separation.
- **Exact counts cost maintenance.** Intentional code moves and removals require updating the table;
  this prevents silent growth but does not prohibit a reviewed policy change.
- The legality and frame/storage records link here for this shared ownership rule. Neither link approves
  the separate frame/storage migration.
