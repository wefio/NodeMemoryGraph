# Reader-oriented writing and review

[中文](reader-review.zh-CN.md) · [Terms used](reader-review.terms.yaml)

This file owns NMG's reader-oriented writing criteria and review procedure.
Use it before drafting, reorganizing, condensing or publishing reader-facing
text. The [governance design](../../../docs/design/documentation-governance.md)
assigns document ownership and separates semantic review from mechanical checks.

## Reader task

Identify the intended reader, the question or action, the trigger for reading,
and the knowledge the text assumes. Put the answer or usable entry point before
optional background. A reader must not need the author's prior conversation to
understand what to do or what a claim means.

Choose a structure that fits the material; do not force every document into a
procedure or add empty headings to satisfy a template:

| Material | Organize around | What the reader must be able to determine |
| --- | --- | --- |
| Tutorial | A concrete outcome and its necessary prerequisites | How to reach and confirm that outcome |
| Operation or recovery procedure | Trigger, prerequisites, action, result and failure handling | Whether to act, what to do and when to stop or recover |
| API or behavior reference | A lookup question and the applicable contract | Inputs, outputs, conditions, exceptions and ownership |
| Architecture or decision | The problem, boundaries, mechanism and consequential tradeoffs | Why the choice applies and where it does not |
| Experiment or incident record | The question, context, evidence and limits | What was observed, why it matters and what remains unknown |

For an action, place permissions, environment requirements and applicable safety
warnings before the step that needs them. State observable success and the
relevant failure, stop or recovery path. Do not invent a recovery action when
none is supported; identify the unresolved case instead.

## Local reading and content ownership

Follow the owning directory's established naming style, even when no rule
explicitly prohibits an alternative. Design topic files and directories use
descriptive English kebab-case names and established bilingual suffixes. Do not
carry a parent document's chapter positions, generated truncation hashes or
`— topic` labels into independent topic names. Meaningful versions, dates,
ordered steps and stable domain identifiers retain their distinct purposes.
When renaming, migrate incoming links and terminology owner/anchor bindings;
check relative links from moved files as well as links to them.

Give sections searchable subject names. A link must say whether it supplies a
required definition or prerequisite, an alternative path, or optional background.
Do not imply that every linked document must be read in full.

A document explains its own subject; introduce direct children by purpose and
link to their owners for detail. Do not mirror directory or symbol inventories
already recoverable from source. Add local orientation where names or structure
leave a concrete ambiguity. Indexes and generated summaries provide navigation,
not a competing specification. Use repository-relative source paths and sections
for current knowledge and a shared revision for historical evidence; private
memory IDs are not required reading.

Keep the conditions needed for one action or claim together. Link exact types,
full catalogs and deeper explanations to their owners, but retain enough local
explanation for safe use. If a section is too large, narrow its responsibility
and route the remaining whole responsibility; do not split coupled conditions
across pages merely to meet a size ceiling.

