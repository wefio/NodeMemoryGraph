---
name: doc-maintenance
description: Maintain this repository's design, decision, experiment, bilingual, TODO, and operating documentation. Use whenever a change adds or revises behavior, architecture, process, evaluation evidence, public instructions, or when documentation is reorganized, translated, archived, deduplicated, or audited.
---

# Documentation maintenance

Keep NMG documentation useful as an interface between users, Agents, design, and
implementation. Read [the documentation index](../../docs/README.md) before
editing. Use its Chinese counterpart when Chinese wording is part of the task.

## Workflow

1. **Classify the change before writing.** Decide whether it changes normative
   behavior, records rationale, reports evidence, changes completion status, adds
   unresolved work, or changes user instructions.
2. **Find the existing owner.** Search titles and relevant terms. Update the
   owning document instead of creating another summary. Git preserves editing
   history. If a detail remains only in Git and would be expensive to rediscover,
   leave a commit or decision link in the relevant audit or decision document.
3. **Update the right surface.**
   - Behavior and architecture: `docs/design/design.md` and, when useful, one
     owning topic design.
   - Rationale and alternatives: a record under `docs/decisions/`.
   - Measured results: `docs/experiments/`; never promote a result into a design
     claim without an explicit decision.
   - Current implementation evidence: `docs/design/completion-audit.md`.
   - Unresolved action only: `docs/design/temporary-todo.md`; remove it when done.
   - User or Agent operation: README, Skill, or operating guide that owns it.
4. **Handle supersession explicitly.** Refine an existing owner when possible.
   Cross-link old and new decisions; archive a fully superseded decision, or
   state the remaining scope when supersession is partial.
5. **Maintain useful bilingual coverage.** Root and docs indexes stay paired.
   New or materially changed decisions should normally be paired. Preserve the
   same decision, warnings, and commands, but do not force paragraph-for-paragraph
   equivalence. Experiments and internal notes may remain single-language.
6. **Keep status honest.** Separate implemented, validated, enabled, default,
   deferred, and out-of-scope states. A passing controlled test is not natural
   product evidence; an experiment result is not a default-policy decision.
7. **Verify.** Apply the [CI contract](../../docs/README.md#ci-contract), then run
   `npm run docs:check` and the code or evaluation checks needed by the underlying
   change. Review warnings rather than hiding them. If automation policy must
   change, update the contract first and the verifier second.

## Commit lineage

Git remains the exhaustive changelog. Add commit information to an existing owner
only when it helps a later Agent rediscover an architectural origin, understand a
hardening fix, locate validation evidence, or avoid retrying a superseded design.

- Put a compact `Implementation lineage` section in the owning topic document.
- Group related commits; do not narrate every intermediate patch.
- Mark entries as **Introduced**, **Hardened**, **Validated**, or **Superseded**.
- A validation commit proves only what its evidence measured; it does not imply
  default activation.
- For supersession, name both the old and replacement commit or decision.
- Leave formatting, generated artifacts, dependency refreshes, ordinary tests,
  merges, and easy-to-rediscover implementation details in Git.
- Use [the curated lineage index](../../docs/design/implementation-lineage.md) to
  find owners; do not turn it into a duplicate commit database.

## Boundaries

- Do not copy project facts into this Skill. Link their canonical owner.
- Do not use `temporary-todo.md` as a changelog or completed-work archive.
- Do not make every ordinary code change a decision record. Create one when the
  rationale, alternatives, compatibility, or consequences will matter later.
- Do not block a useful change solely because a non-public translation is late.
- Do not rewrite unrelated experiment reports while reorganizing documentation.
