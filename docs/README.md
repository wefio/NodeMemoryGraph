# NMG documents

[中文](README.zh-CN.md)

This directory is the durable documentation surface for NMG. Its files have
different jobs and must not compete as independent sources of truth.

## Ownership and authority

1. **[design/design.md](design/design.md)** is the normative system model. A
   behavior or architecture change is incomplete until its owning design text
   agrees with the implementation.
2. **Topic design documents** under `design/` explain one mechanism in depth.
   They refine the baseline; they do not silently replace it.
3. **`decisions/`** records why a non-trivial choice was made, which alternatives
   were considered, and what consequences follow. Decisions explain the design;
   they are not a second specification.
4. **[design/completion-audit.md](design/completion-audit.md)** is the current
   requirement-to-evidence ledger. It records implementation and validation
   status, not design intent.
5. **[design/temporary-todo.md](design/temporary-todo.md)** contains unresolved
   work only. Completed work belongs in Git and, when durable, in the owning
   design, decision, operating, or audit document.
6. **`experiments/`** contains observations: benchmark runs, audits, probes, and
   regressions. A result may motivate a decision, but does not become normative
   merely because it was measured.
7. **`skills/`** contains Agent workflows. Skills tell an Agent how to maintain
   or use the project; they link to canonical facts instead of duplicating them.

When two files disagree, resolve the disagreement in the owning document rather
than adding another summary. Git remains the implementation history. When a
detail is intentionally left in Git but would be costly to rediscover, leave a
commit or decision link in the relevant audit or decision document instead of
copying the whole implementation narrative.

## Directory guide

- **`design/`** — architecture, data models, algorithms, and process contracts.
- **`decisions/`** — lifecycle-managed design and process decisions. See
  [decisions/README.md](decisions/README.md).
- **`experiments/`** — measured evidence. Run reports should normally be named
  `<topic>-<date>.md`. Retrieval-quality series:
  [baseline](experiments/retrieval-quality-baseline-2026-08-16.md) →
  [hybrid](experiments/retrieval-quality-hybrid-2026-08-16.md) →
  [summaries + stacked](experiments/retrieval-quality-summaries-2026-08-18.md).

Rule of thumb: *how NMG works or should work* belongs in `design/`; *why this
choice was made* belongs in `decisions/`; *what was measured* belongs in
`experiments/`.

## Bilingual policy

NMG is bilingual without requiring mechanically identical translations.

- Public entry documents are paired: root `README.md` / `README.zh-CN.md`, this
  index, and the decision index.
- New or materially changed decision notes should normally be paired. A missing
  translation is a maintenance warning, not a blocker while the project is
  evolving.
- Technical experiments, temporary investigations, and internal topic notes may
  use the language that best preserves the work.
- Paired documents link to each other and preserve the same decisions, warnings,
  and user-visible commands. Paragraph count and wording need not match.

## Maintenance workflow

Use [the `doc-maintenance` Skill](../skills/doc-maintenance/SKILL.md) whenever a
change affects behavior, architecture, evaluation evidence, public instructions,
or the document layout. Run `npm run docs:check` before committing documentation
changes. The check intentionally enforces only structural errors; translation
drift and missing decision translations are warnings for human review.
