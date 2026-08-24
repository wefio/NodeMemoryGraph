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
  Related records include the
  [node-summary acceleration research](experiments/node-summary-accelerated-retrieval-2026-08-19.md)
  and the current [benchmark result summary](experiments/benchmark-results.md).

Rule of thumb: _how NMG works or should work_ belongs in `design/`; _why this
choice was made_ belongs in `decisions/`; _what was measured_ belongs in
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
drift and missing decision translations are warnings for human review. In CI,
only public/canonical entry breakage and malformed decision records block the
build; internal and experimental document issues remain advisory.

## CI contract

This section is the policy owner for automated documentation checks. Change this
table before changing `scripts/verify-docs.mts`; the script implements these
rules and must not invent additional policy.

| Rule                                                                                                           | Scope                                                                                                                | CI result     |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| English/Chinese entry files both exist                                                                         | root README, docs index, decision index                                                                              | error         |
| H1 and local links are valid                                                                                   | root README, docs index, normative design baseline, completion audit, decision indexes and records, each Skill entry | error         |
| Filename, unique lifecycle location, exact status, and non-empty required sections match the decision contract | decision records                                                                                                     | error         |
| Skill frontmatter contains a name matching its directory and a non-empty description                           | each `skills/<name>/SKILL.md`                                                                                        | error         |
| H1 and local links are valid                                                                                   | all other docs and Skill references                                                                                  | warning       |
| Content documents live under `design/`, `decisions/`, or `experiments/`                                        | direct children of `docs/` other than README and AGENTS                                                              | warning       |
| Paired documents exist, link to each other, and retain broadly aligned heading structures                      | bilingual pairs                                                                                                      | warning       |
| Run-report filenames end in `-YYYY-MM-DD.md`; rolling summaries and notes use `-results.md` or `-notes.md`     | documents under `experiments/`                                                                                       | warning       |
| Explicit decision supersession metadata uses valid local links in both directions                              | decision records that declare supersession                                                                           | warning       |
| Translation quality, design correctness, experimental conclusions, and prose style                             | all documents                                                                                                        | not automated |

An error means the repository's documented public or normative interface is
broken in a mechanically reproducible way. A warning is maintenance input for an
Agent or reviewer and must not fail CI.
