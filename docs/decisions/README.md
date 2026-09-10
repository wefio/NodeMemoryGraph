# NMG decision records

[中文](README.zh-CN.md)

Decision records preserve rationale that cannot be reconstructed safely from the
current design or Git diff alone. They explain non-trivial architecture and
process choices; the normative behavior remains in `docs/design/`.

## Lifecycle

- `proposed/` — open proposal. Required sections: Problem, Proposal,
  Alternatives considered, Acceptance criteria, Risks.
- `implemented/` — accepted and implemented decision. Required sections:
  Problem, Decision, Alternatives considered, Consequences. Proposal-era
  headings (`## Proposal`, `## Plan`, `## Acceptance criteria`) fail
  `docs:check`; unfinished or unverified items belong under `## Deferred`.
- `rejected/` — rejected proposal kept for future context. Preserve its proposal
  and alternatives, and state why it was rejected.
- `archived/` — a formerly implemented decision no longer governing the current
  system. State its archive date and successor when one exists.

The directory is the lifecycle. Each note also carries a matching `Status:` line.
Move a note when its state changes; do not copy it into another directory.
Decision filenames use `YYYY-MM-DD-kebab-case.md`; translations add `.zh-CN`
before `.md`. The same dated slug may exist in only one lifecycle directory.
Required sections must contain content, not only a heading.

## The header block

Before the first section, a decision carries a fixed field block that
`docs:check` enforces:

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

`**Status:**` is required and must equal the lifecycle directory. `**Archived:**`
is valid only under `archived/`. Relationship fields take relative links. Each
field appears at most once, and any other `**Field:**` line in the block fails
the check: a prose note goes below the block. The date lives in the filename, so
there is no `**Date:**` field.

`**Approved:**` is required under `implemented/` and says who accepted the record:
`explicit` for the user, `auto` for the Agent under
[the approval tiers](implemented/2026-09-09-approval-tiers.md), and `unrecorded` for a
record accepted before that rule existed — debt, replaced with `explicit` when the
record is next touched.

Before creating a note, search for the existing owner. Update that note when a
new choice refines the same decision. If a decision fully supersedes another,
cross-link both notes and archive the old one; if supersession is partial, keep
both and state the remaining scope. When metadata is used, write local Markdown
links and make the pair point both ways:

```markdown
**Supersedes:** [old decision](../archived/2026-01-01-old-decision.md)
**Superseded by:** [new decision](../implemented/2026-02-01-new-decision.md)
```

Decision notes should normally have an English and `.zh-CN.md` version that link
to one another. Missing translations are reported as warnings, not hard errors.

## Finding a decision

The lifecycle directory tree is the inventory: browse
`docs/decisions/{proposed,implemented,rejected,archived}/` or search the
repository. There is no itemized index, because such a list restates each note's
title and open items, duplicates their home, and drifts once nothing checks it.
`npm run docs:check` prints how many decisions are implemented and how many
carry open items.
