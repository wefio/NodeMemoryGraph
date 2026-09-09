# Enforce the documented documentation rules

[中文](2026-09-09-enforce-documentation-rules.zh-CN.md)

**Status:** implemented

## Problem

`skills/doc-maintenance/SKILL.md` already carries a slop checklist, and it already
names the two rules this proposal enforces: "Spec-speak in an implemented decision
or note: should / Proposal / Plan / Acceptance criteria", and "Hand-restated
catalogs, JSDoc, or inventories of tests/packages when source or a generator is
authoritative". Nothing checks either one, and the repository violates both.

- Three `implemented/` decisions carry `## Acceptance criteria`: the traceability
  matrix, the terminology index, and the chaos-job migration.
- `docs/design/ci-cd-and-quality.md` listed `禁止项` (the removed `invariants`
  field) and `预期产物` (the removed `expectedArtifacts` field) in the work-order
  field list, two migrations after the fields changed. It was corrected by hand in
  `c7b450c`; no check would have caught it.
- `docs/decisions/README.md` restates every decision's title and open items. A
  probe decision added to `proposed/` produced no complaint that the index omits
  it, so the copy can silently disagree with the decision it copies.

A rule that exists only as prose is a claim about the repository, not a property
of it. The gap is not a missing checklist; it is an unenforced one.

## Decision

`docs:check` enforces the two checklist items that are mechanically checkable. It
enforces exactly the headings the skill bans: `## Risks` is not among them, and
the 2026-08-29 control-plane decision states its accepted risks in the present
tense, so that heading stays.

- An `implemented/` decision containing `## Proposal`, `## Plan`,
  `## Acceptance criteria`, or `## Risks` fails the check. Unfinished or
  unverified items move to `## Deferred`, the section
  [declare what was not verified](2026-09-09-declare-what-was-not-verified.md)
  points at. The three violating decisions are migrated by this change.
- `docs/decisions/README.md` drops its three itemized lists and keeps the
  lifecycle contract. The lifecycle directory tree is the inventory; repository
  search, `agent:context` routing, and the glossary anchors provide discovery.
  `docs:check` prints a one-line decision summary — how many decisions are
  implemented and how many carry a non-empty `## Deferred` — so the signal the
  lists' one-line reasons carried survives without a copy to maintain.

The remaining checklist items stay review-only. "Narrated history",
"hand-restated inventories", "reasoning transcripts", and "emphasis inflation"
are judgments about prose; a grep that flags them flags legitimate writing too.

## Alternatives considered

**Keep the hand-maintained list and gate its completeness.** The gate would exist
only to protect a duplicate. The list restates each decision's title and its open
items, both of which the decision file owns, and its one-line reasons must be
written twice more, in English and Chinese. A gate on a copy makes the copy
reliable instead of removing it.

**Generate the index instead of writing it.** DeepSeek Harness did exactly this
and removed it about two weeks later (commit `4779d04af8`, net -490/+210): it
deleted `.agents/notes/INDEX.md`, a 130-line generator, a 36-line renderer, and
the npm script, and moved the decision that introduced the index from
`implemented/` to `rejected/`. Its reasons apply unchanged — the index duplicates
facts the path already encodes (lifecycle, date, title), every branch that adds a
decision rewrites it, and the generator, the command, and the freshness check are
maintenance for a discovery path the tree and search already serve. It rejected
the uncommitted on-demand variant for the same reason. Generating the index here
would also add the only field the path does not carry, whether the decision has
open items, which `rg -l '^## Deferred'` already answers.

**Ban the headings without providing `## Deferred`.** A ban alone pushes the
content into `## Consequences`, where a reader cannot distinguish "we accepted
this cost" from "we did not do this yet". The named section keeps the two
separate, which is the point of the change.

**Add a tier table with a "does not belong here" column.** That is the shape
DeepSeek Harness uses. Workflow step 3 of the same skill already assigns each
surface its facts; the missing column is a reading aid, not a rule, so it is not
added here.

**Enforce the whole checklist.** Only the heading set and the duplicated
inventory are mechanically checkable, and only the heading set is checkable
without false positives.

**Add a class axis to the decision tree.** DeepSeek Harness encodes lifecycle and
class in the path (`{lifecycle}/{class}/`). NMG has 21 decisions; renaming all of
them to gain a filter buys little now. Revisit when browsing the tree stops
working.

## Verification

- `docs:check` fails an `implemented/` decision carrying `## Proposal`,
  `## Plan`, or `## Acceptance criteria`, with a test for each banned heading in
  `tests/docs/verify-docs.test.ts`.
- `docs:check` prints the decision summary line and counts a decision with a
  non-empty `## Deferred` as open; both are covered by tests.
- The three migrated decisions record their open items under `## Deferred` in
  both languages.
- `docs/decisions/README.md` no longer lists individual decisions and still
  states the lifecycle contract.
- `npm run docs:check` reports zero errors and no new warnings.

## Consequences

- **Mechanical compliance.** Renaming `## Acceptance criteria` to `## Deferred`
  satisfies the gate without moving the content's meaning. The migration was
  reviewed; the gate only keeps the heading from coming back.
- **Discovery.** Removing the lists means "which decisions exist?" is answered by
  the directory tree and search. The summary line and the README's pointer to the
  tree are the compensation; if browsing the tree stops working, the class-axis
  alternative becomes relevant.
- **The unenforced remainder.** Three checklist items stay prose. That is honest,
  not solved: the design-doc defect was caught by reading, and will be again.
