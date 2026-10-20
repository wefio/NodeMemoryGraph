# NMG documents

[中文](README.zh-CN.md) · [Terms used](README.terms.yaml)

Use this index to choose a reading path or the owner of a documentation change.
Start with the task below; the authority rules resolve conflicting explanations.

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
   **[design/implementation-lineage.md](design/implementation-lineage.md)** is the
   curated commit-to-owner recovery index; Git remains the exhaustive changelog.
5. **[design/temporary-todo.md](design/temporary-todo.md)** contains unresolved
   work only. Completed work belongs in Git and, when durable, in the owning
   design, decision, operating, or audit document.
6. **`experiments/`** contains observations: benchmark runs, audits, probes, and
   regressions. A result may motivate a decision, but does not become normative
   merely because it was measured.
7. **`postmortem/`** contains incident records: a failure that escaped, the
   mechanism behind it, why every safety net missed it, and the guardrails that
   now catch the class. Its triage rule, required sections, promotion and
   classification rules, and index are in
   [postmortem/README.md](postmortem/README.md).
8. **`skills/`** contains Agent workflows. Skills tell an Agent how to maintain
   or use the project; they link to canonical facts instead of duplicating them.
9. **`guides/`** contains non-normative learning paths and maps. Guides exercise
   public contracts and route readers to owners; they do not redefine design.

When two files disagree, resolve the disagreement in the owning document rather
than adding another summary. Git remains the implementation history. When a
detail is intentionally left in Git but would be costly to rediscover, leave a
commit or decision link in the relevant audit or decision document instead of
copying the whole implementation narrative.

## Directory guide

