---
name: doc-maintenance
description: Maintain this repository's design, decision, experiment, bilingual, TODO, and operating documentation. Use whenever a change adds or revises behavior, architecture, process, evaluation evidence, public instructions, or when documentation is reorganized, translated, archived, deduplicated, or audited.
---

# Documentation maintenance

Keep NMG documentation useful as an interface between users, Agents, design, and
implementation. Read [the documentation index](../../docs/README.md) before
editing. Use its Chinese counterpart when Chinese wording is part of the task.

## Meta-rule: NMG's own rules are governed

Rules and decisions about NMG are themselves NMG artifacts and follow the same
discipline as the code they govern. This is the rule that makes every other rule
change deliberate rather than silent.

- **A rule change is a non-trivial change.** Adding, weakening, or moving a
  standing rule, Skill convention, or decision convention is itself a decision:
  state what changed, what it replaces or beats (alternatives), and why, in the
  owning record, in the same change. Never change a rule silently inside a code
  edit, a commit body, or a prose aside.
- **One home per rule.** State each rule once at its owner — an `AGENTS.md`
  standing order, the owning Skill, or a decision record — and link elsewhere by
  relative Markdown path. If the same rule appears twice, delete the copy and
  link the owner.
- **Prefer a gate to a reminder.** When a rule must be followed in many places or
  protected against drift, turn it into one mechanical check at its owner rather
  than restating it. A rule restated everywhere is a rule enforced nowhere.
- **Keep a new rule reversible and grounded.** Prefer a documented convention
  over entrenched machinery. A rule that needs new space, or replaces an existing
  rule, records what it costs and what it beat.

## One home per fact and the slop checklist

Durable prose follows one home per fact: state each fact once in the surface that
owns it (Workflow step 3 lists them) and link elsewhere; if a fact appears
twice, delete the copy and link the owner. Keep docs and rules lean because
generative Agents read them every session.

Hunt these in any doc you write or touch; a rule restated in two homes, or a
fact narrated as history, is drift waiting to happen:

- The same rule or fact in more than one home. Keep one; link the rest.
- Change-history narration in durable prose: "previously / now / no longer /
  renamed / was moved", or PR/commit positions. State the current fact; put the
  change story in the commit, decision, or experiment, not in design prose.
- Implementation-status annotations ("implemented! / future: …"). The code and
  package manifests carry status; it rots in prose.
- Hand-restated catalogs, JSDoc, or inventories of tests/packages when source or
  a generator is authoritative.
- Reasoning transcripts: step-by-step implementation narration, proof of obvious
  branches, or rejected local alternatives restated as prose. Keep the resulting
  contract or rationale; drop the path used to derive it.
- Spec-speak in an implemented decision or note: "should / Proposal / Plan /
  Acceptance criteria". An implemented record states what is, in the present
  tense.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands
  out. Reserve it for the clause that changes behavior.

**Headers are a closed vocabulary.** A record's header block — the lines before
its first `##` — carries only the fields its surface documents, and `docs:check`
rejects anything else. A decision's set is in
[decisions/README.md](../../docs/decisions/README.md). A design carries
`**Status:** draft | current | superseded` (absent means current) plus at most
`Created`, `Updated`, `Authority`, `Related`, `Supersedes`, `Superseded by`; a
superseded design lives in `docs/design/archived/` and names its successor.
Free-form status sentences are what this replaced.

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
