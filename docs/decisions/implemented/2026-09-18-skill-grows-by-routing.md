# A Skill that outgrows its byte budget routes detail into `references/`

**Status:** implemented
**Approved:** explicit
**Relates to:** [repository development skill](../../../skills/repo-development/SKILL.md),
[docs index byte-budget row](../../README.md#ci-contract),
[NMG memory skill](../../../skills/nmg-memory/SKILL.md),
[long detached checks](2026-09-18-detached-long-checks.md)

Governing meta-rule: [self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) —
this change alters a Skill convention, so it carries its own decision and alternatives.

中文版: [2026-09-18-skill-grows-by-routing.zh-CN.md](2026-09-18-skill-grows-by-routing.zh-CN.md)

## Problem

The byte budget that `docs/README.md#ci-contract` documents and `scripts/verify-docs.mts`
enforces is pinned to five `skills/*/SKILL.md` entries at 15,000 B each. The ceiling is not
incidental: those entries are the standing rules a generative Agent reads every session, so
the budget buys a bounded first read.

On 2026-09-18 that ceiling did real work and then became an obstacle. `skills/repo-development/SKILL.md`
reached 15,685 B when the detached-long-checks rule was added, and the first fix was to
compress the rule — twice — to 14,931 B, leaving 69 B of headroom. That is the wrong
pressure: the rule's measured justification (the ~13 min `mutation:teeth`, the three-state
reading, the `A && B &` trap) then had to live somewhere other than the rule it explains,
and the next rule to arrive would have to fight for the same 69 bytes. A document that
cannot grow except by deleting its own reasons is not a maintained document.

The repository already answers this. `skills/nmg-memory/` is a Skill whose entry is 10.3 KB
and whose detail sits in eight `references/*.md` files (two of them over 10 KB), routed by a
"When to read the manual" list that pairs each trigger with its reference path. Those references are
read on demand, and the budget does not apply to them — the policy row's scope is "each
high-read `skills/*/SKILL.md`", not every file under the Skill. So the pattern that keeps the
first read bounded exists; what was missing was saying that it is the intended way for a
Skill to grow.

## Decision

1. **A Skill grows by routing, not by raising its ceiling.** When the entry approaches its
   budget, move whole sections whose _trigger_ is occasional into `references/<subject>.md`,
   and add a routing list to the entry that names the trigger, not the topic: it reads "For <task>" and gives the reference path.
   Do not raise `BYTE_BUDGETS` and do not compress a rule into losing the facts it depends on.
2. **Split by how often the section is needed, not by size.** The entry keeps every section a
   change normally walks through — governance, discovery, test classification, the
   implement-and-verify spine. Sections needed only for a specific kind of change move out.
3. **A moved section keeps its meaning and its incoming pointers.** The whole section moves
   with its conditions and exceptions (a rule may not lose a clause to a smaller file), its
   relative links are re-rooted for the new depth, and every document that pointed at it by
   name or anchor is updated in the same change. Note that the link checker strips `#fragment`
   and therefore _cannot_ catch a stale anchor: this is a by-meaning check, not a mechanical one.
4. **A moved rule gains an owner row.** If the reference now owns a topic that `agent-context.yaml`
   routes (`packaging`, `repository-control-plane`, adapters), that route names the reference
   among its `owners`, exactly as the adapter routes name `skills/nmg-memory/references/harness-adapters.md`.
5. **The policy row keeps the rule.** `docs/README.md#ci-contract` states next to the byte
   budget that the ceiling covers the always-read entry and that detail routes into
   `references/`; the reasoning stays in this record.

Applied to `skills/repo-development/` in the same change: `## Repository Control Plane beyond
agent:verify` (2,741 B) becomes `references/control-plane.md` and `## Builds and generated
artifacts` (1,702 B) becomes `references/builds.md`, so the entry is ~10.4 KB with ~4.5 KB of
headroom. Both sections stay available and keep their text; the two sections that carried
incoming anchors (`#before-editing`, `#implement-and-verify`) stay in the entry precisely so
no implemented record needs its link rewritten.

## Alternatives considered

- **Raise the 15,000 B ceiling for this entry.** Rejected. The ceiling's purpose is the
  always-read first read; raising it for one entry makes the number arbitrary for every other
  entry, and the pressure that produced the compression would return at 18 KB instead of 15 KB.
- **Keep one file and compress harder.** Rejected on evidence: the detached-checks rule was
  already compressed twice, and the second compression removed the measured detail from the
  rule while leaving it in the decision record — the rule and its justification had started to
  live apart. Continuing that way trades meaning for bytes.
- **Move the entry's largest section, including `Implement and verify` (5,475 B).** Rejected.
  It is the spine every change walks, so the split would cost a second file read on the common
  path, and it holds one of the two incoming anchors plus the `ci-and-tests` route owner.
- **Route into `docs/design/` instead of `references/`.** Rejected: a Skill's operating
  procedure is not a design document, `docs/design/` content is checked as design, and the
  `references/` convention already exists in this repository with an established routing style.
- **Make the budget apply to every file under a Skill.** Rejected: it would defeat the purpose
  by capping the on-demand detail that exists to keep the entry small, and it would break
  `skills/nmg-memory/` immediately.

## Consequences

- A Skill can keep growing without its entry growing, and the always-read cost stays bounded
  by a number the policy table states.
- The entry becomes a map as well as a rule set: a reader who does not need the occasional
  sections never pays for them, and one who does has a named trigger to follow.
- Splitting is a decision about triggers, so it must be re-examined when a "rare" section
  becomes common — the cost of a wrong split is one extra file read on the hot path.
- Stale anchors are invisible to `docs:check` (it strips `#fragment`). The review of incoming
  pointers is therefore an obligation on the change, and this record states it rather than
  relying on the checker.

## Deferred

- **Making the fragment check real.** `verify-docs.mts` could validate that a link's `#fragment`
  matches a heading in the target, which would turn the pointer half of decision 3 into a
  mechanical check. Not done here: it is a change to the documentation contract with its own
  false-positive surface (GitHub's heading slugs vs. the repository's), and no broken anchor has
  been collected yet.
- **A second split if the entry approaches its ceiling again.** The remaining large sections are
  `Implement and verify` and `Repository governance`. If either has to move, it is a decision
  about the hot path rather than a mechanical follow-up.
- **A pointer that lives in another worktree.** `AGENTS.md` in a sibling checkout (branch
  `feat/ooo-s4-comparison`, uncommitted there) refers to the "Builds and generated artifacts"
  section of this Skill by name. When such a pointer lands, it names `references/builds.md`.