Use the [ownership workflow](../SKILL.md#workflow) to relocate content. Design,
decision rationale, measured evidence, incident causes, implementation status and
unresolved work keep their distinct owners. Do not append successive work logs
to the contract. Git preserves edit history, but removing a work log must not
remove the only necessary explanation of a rejected alternative or a failure.

## Facts before compression

Compare the old and new statements, not just their lengths. Preserve:

- the actor, action, object and authoritative owner;
- scope, prerequisites, conditions, order, timing and quantifiers;
- obligations, permissions, prohibitions, exceptions and failure effects;
- success criteria, stop conditions and supported recovery;
- assumptions, uncertainty and the boundary of each piece of evidence.

Do not turn "may" into "must", "some" into "all", an observation into a
promise, or a conditional guarantee into an unconditional one. Keep negation
and the condition it governs unambiguous. Repeat a condition when necessary to
avoid changing which actions it qualifies. Add missing explanations rather than
compressing away a requirement.

Remove duplicate explanations, decorative claims, self-justification and the
transcript of arriving at a conclusion. Preserve the conclusion and the rationale
or evidence that a later reader needs. Historical evidence does not become a
current execution result because it appears beside a current instruction.

## Controlled-language-inspired expression

Borrow the clarity goals of controlled technical English without declaring
ASD-STE100 compliance. These are NMG conventions, not a claim that particular
STE rules or its full specification have been adopted.

- Name the actor when ownership or responsibility matters. Prefer a direct verb
  over a vague nominal phrase. Passive voice is acceptable when the actor is
  irrelevant or already clear; do not distort the subject to ban it mechanically.
- Give a sentence one main purpose and a procedural step one main action. Keep
  tightly coupled conditions or an indivisible operation together; splitting
  them must not imply that partial execution is valid.
- Put a condition before the instruction it limits, or immediately beside it.
  Separate alternatives and state how to choose them. A short sentence with an
  unclear "if", "unless", "only" or pronoun is not an improvement.
- Use concrete objects and observable results instead of "handle appropriately",
  "the system optimizes it" or "works seamlessly". Resolve an ambiguous "it",
  "this" or "they" by naming the relevant object.
- Reuse an established term for the same concept. Distinguish different senses
  instead of inventing synonyms for variety. Use the existing
  [terminology discovery path](../../../docs/design/documentation-governance.md#yaml-files-and-query-contract)
  rather than a second dictionary; explain unfamiliar terms locally when needed.
- Preserve correct literal API names, commands, flags, paths, values and error text.
  Explain their meaning without silently translating or simplifying identifiers.
  If an example conflicts with its owning contract, correct and verify it rather
  than preserving incorrect bytes. Make placeholders and substitutions clear.
- Apply these principles to both English and Chinese. Do not impose an English
  approved-word dictionary, word-count target or sentence-length gate on either
  language. Readability does not override a precise contract or necessary argument.

## Examples of review

These examples illustrate the criteria, not new product contracts. Verify the
owning source before using an example as an instruction.

**Inflated guarantee**

Before: "The gate seamlessly guarantees document quality."

After: "`docs:check` rejects duplicate sibling headings in its admitted corpus.
It does not judge whether the prose is accurate."

The revised wording names the check and limits the claim to its observed
property; the [CI contract](../../../docs/README.md#ci-contract) owns its scope.

**Missing scope and recovery**

Before: "If the term is not found, create a definition."

After: "If a directory-bounded lookup has no match, expand the lookup scope and
search again. That local miss does not prove the concept is absent from the
repository."

The revised instruction retains the lookup's scope and supplies a next action,
without claiming that creation-time duplicate detection exists. The
[lookup contract](../../../docs/design/documentation-governance.md#yaml-files-and-query-contract)
owns the behavior.

## Review and acceptance

For each reading unit being changed:

1. Choose a representative reader question or action. Follow its entry point
   using the stated prerequisites, without relying on private conversation or
   assuming every link must be read.
2. Follow the applicable branch through to its answer or observable result. For
   procedures, check the relevant failure and recovery branch too. For references
   and arguments, check the scope and limits of the answer instead of inventing
   procedural success criteria.
3. Compare the source contract and old text with the revision using the facts
   checklist above. Verify commands or examples when the change affects their
   operational meaning. Mark unverified environments and unresolved facts.
4. Follow affected references in both directions after relocation. Confirm that
   the linked section contains the needed constraints, not just that a file exists.
5. Review paired texts for the same facts, obligations, warnings and commands,
   not equal paragraph counts. Retain lifecycle metadata and its scope.
6. Run the applicable checks from the [CI contract](../../../docs/README.md#ci-contract).
   Report executed checks separately from author review and independent review.

The unit is ready when its intended reader can find and understand the answer
or act with the necessary conditions, the preservation comparison has no
unresolved material omission or contradiction, and applicable checks pass.
A missing prerequisite, ambiguous branch, changed obligation or unsupported
claim requires correction or explicit resolution at its owner, not a green
style score. Record residual uncertainty without implying it is settled.

State which units were rewritten or reviewed and which remain. A passing
structural check, one worked example or a sample review does not establish
whole-repository prose quality. No new per-section hash, approval database or
mechanical prose-quality gate is required by this procedure.
