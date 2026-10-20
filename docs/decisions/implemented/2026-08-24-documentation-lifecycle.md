# Lightweight documentation lifecycle

[中文](2026-08-24-documentation-lifecycle.zh-CN.md) · [Terms used](2026-08-24-documentation-lifecycle.terms.yaml)

**Status:** implemented  
**Approved:** explicit
**Relates to:** [documentation-governance design](../../design/documentation-governance.md)

## Problem

NMG accumulated normative design, implementation status, temporary work,
experiments, and operating guidance faster than their ownership rules evolved.
Repeated summaries made it difficult to tell which file should be updated, while
a strict mirrored bilingual system would add maintenance cost unrelated to NMG.

## Decision

Use a lightweight ownership and lifecycle system:

- one normative design baseline plus owning topic designs;
- lifecycle-managed decision records for rationale;
- separate evidence, completion-audit, and unresolved-TODO surfaces;
- one project Skill named `doc-maintenance` as the operational workflow;
- English/Chinese/used-terminology topic groups for all non-temporary
  documentation, following the [bilingual policy](../../README.md#bilingual-policy),
  without mandatory paragraph-level equivalence or translation hashes;
- a structural verifier that fails on broken canonical entry points or malformed
  decision records, structural hygiene in active designs and Skill Markdown, and role-based
  byte budgets in the [CI contract](../../README.md#ci-contract).
  Group completeness also blocks for the root README, `docs/` and `skills/`,
  including archives and newly discovered topics, with the CI contract's sole
  explicitly disposable scratch exception. Other internal-note issues and
  bilingual drift remain warnings.

The accepted [governance design](../../design/documentation-governance.md) refines
this model around reader outcomes, complete factual statements, and local checks
with rejecting examples. It also separates terminology ownership from discovery.
The design owns those obligations; this note preserves their rationale. Reader
review applies to actual prose, while the accepted structural checks cover all
active design and Skill Markdown, including new nested topics and references.
The original three workflow documents remain required. Archived designs and raw
experimental evidence keep their separate roles rather than acquiring this gate.

Byte budgets remain a separate property: active design units and Skill entries
retain 15,000 bytes; AGENTS and the decision index retain 5,000. Skill references
do not acquire an entry-file byte ceiling merely because their headings are checked.
Original oversized text must fail before responsibility-based relocation; no
reader-benefit measurement is a prerequisite.

The [reader-oriented writing standard](../../../skills/doc-maintenance/references/reader-review.md)
owns the concrete drafting and review criteria. It is established before further
domain-by-domain remediation. Controlled technical English is an expression-layer
influence, not a declaration of ASD-STE100 compliance: the repository does not
adopt its full vocabulary or numerical language constraints. This choice improves
clarity without sacrificing domain identifiers, conditions or the argument needed
by a design. It does not create a second dictionary or a prose-quality gate.

## Alternatives considered

- Keep informal conventions only. This had too little guidance for multiple
  Agents and allowed ownership drift.
- Mirror every paragraph strictly or require translation hashes. Rejected:
  bilingual semantic coverage does not require identical paragraph structure.
  A shared terminology companion serves translation consistency, not approval
  hashing or another copy of every definition.
- Require bilingual text only at public entries or normally for decisions.
  Replaced by the user's all-non-temporary scope. Retained internal notes,
  experiments and archives are not disposable work; the broader coverage costs
  translation and term-use maintenance, which remain explicit remediation debt
  until each group has been reviewed. In the admitted corpus, existence is now
  mechanically enforced; review still decides whether those files say the right
  thing.
- Extend a per-file whitelist: rejected because new design topics and Skill entries
  would escape. Role/directory coverage costs link and owner migration, but inherits
  the gate without maintaining another list.
- Wait for measured prose or anti-growth benefit before applying a budget: rejected.
  The real red-to-green refusal verifies the admitted mechanical property; it does
  not certify style or semantic equivalence. Splitting costs more topic files and
  navigation, so whole responsibilities move and small local explanations stay.
- Keep heading checks on only three pilot files: rejected after admission of the
  same check for active designs and workflows. Role discovery avoids whitelist
  drift; the cost is repairing newly covered structural defects. Archives and raw
  evidence are not silently reclassified, and reference hygiene does not imply a
  reference byte ceiling.
- Use one size ceiling or a passing check as the definition of document health.
  Neither establishes reader understanding or factual completeness; arbitrary
  fragmentation merely moves the maintenance burden.
- Adopt ASD-STE100 wholesale or use sentence length as acceptance: rejected.
  NMG includes bilingual procedures, references and research arguments; a uniform
  language restriction does not establish that the reader has the required facts.
  Adapting expression principles costs explicit source comparison and author
  review; these checks must not be advertised as independent semantic proof.
- Limit the change to sentence polishing: rejected. Clear sentences still leave
  readers blocked when the task entry, prerequisites, ownership or failure path
  is missing. The standard therefore addresses document structure before wording.
- Carry parent chapter positions or generated slugs into topic filenames: rejected.
  They encode the old outline rather than the subject and conflict with existing
  descriptive English kebab-case naming. The reader standard owns this convention;
  repairing prior splits costs path, fragment and terminology-pointer migration.
  This is not a blanket ban on meaningful dates, versions or stable identifiers,
  and does not add a filename-style gate.
- Prefix every artifact with `nmg-`. The repository already supplies the project
  namespace, so `doc-maintenance` is clearer and sufficient.

## Consequences

Contributors must identify the owning document before adding another file.
All retained documentation follows the bilingual topic-group policy; translation
is judged by preserved facts and intent rather than identical structure. CI blocks broken public/canonical navigation and
decision contracts and admitted structural hygiene; it reports other internal
organization issues and translation drift without turning them into release blockers.
Incomplete groups in the admitted corpus fail instead of accumulating as warnings.
The cost is maintaining all three files together; no new confirmation format,
translation hash or prose-quality gate is introduced. The refinement adds a maintained
place to evaluate reader burden and check scope without requiring a documentation
platform or changing the authority of existing owners.

## Deferred

Budgets and hygiene admission for other document roles, automatic prose judgments,
and optional section-confirmation records remain outside this rollout. Their admission
requires an explicit scope, severity, exceptions, and rejecting cases at the
existing policy owner. Translation hashes are not a repository-wide
requirement, and semantic review is not replaced by confirmation records.
