# Repository terminology index

[中文](2026-09-08-repository-terminology-index.zh-CN.md) · [Terms used](2026-09-08-repository-terminology-index.terms.yaml)

**Status:** implemented  
**Approved:** explicit
**Relates to:** [distributed terminology design](../../design/documentation-governance.md)

## Problem

An Agent that searches this repository, finds nothing, and concludes the
capability does not exist will build it again. That failure — **miss, then
"absent", then add** — is the duplicate-creation failure the repository's own
meta-rule forbids: one home per rule. Three findings show it is live.

**The two terminology tables that already exist are not wired to retrieval.**
The repository owns a concept map (`docs/guides/concept-map.md`, bilingual) that
gives each product concept one operational meaning and links to its contract
owner, and `agent-context.yaml` carries machine-readable
`capabilities[].aliases` (for example `memory-runtime` → `memory-daemon,
durable-memory`), with duplicate aliases rejected by `tools/repo-context.ts`.
But the concept map is read by humans only, and the aliases are consumed on
exactly one path — an explicit `agent:context --capabilities <name>` lookup —
not by search. There is no "describe the concept, find its home" path.

**The concept map does not cover the vocabulary where collisions happen.** It
lists product concepts (HistoryRecord, STG, LTG, AG, QPP). It does not list the
repository's process vocabulary: contract, assertion, check, stage, kind,
evidence, context, route, receipt, narrow, gate. Every collision observed on
2026-09-08 is in that set: three places declare "what to run"
(`agent-context.yaml` route `verify.blocking`, `NARROW_SHARED_CHECKS`, and
`contract.verification.checks`); `invariants` is written into the `WorkOrder`
and read by nothing; `assertions` was introduced while `invariants` still
existed. The repository has paid for this once already: the bookmark feature was
renamed from "anchors" to "tesserae" after one word was found to carry four
meanings, two of them in the same file
(`rejected/2026-09-02-keep-bookmarks-named-anchors`).

**Nothing enforces search-first.** `docs/decisions/README.md` says "before
creating a note, search for the existing owner" — a repeated reminder, not a
mechanical check. The repository's meta-rule prefers the mechanical check.

## Decision

