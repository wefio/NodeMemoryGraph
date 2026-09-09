# Repository terminology index

[中文](2026-09-08-repository-terminology-index.zh-CN.md)

**Status:** implemented

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

One machine-readable **terminology index**, one validator, and one
creation-time guard. No third hand-maintained table.

1. A single term table (`docs/glossary.yaml`, or the `agent-context.yaml`
   capability list extended to terms) maps `term → canonical → aliases (en/zh) →
   owner (doc#anchor) → status`. The concept map is rendered from it, or is the
   same file, so the two cannot drift.
2. The table **points, it does not define**. Each entry resolves to the document
   that owns the full contract, making the concept map's existing rule — "when
   this map and an owner disagree, the owner wins" — mechanical.
3. The index is consumed by retrieval, not only by humans: aliases feed the
   search path, so `轻量验证`, `narrow`, and `lightweight verification` resolve to
   the same owner. Extending `capabilities[].aliases` from explicit selection to
   query resolution is the smallest version of this.
4. The validator fails closed on: a term whose `owner` does not resolve to an
   existing file and heading; two entries claiming the same canonical term; a
   `deprecated` term without a `successor`. It runs as a blocking check
   (`glossary:check`) on the narrow and full paths, and its rule digest is pinned
   in `.rcp/trusted-policy.json`, the same shape as `testOutputPassed` and
   `rtm:check`.
5. The creation-time guard catches what the validator cannot: **duplicate
   detection, not search logging**. Adding a concept, contract, or decision whose
   name or aliases already resolve to an owner fails, unless the record declares
   which existing home it refines or supersedes. Recording "I searched" is
   gameable; detecting "this already has a home" is not.
6. The index covers the process vocabulary as well as the product vocabulary, so
   `assertion`, `check`, `stage`, `kind`, `evidence`, `context`, `route`,
   `receipt`, `narrow` and `gate` each have one owner before the traceability
   matrix starts using them.

Implemented 2026-09-08: `docs/glossary.yaml` holds the process vocabulary and
`npm run glossary:check` validates owner resolution, duplicate terms and
aliases, and deprecated successors, with negative controls in
`tests/tools/glossary-check.test.ts`. The check is blocking in `verify:static`,
in the narrow shared checks, in the `documentation` route's blocking set, and in
both authored contracts. `npm run glossary:check -- --resolve <name>` maps a term
or alias to its owner, which is the retrieval path.

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

- The table covers the process vocabulary. The product concepts stay in the
  concept map, which the table references, so they are not indexed in the same
  table yet.
- The concept map is not generated from the table, so the two can still drift.
- The rule digest is not pinned in `.rcp/trusted-policy.json`. `trusted-verify`
  reads the policy from the installed baseline, so an obligation written only
  into the working tree would be a claim with no effect until the next
  `trust-install`.
- Creation-time duplicate detection for a new concept, contract or decision is
  not implemented. Only duplicates inside the table are rejected today.

## Consequences

- The table is maintenance cost and can rot; the validator, not discipline, is
  what keeps it alive.
- The index cannot prove nothing is missing; it can only prove that every
  registered term has one home. "Not found" must never be read as "does not
  exist". The `## Deferred` items are part of that boundary: product terms and
  newly created concepts are not yet covered by the guard.
- Aliases raise retrieval recall but do not guarantee a hit; a miss is still
  possible, which is why the guard is creation-time duplicate detection.
- Registering every noun would make the index noise; entries should be concepts
  with an owner and a contract, not general vocabulary.
- A blocking terminology check can be gamed by renaming rather than resolving
  the collision; the status field must record the successor.