| Reader task | Start here | What it answers |
| --- | --- | --- |
| Use memory for the first time | [First recall](guides/first-recall.md) | The runnable path from a write to a recall |
| Understand a product concept | [Concept map](guides/concept-map.md) | Local explanations and links to behavior contracts |
| Find a repository-process term | [Terminology lookup](design/documentation-governance.md#yaml-files-and-query-contract) | Canonical words, aliases, namespaces and their owners; a bounded miss is not absence |
| Change behavior or architecture | [System model](design/design.md) and the relevant topic | The owning contract, including conditions and exceptions |
| Check implementation evidence | [Completion audit](design/completion-audit.md) | What was implemented and validated, with evidence limits |
| Write or reorganize documentation | [Maintenance workflow](#maintenance-workflow) | Where to edit, what to preserve and how to verify |

The directory routes below locate specialized material; they are not a required
reading sequence.

- **Product introduction:** [concept map](guides/concept-map.md) for terminology and owner
  routes, then the executable [first-recall tutorial](guides/first-recall.md).
- **Shared coordination design:** [event records and Agent task status](design/board-event-records.md) owns the additive event-space contract; delivery status stays in the completion audit.
- **`guides/`** — non-normative navigation and tested walkthroughs.
- **`design/`** — architecture, data models, algorithms, and process contracts.
  Superseded designs move to `design/archived/`. The
  [implementation lineage](design/implementation-lineage.md) records only
  commits that materially reduce rediscovery or regression risk.
- **`decisions/`** — lifecycle-managed design and process decisions. See
  [decisions/README.md](decisions/README.md).
- **`experiments/`** — measured evidence, grouped by the line of inquiry each run
  answers ([topic list](experiments/README.md)). Retrieval-quality series:
  [baseline](experiments/retrieval-quality/baseline-2026-08-16.md) →
  [hybrid](experiments/retrieval-quality/hybrid-2026-08-16.md) →
  [summaries + stacked](experiments/retrieval-quality/summaries-2026-08-18.md).
  Related records include the
  [node-summary acceleration research](experiments/retrieval/node-summary-accelerated-retrieval-2026-08-19.md)
  and the retained [historical benchmark snapshot](experiments/benchmark-results.md).
- **`postmortem/`** — numbered incident records with a failure-class index; read
  [its index](postmortem/README.md) before writing one.

Rule of thumb: _how NMG works or should work_ belongs in `design/`; _why this
choice was made_ belongs in `decisions/`; _what was measured_ belongs in
`experiments/`; _what broke and why it escaped_ belongs in `postmortem/`. An
experiment commit does not become normative until an explicit design or decision
owner accepts the result.

## Bilingual policy

All non-temporary reader-facing documentation requires English and Chinese
versions. This includes retained designs, decisions, experiments, incident
records, operating guides, Skills and their references. Being internal, draft or
archived is not an exemption. A maintained TODO index is not disposable merely
because its filename contains `temporary`.

Organize each topic as three related artifacts with one subject basename:

- `topic.md`: English text;
- `topic.zh-CN.md`: Chinese text;
- `topic.terms.yaml`: the terms used by both versions, with locally owned
  definitions and canonical-term references to definitions owned elsewhere.

Link the language versions to each other and the shared term file. The versions
must preserve the same facts, obligations, conditions, warnings and commands;
paragraph count and wording need not match. A term reference does not create a
second definition. Preserve correct literal APIs, paths, values and commands;
change them only for an actual contract change or a verified correction of an
incorrect example.

Only explicitly disposable working material with a stated cleanup condition may
remain single-language. If it is retained as documentation, bring it into the
three-artifact form. Raw data, logs, source code and machine-input fixtures are
not prose translations; preserve their original bytes and document them separately.

Existing missing translations or term companions are remediation debt, not
implicit exemptions. Updating the policy does not establish coverage completion.
The CI table below still describes the admitted mechanical checks and severities;
a passing check does not certify complete bilingual or terminology coverage.

## Maintenance workflow

The accepted [documentation-governance direction](design/documentation-governance.md)
explains reader review, distributed YAML definitions and the limits of each check.
It does not replace the workflow or the CI policy below.

Use [the `doc-maintenance` Skill](../skills/doc-maintenance/SKILL.md) whenever a
change affects behavior, architecture, evaluation evidence, public instructions,
or the document layout. Run `npm run docs:check` before committing documentation
changes. The command runs structural verification and document-group completeness checks.
Translation meaning and drift remain review responsibilities; missing group
members in the admitted corpus are errors. In CI,
public/canonical entry breakage, malformed decision records, and structural
hygiene in active designs and Skill Markdown block the build. Other checks retain
their separate error/warning scopes below; passing them does not establish prose
quality or semantic equivalence.

## CI contract

This section is the policy owner for automated documentation checks. Change this
table before changing `scripts/verify-docs.mts` or
`scripts/verify-document-groups.ts`; the scripts implement these rules and must
not invent additional policy.

| Rule                                                                                                                               | Scope                                                                                                                                               | CI result     |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Non-empty ATX headings and sections, and unique normalized sibling titles outside fenced code and HTML comments | all active `docs/design/**/*.md` (excluding `docs/design/archived/`) and all `skills/**/*.md`; required documents `docs/design/documentation-governance.md`, `docs/design/ooo-execution-bootstrap.md`, `skills/doc-maintenance/references/reader-review.md` must still exist | error |
| English/Chinese entry files both exist                                                                                             | root README, docs index, decision index, post-mortem index                                                                                          | error         |
| H1 and local links are valid                                                                                                       | root README, docs index, normative design baseline, completion audit, decision indexes and records, post-mortem index and records, each Skill entry | error         |
| Filename, unique lifecycle location, exact status, and non-empty required sections match the decision contract                     | decision records                                                                                                                                    | error         |
| Filename, unique contiguous number, exact status, non-empty required sections, and one index row per record                        | post-mortem records and their index                                                                                                                 | error         |
| Skill frontmatter contains a name matching its directory and a non-empty description                                               | each `skills/<name>/SKILL.md`                                                                                                                       | error         |
| H1 and local links are valid                                                                                                       | all other docs and Skill references                                                                                                                 | warning       |
| Content documents live under `design/`, `decisions/`, `experiments/`, or `postmortem/`                                             | direct children of `docs/` other than README and AGENTS                                                                                             | warning       |
| English, Chinese and terms companions are regular files; orphan companions also fail | root README and all Markdown/terms companions under `docs/` and `skills/`, including archives and new nested topics | error |
| Paired documents link to each other and retain broadly aligned heading structures                                          | bilingual pairs                                                                                                                                     | warning       |
| Run-report filenames end in `-YYYY-MM-DD.md`; rolling summaries and notes use `-results.md` or `-notes.md`                         | documents under `experiments/`                                                                                                                      | warning       |
| Explicit decision supersession metadata uses valid local links in both directions                                                  | decision records that declare supersession                                                                                                          | warning       |
| Standing rule entries stay within their existing UTF-8 byte budget: Skill entries 15,000 B; AGENTS.md and decision index 5,000 B | AGENTS.md, all `skills/*/SKILL.md` entries, the decision index | error |
| Active design reading units stay within 15,000 UTF-8 bytes; new nested topic files inherit the same ceiling | all Markdown under `docs/design/`, excluding `docs/design/archived/` | error |
| Translation quality, design correctness, experimental conclusions, prose style, and whether a failure class was promoted to a rule | all documents                                                                                                                                       | not automated |

Group discovery uses the union of English, Chinese and terms files, not a
migration list. Removing both prose files cannot hide a remaining terms file.
Symlinked directories are not traversed; symlinked group members do not count as
regular files. The sole disposable exception is the
[cleanable run scratch](experiments/execution/archive/ooo-arms-2026-09-19/speculation-earm/run2-2026-09-19T05-40-04-311Z/CLEANABLE-scratch-2026-09-19.md),
only while it has no companions and retains its stated cleanup condition. A new
`CLEANABLE` filename is not an exemption. Reader-facing files outside this
admitted corpus still follow the bilingual policy; this check does not establish
their coverage or validate translation meaning, YAML semantics, or confirmation
freshness. Existing link and glossary checks retain their own scope.

An error means the repository's documented public or normative interface is
broken in a mechanically reproducible way. A warning is maintenance input for an
Agent or reviewer and must not fail CI.

Design documents grow by routing whole responsibilities to named topics, not by
raising the ceiling or moving excess text into an unbudgeted design subdirectory.
Keep required conditions, exceptions and dependencies together; re-root links and
check incoming anchors after a move. Historical designs and experimental source
evidence keep their own roles and are not assigned the active-design ceiling.

The Skill byte budget covers its always-read entry, not every file under it.
When an entry approaches its ceiling, route its occasionally-needed sections into
`skills/<name>/references/` and name each trigger in the entry ([
decision](decisions/implemented/2026-09-18-skill-grows-by-routing.md)), rather
than raising the ceiling or compressing a rule until it loses the facts it
depends on.