Keep one machine-readable lookup and validation path over topic-owned
definitions, not a third hand-maintained full-corpus table. One owner per concept
does not require one physical file. The [governance design](../../design/documentation-governance.md#yaml-files-and-query-contract)
owns identity, discovery scope and query behavior. Creation-time duplicate
detection remains a separate deferred obligation.

1. Colocated v2 `*.terms.yaml` files own definition text and canonical English terms.
   All fourteen legacy process entries migrate with their names, aliases, status
   and contract targets intact; the manual `docs/glossary.yaml` index is retired.
   Aggregation reads definitions directly, without a second maintained catalog.
2. A v2 entry uses its canonical term as the key, qualified only for homonyms, and its behavior
   contract separately by `owner` and `anchor`. The short word meaning does not
   rewrite that contract or duplicate its full conditions and exceptions.
3. The command-line resolver consumes canonical names and precise aliases; existing v2 IDs remain readable for compatibility.
   This is repository-term lookup, not an integration with NMG memory retrieval.
4. `glossary:check` fails closed on malformed registered metadata, conflicting
   identity, unresolved contract locations and declared successors. It remains
   blocking on narrow and full verification paths. Trusted-policy digest pinning
   is a separate deferred obligation, not established by this working-tree check.
5. A directory-bounded lookup reports its observed corpus. Cross-namespace
   matches remain candidates; it does not pick a convenient owner or infer global
   absence from a local miss.
6. Coverage is explicit: registered definitions, including the migrated process
   vocabulary. Product-map generation and creation-time duplicate detection remain
   deferred; metadata consistency cannot prove that an unregistered concept is absent.
7. The parser still accepts a present v1 index, including its original three-column
   CLI output. A missing legacy file is valid when distributed sources exist;
   an empty corpus or a malformed present source fails. Migrated v2 entries retain
   the three-column first line and add namespace, status, definition and source lines. An existing optional ID retains its ID line; new entries do not need one.
   Their namespace is the topic namespace, not the v1 `repository` namespace;
   consumers must not parse all stdout as one TSV record.
8. The user's English/Chinese/used-terms group uses one shared YAML companion.
   Optional `references` lists canonical English terms without copying definitions. Only ambiguous words need a `{term, namespace}` reference. Explicit
   reference-only or no-specialized-terms companions may have empty `terms`;
   malformed, repeated or unresolved references fail in the selected corpus.
   This does not load outside a bounded query or register a second definition.
   Empty overall vocabularies still fail. Older validators reject the new shape;
   existing v1 and ID-bearing v2 files remain readable, without generating IDs for new words. A namespace is optional unless needed to distinguish meanings.

The initial 2026-09-08 implementation used the v1 pointer index. The distributed
rollout retains its lookup vocabulary while adding word meanings at their topic
owners. The existing validator discovers the sources, reports actual scope and
refuses invalid catalogs before lookup. YAML reuses the existing parser; neither
a Markdown definition copy nor a terminology platform is required.

The check remains blocking in `verify:static`, narrow shared checks, the
`documentation` route and both authored contracts. These execution bindings do
not establish trusted-baseline pinning or creation-time protection.

## Alternatives considered

- **Write a new glossary document.** Rejected: the repository already has two
  tables; a third is the duplication this decision exists to prevent. Extend the
  existing ones.
- **Rely on the `docs/decisions/README.md` "search first" reminder.** Rejected:
  a reminder is exactly what the meta-rule replaces with a mechanical check, and
  a search can miss for vocabulary reasons while the concept exists.
- **Scan all documents for unregistered terms.** Rejected as unreliable: natural
  language has no mechanical term boundary, so full-coverage scanning would
  produce noise and become a Goodhart target. The guard fires at creation time
  instead.
- **Keep the index in NMG memory rather than the repository.** Rejected as the
  primary home: memory is historical and session-scoped, while the repository's
  vocabulary must be reviewable in a pull request and available offline. Memory
  can still carry aliases as recall triggers.
- **Maintain Markdown definitions and YAML metadata as separate artifacts.**
  Not chosen for this pilot: the user selected YAML word entries, which keep
  definition text and identity together using the existing parser. This does not
  require mirrored definition copies. The user's later three-artifact grouping
  requires a shared term-use companion, which may explicitly state no specialized
  terms; it does not manufacture a definition merely to fill the group.
- **Copy definitions into each document's term file.** Rejected for the shared
  bilingual group: canonical-word references retain one lexical owner. The cost is
  validating those references and widening a local corpus when its owner is
  outside the selection, not weakening the bounded-reading contract.
- **Assign every word a separate stable ID.** Rejected after the user's explicit
  simplification: a canonical English word already supplies the key; namespace
  qualification handles actual homonyms. Extra IDs would add an unnecessary
  author-maintained mapping. The accepted cost is migrating references and
  same-namespace successor names when the canonical word changes; aliases preserve
  discovery, not stale reference validity. Old IDs are read compatibility only.
- **Keep the manual v1 index after migration.** Rejected: it would require every
  owner or alias change to update two catalogs. Retiring it costs source/namespace
  migration and additive CLI output; alias-to-owner checks and v1 compatibility
  fixtures cover the declared boundary. Missing sources still fail closed.
- **Adopt a formal ontology or SKOS.** Rejected as too heavy for one
  maintainer; the needed properties are a canonical name, aliases, one owner,
  and a status.

## Verification

Verified as of 2026-09-08:

- One machine-readable term table exists and every entry resolves to an existing
  owner file and heading.
- `glossary:check` fails closed on unresolvable owners, duplicate canonical
  terms, an alias claimed twice or equal to another term, and deprecated terms
  without a successor.
- `glossary:check` is blocking on the narrow and full paths.
- Retrieval resolves a term or alias to its owner (`glossary:check --resolve`).

## Deferred

- Extending registered [YAML definitions](../../design/documentation-governance.md#yaml-files-and-query-contract)
  beyond active topic designs and extracting references from prose remain deferred.
  Aggregation is a query result, not another hand-maintained vocabulary.
- Product concepts remain in the [concept map](../../guides/concept-map.md);
  their definitions are not all registered in this resolver.
- The concept map is not generated from registered definitions, so they can drift.
- The rule digest is not pinned in `.rcp/trusted-policy.json`. `trusted-verify`
  reads the policy from the installed baseline, so an obligation written only
  into the working tree would be a claim with no effect until the next
  `trust-install`.
- Creation-time duplicate detection for a new concept, contract or decision is
  not implemented. Only conflicts inside the registered metadata corpus are rejected.

## Consequences

- The table is maintenance cost and can rot; the validator, not discipline, is
  what keeps it alive.
- The index cannot prove nothing is missing; it can only prove that every
  registered term has one home. "Not found" must never be read as "does not
  exist". The `## Deferred` items are part of that boundary: product terms and
  newly created concepts are not yet covered by the guard.
- Aliases improve discovery but do not guarantee a hit. A future creation-time
  guard must account for concepts outside the registered vocabulary; the current
  metadata validator is not that guard.
- Registering every noun would make the index noise; entries should be concepts
  with an owner and a contract, not general vocabulary.
- A blocking terminology check can be gamed by renaming rather than resolving
  the collision; the status field must record the successor.
