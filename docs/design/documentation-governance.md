# Documentation governance

[中文](documentation-governance.zh-CN.md) · [Terms used](documentation-governance.terms.yaml)

**Status:** current
**Created:** 2026-10-14
**Authority:** [Documentation ownership and CI](../README.md), [lifecycle decision](../decisions/implemented/2026-08-24-documentation-lifecycle.md)
**Related:** [Terminology-index decision](../decisions/implemented/2026-09-08-repository-terminology-index.md)

## Scope and use

Use this design for independently usable prose, definition lookup and check
interpretation. Short files or green checks do not establish reader success.

- **Write or split prose:** identify the reader's action and retain its conditions,
  exceptions and failure paths. Apply [reader review](../../skills/doc-maintenance/references/reader-review.md),
  not a length target.
- **Find or register a term:** choose a corpus under
  [distributed terminology](#distributed-terminology-definitions-and-discovery).
  Word meanings and full behavior contracts have separate owners.
- **Interpret checks/failures:** [hygiene and budgets](#document-hygiene-and-budgets)
  explains mechanical limits; [the CI contract](../README.md#ci-contract) owns
  exact scope and severity.

The [docs index](../README.md#ownership-and-authority) owns authority;
[doc-maintenance](../../skills/doc-maintenance/SKILL.md) owns editing/commits.
Structural hygiene covers active design and Skill Markdown; role budgets apply
independently. Nearby YAML owns process definitions and queries aggregate them,
without another manual full-corpus table. Prose-reference extraction and section
hashes are not enabled. Grouping follows [bilingual policy](../README.md#bilingual-policy).

## Readers and content ownership

[Reader-oriented writing and review](../../skills/doc-maintenance/references/reader-review.md)
owns structure, expression, fact preservation and human acceptance. Apply it
before drafting, reorganizing, condensing or publishing, not only as final polish.
Procedures, references and arguments use structures suited to their reader tasks,
not one mandatory template.

The standard borrows controlled technical English's clarity goals without
claiming ASD-STE100 compliance, adopting another dictionary, or imposing English
word/sentence-length gates. Clear expression cannot replace a usable entry point,
ownership, conditions, exceptions, obligations or uncertainty. Maintain the
review steps and examples only in that standard.

[Existing ownership](../README.md#ownership-and-authority) separates design,
rationale, measurements, incidents, implementation status and unresolved work.
Reviewing one reading unit does not complete other topics or make mechanical
checks judges of prose or semantic equivalence.

## Distinct consistency obligations

Type excerpts, executable examples, commands and generated indexes need different
consistency checks. Derive generated material from its owner and check freshness,
not another maintained inventory. Operational claims need execution evidence;
name untested environments and paths.

Bilingual or other manually maintained equivalents need review for the same
facts. Structure, targets, code blocks and generated regions can be compared
mechanically; meaning, naturalness and accuracy require judgment. A confirmation
record identifies confirmed contents, not reliable confirmation.

Section hashes are an evaluable record format, not a repository-wide requirement.
Record each side's last confirmed content and trigger review on changes; equality
of two hashes does not establish equivalence. Exclude code/generated regions only
when independent checks still own their consistency. Re-recording wrong prose
can pass, so recording cannot replace normal checks/review. Git merging different
sections does not prove semantic independence; review the affected whole afterward.

Prefer ordinary tools. Section records can reduce unrelated record conflicts,
but heading changes, restructuring, same-section edits and upkeep still cost
work. Add them only with evidence of benefit.

## Distributed terminology definitions and discovery

### Definitions and uses

Keep one authoritative word definition near its topic; designs/interfaces still
own complete behavior. Term material explains names, aliases, meaning, scope and
easily confused concepts, pointing to that behavior owner.

The canonical English word itself is the key. Chinese translations and precise
aliases share its definition; only homonyms need namespace qualification, not
another concept ID. Retain meaning and location. Cross-domain homonyms need not
be one concept, and related terms are not automatically aliases. Deprecation and
succession stay traceable; renaming cannot hide a collision.

Separate using a term from defining it. A topic companion defines only concepts
it owns and references shared definitions. Prefer deriving use lists from prose
rather than maintaining prose, lists and a full table by hand. First use still
needs local explanation. Follow bilingual grouping even for no-specialized-term
files: explicitly record that condition, without inventing definitions to fill a
group. Related terms need not have one file each.

### Discover only the needed layers

Shared file markers/required fields enable direct local name/alias queries,
without a central registry, service or mandatory index traversal. Domain entries
introduce their domain/direct children; top-level entries classify and navigate.
Derive detailed/global views from definitions, not copies.

Widen relevant domains on a miss, aggregating within an explicit corpus if needed.
Report that corpus and scoped ambiguity candidates, not an arbitrary owner.
A local miss is not repository-wide absence.

Coverage includes explicitly registered terms, not automatic recognition of every
noun. Local checks prove local properties. Whole-corpus uniqueness, reference
validity or registered-definition coverage needs cross-domain aggregation, not
central maintenance.

### YAML files and query contract

Discover regular `docs/design/**/*.terms.yaml` without a central list, excluding
`archived/` and symlinks. This tool
scope does not exempt other document roles from grouping. [CI/RCP](ci-cd-and-quality.md)
introduces process vocabulary; [this companion](documentation-governance.terms.yaml)
defines governance words.

Lookups validate all selected references, including dependencies of local words.
The first command fails: this corpus omits memory-graph definitions. Widen with
the second; do not delete valid references to force a pass.

```sh
# Expected scope failure; widen with the next command.
npm run glossary:check -- --resolve 收据 --within docs/design/ci-cd-and-quality
npm run glossary:check -- --resolve receipt
# Namespace disambiguates homonyms; it filters results, not file reads.
npm run glossary:check -- --resolve context --namespace repository.verification
```

The first success line remains name/owner/heading TSV. v2 then prints namespace,
status, definition and source; do not parse all stdout as one TSV row. Ambiguity
returns candidates, not an arbitrary owner. Repair erroneous sources before
lookup; a broken corpus cannot yield a lucky match.

v2 has `version: 2`, `terms`, optional `namespace` and `references`. Without a
namespace, definitions belong to `repository`. Namespaces use dot-separated
lowercase letters/digits/hyphens, each segment starting with a letter. A definition has `term`, `aliases`,
`definition`, `owner`, `anchor`, `status`; no `id` is required.

`term` is canonical English; `aliases` includes Chinese translations and precise
alternatives. `definition` owns word meaning. `owner` is the repository-relative
full behavior contract; `anchor` is its exact ATX heading, excluding code-block
headings. `status`: `canonical`, `proposed` or `deprecated`; deprecated entries require a
`successor` word in the same namespace (or legacy ID). Neither registration nor
proposed status enables a capability.

`references` uses canonical words without copying definitions or incrementing the
definition count. Qualify a reference when meanings conflict:

```yaml
version: 2
terms: []
references:
  - receipt
  - term: assertion context
    namespace: repository.verification
```

Use-only files may have empty `terms`; no-specialized-term files also explicitly
write `references: []`. An overall selected corpus with neither definitions nor
references fails. Unknown fields, bad types, empty terms, duplicate uses and
unresolved/ambiguous references fail. Widen unresolved local lookups, never read
outside their boundary silently. References use canonical words; aliases remain
discovery inputs.

Within a namespace, names/aliases cannot collide. Cross-namespace homonyms return
candidates. A canonical rename migrates use lists and successors; retain old names
as discovery aliases if needed. Accept that migration cost rather than maintain
another numbering scheme to avoid renaming work.

The parser still reads present v1 `docs/glossary.yaml`, old v2 optional `id`, and
its queries/successors; it generates no new word IDs. ID-bearing v2 queries retain
an ID line. Old IDs must match their namespace, remain unique and not be shadowed
by another name/alias. v1 belongs to `repository` and retains three-column output.
Malformed old sources invalidate aggregation. Distributed sources permit an absent
old table, not an absent corpus. Older tools need not accept omitted IDs/new uses.

`npm run glossary:check` aggregates this corpus. `--resolve <name-or-alias>`
queries, `--within <repository-relative-directory>` bounds actual reads and
`--namespace <namespace>` disambiguates. Misses report the observed corpus, not
global absence. Empty corpora, invalid directories and unknown options fail.
Unresolved local successors are undecided within that scope. Prose uses are not
automatically extracted; normal file links remain documentation-check concerns.

### Existing-index migration boundary

Preserve names/aliases and lifecycle, rebinding relocated contract targets.
[The terminology decision](../decisions/implemented/2026-09-08-repository-terminology-index.md)
owns compatibility and costs. Relocation changes neither behavior nor the gaps
in product coverage/creation-time detection. Aggregation is not another manual dictionary.

## Document hygiene and budgets

The CI contract admits active-design/Skill Markdown hygiene and preserves the
three required workflow files: nonempty headings, visible content in each section
subtree and no equal-level sibling duplicates after case/whitespace normalization.
Fences/comments are not heading sources; code still counts as content. Equal
headings under different parents are valid. Removing a required document cannot
silently skip it. This is ATX-only, not Setext/HTML parsing or placeholder-quality
judgment.

Human hygiene also finds dead links, duplicate explanations, mixed responsibilities,
stale status/discussions/generated text. Lift settled conclusions to their owner
and discard unnecessary process traces without losing historical evidence,
incident causes or coverage gaps.

Budgets are guardrails, not prose scores or deletion goals. Active design reading
units, including new subtopics, retain 15,000 UTF-8 bytes; archived designs and raw
experiment evidence retain their roles. Skill entries retain 15,000 B; AGENTS
and decision indexes retain 5,000 B. Other references have no uniform byte budget.
Exact scope/severity belongs only to the CI owner, not another path whitelist.

First demonstrate rejection of the oversized original, then split whole existing
responsibilities. Keep short explanations at their owner and migrate coupled
conditions, exceptions and evidence together. Route old entries and update links
and term bindings. Historical run readings become experiment evidence, not current
passes. Table whitespace cleanup is not responsibility splitting; moving normative
prose into exempt directories is not a fix. Reading-efficiency evidence is not a
prerequisite for applying the admitted budget.

## Check admission and rejection cases

Before implementation, the CI owner declares corpus, failure nature, severity,
exemptions and exit conditions. Qualitative review is not a general semantic
checker. Admitted roles include new files automatically; admitting another role
requires the CI contract/tests, not mere directory existence.

| Obligation | Rejected or explicitly reported | Scope |
| --- | --- | --- |
| Structural hygiene | Empty headings/sections, duplicate siblings, missing required files | Active design and Skill Markdown; blocking `docs:check`. |
| Role budget | Oversized originals/new topics/design subdirectories/Chinese UTF-8 | Active design and frequently read rule entries; blocking `docs:check`. |
| One term definition | Same-scope name/alias conflicts, ambiguous uses, bad schema; old-ID conflicts | Registered corpus; blocking `glossary:check`. |
| Discovery/contract targets | Invalid directories, empty corpus, bad owner/heading, ambiguity, misses | Registered or explicit local corpus; no automatic prose-use extraction. |
| Derived-document freshness | Source changes without derived updates | No new gate; existing generated checks do not cover all docs. |
| Pair confirmation/merge | Missing material, post-confirmation edits, overwritten conflicts | Section records disabled; another repository's results are not NMG evidence. |
| Complete facts | Dropped failure/timing/limits to meet length | Reader review, not automatic semantic proof. |

## Unsettled contracts

- Unregistered domains and prose-use extraction; process migration is not full
  product-concept coverage.
- Budgets/hygiene admission for other roles; admitted-role coverage is not pending.
- Which pairs merit section records, with benefit, cost and exit conditions.
- Connecting product maps and registered definitions. Change existing owners/tests,
  not a terminology platform or replacement version-control system.

## References

Background, not NMG acceptance evidence or mandatory adoption of another corpus:

- [DSH writing/ownership](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/AGENTS.md)
  and [pair confirmation](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/i18n/README.md),
  pinned to the local version examined for this research.
- [DSH section-record historical decision](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.md):
  format/retirement rationale, not NMG benefit measurements.
- [Anthropic: Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control):
  choose representations/operations for actual workload and preserve constraints
  Agents cannot violate to satisfy a pattern. Its scale does not justify NMG
  rebuilding source control.
