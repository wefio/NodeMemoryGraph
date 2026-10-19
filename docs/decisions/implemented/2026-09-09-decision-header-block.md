# A fixed header block for decision records

[中文](2026-09-09-decision-header-block.zh-CN.md) · [Terms used](2026-09-09-decision-header-block.terms.yaml)

**Status:** implemented  
**Approved:** explicit

## Problem

A decision record's metadata has no stable position and no rules. `docs:check`
reads `**Status:**` wherever it appears, takes the first match, and validates
nothing else. Three probes on 2026-09-09 confirmed the gap: a second conflicting
`**Status:**` line is ignored, `**Date:** 1900-13-99` is accepted, and a
`**Status:**` line below the first section passes.

At the time of the 2026-09-09 review, the field vocabulary had already drifted,
which is what an unruled header produces:

| Field in use | Count | Problem |
|---|---|---|
| `**Status:**` | 21 | the only validated field |
| `**Date:**` | 13 | duplicates the filename date; absent from the other eight decisions |
| `**Branch:**` | 3 | a branch position in durable prose, which the slop checklist bans |
| `**Implementation status:**`, `**Partial implementation (…):**`, `**Also implemented:**`, `**也已实现:**` | 4 | four spellings of one idea, all prose paragraphs wearing a field |

`**Date:**` is the clearest case: every decision that carries it has a date equal
to its filename, and eight decisions omit it entirely, so the field is both
redundant and inconsistent.

## Decision

A decision carries a fixed field block before its first section, enforced by
`docs:check`:

```markdown
# <title>

[<counterpart>](<slug>.<lang>.md)

**Status:** <proposed|implemented|rejected|archived>
[**Approved:** <explicit|auto|unrecorded>]
[**Supersedes:** [..](..)]
[**Superseded by:** [..](..)]
[**Relates to:** [..](..)]
[**Archived:** YYYY-MM-DD]
```

The block is closed: `**Status:**`, `**Approved:**`, `**Supersedes:**`,
`**Superseded by:**`, `**Relates to:**`, and `**Archived:**` are the only
fields. Any other `**Field:**` line before the first section fails the check,
so a prose note moves below the block. Each field appears at most once.
`**Status:**` is required and must equal the lifecycle directory;
`**Approved:**` is required under `implemented/` and is `explicit`, `auto`, or
`unrecorded` (see [approval tiers](2026-09-09-approval-tiers.md));
`**Archived:**` is valid only under `archived/`.

`**Date:**` is deleted. The filename carries `YYYY-MM-DD`, so the field was a
second copy of the same fact, and the eight decisions without it were not missing
anything. `**Branch:**` is deleted as change-history narration. The four prose
pseudo-fields become plain paragraphs below the block.

The rule lives in `docs/decisions/README.md`; the gate and its tests are in
`scripts/verify-docs.mts` and `tests/docs/verify-docs.test.ts`.

## Alternatives considered

**YAML front matter.** It would make the metadata trivially parseable, but
`Status` and the lifecycle already live in the path and the `**Status:**` line,
and the date lives in the filename; front matter would be a fourth copy. MADR
chose front matter because an ADR filename carries no date and an ADR tree
carries no lifecycle folder; NMG has both.

**A sidecar metadata file per decision** (Kubernetes KEP uses `kep.yaml`). It
separates metadata from prose cleanly and lets a generator read it without parsing
Markdown. At 21 decisions it adds a second file per decision plus a consistency
problem between the two.

**Reject bare `Word:` lines in the block as well.** This would close the remaining
header-shaped-prose gap. The legacy records that motivated the exception have
since landed; their obsolete `Date:` and `Branch:` header lines have been removed.
No broader syntax change is made by this decision.

**Keep `**Date:**` and require it.** The rendered document would show the date, at
the cost of a second home for a fact the filename owns, and of editing eight
decisions to add it.

**Enforce field order as well.** The corpus already orders fields consistently;
order is not a problem this rule needs to solve.

## Deferred

Unbolded `Word:` lines are still treated as prose, so the check recognizes only
the documented bold field syntax. The original in-flight exception has expired
and the known legacy `Date:`/`Branch:` lines have been removed. A broader ban on
header-shaped prose is outside this decision.

## Verification

Verified as of 2026-09-09:
- `docs:check` fails a duplicate field, an unknown field in the block, a missing
  `**Status:**`, and `**Archived:**` outside `archived/`, each with a test in
  `tests/docs/verify-docs.test.ts`.
- No decision carries `**Date:**` or `**Branch:**`.
- `docs/decisions/README.md` states the block and its rules.
- `npm run docs:check` reports zero errors and no new warnings.

## Consequences

**Relationship interpretation.** Each linked target in a header relationship
participates in reciprocal checking; a second target cannot make the field
invisible. Keeping that interpretation inside the header also prevents a body
example from claiming decision authority. This costs per-target checking rather
than a different metadata format or weaker warnings.

**Bare `Word:` lines stay accepted.** A field written without bold markers is
treated as prose, so the gate covers the documented syntax only.

**Prose pressure.** An author who wants a note near the top must put it below the
block. That is the intent: the block stays machine-readable.
