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
schema literals on those paths count too. The gate implements the classification and static-check
slice (original Plan 2–3); it does not prove work-shape separation. The frame/storage proposal remains proposed.

### Opaque dispatch declarations

The dispatch port carries a required, nullable `declaration`, parameterized by its shape, with only a
`digest` required by the shared mechanism. The base `BoardTicket` has the same opaque carrier. Default
adopters specialize it to their own declaration type and freeze and validate it before returning a
ticket. The loop passes that declaration unchanged; it neither reconstructs patch work nor renders it.
A missing declaration is an adopter contract failure, not an implicit patch default.

An adopter can return a named refusal without issuing a ticket. The loop records that as a slot refusal,
separately from a failed worker or an invalid ticket. The [numeric-adopter evidence](../../experiments/execution/field-ownership-2026-10-01.md#numeric-adopter)
exercises both the shared port and the real store's lease, delivery and independent verdict. It is a
controlled seam test, not a production peer-protocol installation or a frame/storage migration.

**Rows deliberately left undecided**, so that they are not settled by accident:

- `task_run_tasks.effect` is an effect-class label, not the declared proposal-write set. Whether
  resource-set exclusion is a common mechanism obligation or a protocol obligation is a separate
  question; the [field experiment](../../experiments/execution/field-ownership-2026-10-01.md) does not
  turn the current class-label gate into an exclusion check.
- the granularity of `input` and `dependencies`: dependencies affect legality and order, which is mechanism,
  but whether an input carries content or only a digest is a separate question.
- `operation`, which may be policy.

### Declared refinement constraints and session policy

A refinement declares `constraints`, including an explicit empty list. A supported primitive
`within-parent-writes` checks the parent's normalized proposal-write resource set, not
`parent.patch.editable`. The protocol supplies its name; presence enables it. Unsupported primitives,
unknown fields and duplicate names are refused at their declaration. A parent's permission obligation
cannot be dropped by omitting its constraint. The [controlled refinement cases](../../../tests/integration/task-refinement-declaration.test.ts)
exercise opaque numeric resource identities, not file paths, and retain obligation coverage.

Generic session input, state and runner contracts carry rendered text, counters and caller-declared
bounds without patch interpretation. [The default session adopter](../../../src/integration/ooo-patch-session.ts)
owns patch rendering, artifact validation, tool names and its snapshot-read minimum. Compatibility
exports in the shared module refer to these same functions, not copies. The adapter remains in the
scan surface, classified as policy; relocation is not a file exemption or a claim of zero policy.
The [generic-session cases](../../../tests/integration/ooo-generic-session.test.ts) exercise an input and
state with no patch fields and completion with a declared zero-read minimum, while the default policy
retains its read requirement. They do not run a live harness.

### Declaration storage ownership

The default protocol owns the retained typed Task-Unit schema and codec; the adopter owns immutable
attempt inputs and restoration. Store compatibility methods forward through the existing connection
and transaction. Both storage adapters remain in the reviewed scan surface, classified as policy.
The [storage ownership decision](2026-10-02-declarations-have-one-owner.md) records this approved slice;
it neither migrates the board payload nor installs a peer-protocol interface.

## Deferred

Permission closure retains a program check while its name and enablement come from the declaration.
This has the same boundary as the legality record's declared repair-first constraint: enforcing a
selected rule is not choosing it. The write-subset primitive does not claim to enforce arbitrary
resource exclusion or all effects.

### Field experiments and separation evidence

- The [controlled field probe](../../experiments/execution/field-ownership-2026-10-01.md) supplies
  reproducible evidence for effect labels, content-bound digests, dependency release and operation
  interpretation. It narrows the questions; it does not decide the universal input granularity or a
  storage migration. This gate does not include those words or resolve them.
- The `TaskUnit` `files` group remains `undecided`: it mixes patch-only paths with another role. The
  schema migration's filesystem prose and protocol-owned DDL have distinct scanned owners; that
  separation does not settle the `TaskUnit` group.
- A numeric declaration runs through the widened dispatch seam and the real board lifecycle without
  further mechanism changes. The controlled permission and session cases establish their narrower
  contracts, not a policy-free store or a four-role peer-protocol interface. Zero policy hits and that
  broader interface remain unverified goals. Passing the ratchet proves none of them. The draft's
  [second-shape experiment](../../design/mechanism-in-the-middle.md#results) remains historical coupling
  evidence, not the current seam test.

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
