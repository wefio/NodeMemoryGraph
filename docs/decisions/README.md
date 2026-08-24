# NMG decision records

[中文](README.zh-CN.md)

Decision records preserve rationale that cannot be reconstructed safely from the
current design or Git diff alone. They explain non-trivial architecture and
process choices; the normative behavior remains in `docs/design/`.

## Lifecycle

- `proposed/` — open proposal. Required sections: Problem, Proposal,
  Alternatives considered, Acceptance criteria, Risks.
- `implemented/` — accepted and implemented decision. Required sections:
  Problem, Decision, Alternatives considered, Consequences.
- `rejected/` — rejected proposal kept for future context. Preserve its proposal
  and alternatives, and state why it was rejected.
- `archived/` — a formerly implemented decision no longer governing the current
  system. State its archive date and successor when one exists.

The directory is the lifecycle. Each note also carries a matching `Status:` line.
Move a note when its state changes; do not copy it into another directory.

Before creating a note, search for the existing owner. Update that note when a
new choice refines the same decision. If a decision fully supersedes another,
cross-link both notes and archive the old one; if supersession is partial, keep
both and state the remaining scope.

Decision notes should normally have an English and `.zh-CN.md` version that link
to one another. Missing translations are reported as warnings, not hard errors.
