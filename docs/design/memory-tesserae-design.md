# Memory tesserae: bookmarks as a searchable source

[English](memory-tesserae-design.md) | [简体中文](memory-tesserae-design.zh-CN.md) · [Terms](memory-tesserae-design.terms.yaml)

**Status:** draft
**Updated:** 2026-09-02

## Scope and evidence boundary

**Source review, 2026-10-17:** this remains a draft design with dated implementation
notes, not an end-to-end acceptance record. The inspected owners are
[`schema.ts`](../../src/core/store/schema.ts),
[`writes.ts`](../../src/core/store/writes.ts),
[`retrieval.ts`](../../src/core/store/retrieval.ts) and
[`service.ts`](../../src/cli/service.ts). No test, benchmark or external-literature
verification was run. Historical ticket numbers do not establish current open work.

This document supersedes the file-content-source design
([file-content-source-design.md](archived/file-content-source-design.md)) as the owner of
"how an Agent reaches file content through NMG". It records a first-principles
redesign reached through an extended design discussion (surveyed 2026-09-02).

> **Terminology note.** This design originally called its bookmarks "anchors"
> and shipped under that name. The implementation was renamed to *tesserae*
> (singular *tessera*; the naming discussion invoked Latin tessera hospitalis,
> a matching-token analogy rather than an NMG identity proof) because "anchor" already named an
> unrelated retrieval concept in the codebase (`surface anchors`: explicit
> quoted phrases/paths/IDs indexed for exact-match retrieval). This document
> uses the shipped name. "Anchored" as a general adjective (content-anchored,
> hash-anchored) and references to other systems' anchors keep their original
> meaning.

## 1. Problem

The Agent repeatedly "searches around" for things it already knows exist. NMG
memory in this use case stores *long-lived, low-churn* facts — "there is a budget mechanism". But
memory does not say *where* that mechanism lives in the current file tree, so
every session re-discovers file locations by hand (`grep` / `read` / `glob`).

The previous answer was a **file content index**: passively scan files, index
their full text, and search them as a second source
([file-content-source-design.md](archived/file-content-source-design.md)). Experience
with the MVP showed this direction is usable but not good: whole-file blobs,
trigram fragments with no surface anchors, and — decisively — **a whole index to
maintain** (scope file, incremental crawler, content hashes, file FTS, scope
observer). The maintenance cost outweighs the retrieval benefit for a memory
system whose files are already reachable by path.

## 2. First-principles reframing

For this use case, three layers each answer one question:

```text
memory  (long-lived, low-churn)  — "there is this thing"
tessera (bookmark, position)     — "the content of that thing is here"
file    (content host)           — the actual bytes
```

The Agent does **not** need to remember which file, at which line, holds which
content — that is high-churn, fragile knowledge. It needs to remember *that the
thing exists* (memory) and have a cheap, objective way to reach *its content*
(tessera → file). The tessera is the bridge; it is an **external buffer layer**,
not an authoritative memory fact or a maintained whole-file replica.

## 3. Decisions

### 3.1 No file full-text search

The file content source (full-text index over files, `.nmg-search-scope`,
incremental crawler, file FTS) is **dropped** as a maintained feature. NMG does not maintain a full-file text index for this source. It does index
selected tessera labels/snippets, reads files to resolve them, and may make a
bounded file scan for drift fallback; "no full-text source" does not mean no file IO. They remain reachable through
tesserae (and through the Agent's own `read`/`grep` tools, which NMG does not
replace).

Rationale: maintaining a file index is expensive and its marginal value over
tesserae + direct tool access is low. The file is the content host; NMG only
needs *pointers into it*.

The original record assigned removal to **ticket 8** and reported that the
first tesserae PR still ran `file-index.ts` on searches. That is historical
rollout context, not a current pending-ticket claim. The inspected service now
queries the tessera FTS source and performs the bounded relocation below;
this review did not audit DSH's former scope observer.

### 3.2 Tesserae are an independent, searchable source

A **tessera** (a bookmark) is a first-class row, not a field glued onto a
memory. The current schema has a separate `tesserae` table in the memory database and
`tesserae_fts` over `label` and `snippet`; `path` is `UNINDEXED`. The service
searches this source alongside memory and returns a separate `tesserae`
partition, not a single jointly ranked list.

```text
nmg search "budget"
  ├── memory source:  FTS over memory_records       (existing)
  └── tessera source: FTS over tesserae (label/snippet)  (new)
```

A tessera row carries:

| field       | meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `path`      | file the tessera points into (project-relative)                |
| `snippet`   | short excerpt; current relocation requires a single-line substring |
| `label`     | Agent-written one-liner (searchable)                           |
| `kind`      | e.g. `code`, `doc`, `note` (optional)                          |
| `memory_id` | optional back-pointer to the memory that raised it             |

Tessera queries do not join or filter on linked memory status. A matching
bookmark can therefore remain searchable without a matching active memory.
The table has no project/session discriminator: a project root supplies a
resolution context, not a database isolation or file-authorization guarantee.

### 3.3 Tesserae are content-anchored, not line-anchored

A tessera stores a **content snippet**, not a persisted line number. Current
relocation trims that snippet and returns the first line containing it as a
substring. It does not perform fuzzy or multi-line matching, and a repeated
snippet does not prove a unique location. The original design cited
[gptme hash-anchored editing](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py),
[agentic-bookmarks self-healing anchors](https://github.com/super-mega-lab/agentic-bookmarks),
and [haido drift detection](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md)
as research leads, not independently verified implementation evidence here.

**Drift tolerance.** `tesserae.file_simhash` holds the 64-bit tessera drift fingerprint as
16 lowercase hexadecimal characters. The service computes it when the target
is readable at write time; failure leaves the fingerprint absent without
blocking the memory write. Search can backfill missing values from then-current
file bytes, at most once per row. A late backfill is not proof of the original
write-time content. It is bounded and best effort: the current root-level
backfill can stop after a pass in which no missing row was stamped, including
unreadable or failed rows; eventual retry is not guaranteed.

With a project root, relocation is two-stage:

1. **Exact** — look for the snippet in the stored path. A hit returns its current
   1-based line.
2. **Fingerprint fallback** — on an exact miss, a stored fingerprint is needed.
   If the old path remains readable and its current fingerprint is within
   Hamming ≤ 6, the missing snippet is treated as stale without scanning other
   files. Otherwise the service scans up to **200 regular files**, skipping
   hidden/VCS/dependency/build directories and symlink entries. It returns the
   first candidate within Hamming ≤ 6 that also contains the snippet. This is a
   file-count bound, not a byte, time or complete-project coverage bound.

The 2026-09-02 discussion reported repo-file observations at 5–60 KB:
near-identical pairs at Hamming 1–3, unrelated pairs around 24, and a threshold
of 6 with 100% recall / 0.24% false positive. The underlying sample and rates
were not revalidated here. They are not universal separation guarantees or
measurements of short-memory/snippet fingerprints. This feature fingerprints
files, not snippets.

The fingerprint selects a **candidate file**, not a proven identity; an exact
snippet match supplies the position. Relocation may return a new relative
`path`, `line` and `relocated: true`, but does not rewrite the stored path or
snippet. Fingerprint backfill is the separate, limited row update above.

A **tessera resolution miss** sets `stale: true` within the accessible view and
bounded procedure; it does not prove that the text is absent everywhere. With
no project root, the service returns unresolved hits without this read check,
so absence of a stale flag is not freshness evidence. Neither a resolved nor a
stale bookmark establishes whether the linked memory is true or current.

### 3.4 Markers are the index pointer between memory and tessera

NMG memory already carries an open-string metadata channel — `MemoryMarker`
(`kind` open, `attributes` key/value); the original discussion used `board_origin`
and `retrieveHint` as examples. The memory↔tessera link rides the same channel:

```jsonc
markers: [{
  "kind": "tessera_ref",
  "attributes": { "tesseraId": "…" }
}]
```

The **tessera reference marker** is a pointer; the separate row holds bookmark
data. This reuses memory metadata without adding a memory-record column, not
without any schema work: the implementation creates tessera/FTS tables and has
legacy rename/fingerprint migrations. `memory_id` has no cascading foreign key,
and the independent query does not filter memory status. Marker carriage alone
therefore gives no RAII, deletion, retirement or acceptance guarantee for the
separate row.

### 3.5 Writing is active; recall is active + passive

- **Write (active):** the inspected CLI supports repeatable
  `nmg remember … --tessera PATH::SNIPPET[::LABEL]`; the core accepts optional
  `tesserae` on a memory write. The service protocol accepts at most 10 per write.
  Core planning skips missing paths/snippets and inserts planned rows in the
  memory-write transaction. The previously suggested dedicated `nmg tessera`
  action is a design option here, not an instruction to invoke a shipped command.
  No observer or automatic extraction is required to author a bookmark.
- **Recall (active + passive):** service search can return memory and tessera
  partitions; adapters decide how to present them in active or automatic recall.
  The marker identifies the bookmark, while file-position resolution needs a
  project root. This is not a promise that every raw core search or adapter
  performs that walk or displays both sources.

## 4. Architecture

This is the design relationship, not coverage proof for every residence or adapter.

```text
┌─────────────── search ─────────────────────────────────┐
│  query → memory hits (existing) + tessera hits (new)   │
└───────────────────────────┬────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
┌───────────────┐                    ┌────────────────────┐
│ memory_records│                    │ tesserae           │
│  (LTG/STG)    │  marker tessera_ref│ (path, snippet,    │
│               │ ─────────────────► │  label, memory_id) │
└───────────────┘                    └─────────┬──────────┘
                                               │ resolve snippet
                                               ▼
                                        file (content host,
                                        no maintained full-file FTS)
```

## 5. Boundaries

- Tesserae are **not memory**: no LTG/STG semantics, no provenance/verification
  on tessera content. The `memory_id` back-pointer is optional linkage, not
  memory content.
- Files are **not a maintained full-text source**: the bookmark stores a path,
  label and selected text excerpt, not a maintained whole-file replica. It is
  not content-free; authors must not mistake a stored snippet for verified
  memory or a promise that no file text is retained.
- Tesserae are **sparse and Agent-authored**: no maintained content parser or
  background crawler, no tree-sitter or mdast. Bounded fallback file IO remains. Document "concept units" remain out of scope (no
  deterministic parser; see the superseded design's structured-unit note).

## 6. Relation to the superseded design

[file-content-source-design.md](archived/file-content-source-design.md) proposed a
full-text file index as a second search source. This design keeps its
conclusions that are still true — files are not memory; scope discipline
matters; separated presentation is sane — but **drops the file index itself** in
favor of sparse, Agent-authored tesserae. The maintenance-heavy machinery
(`.nmg-search-scope`, incremental crawler, full-file FTS, scope observer) is not
part of the target design. Ticket 8 originally named the leftovers from PR #18
(`file-index.ts`, the per-search crawl and DSH scope observer); that schedule
is historical, and no current DSH cleanup is certified here. The file-level
fingerprint retained for relocation is a single 64-bit SimHash (§3.3), not a
maintained full-file content index.

## 7. Open questions (deferred)

Some original questions now have source-visible answers: SQLite holds the
separate table; current relocation is single-line exact matching plus bounded
fingerprint fallback; service results use a separate partition. Those choices
do not settle all design obligations. Still deferred here:

- TTL/retirement and linked-memory deletion or supersession policy.
- Explicit project identity, path authorization and cross-project visibility.
- Ambiguous snippets, multi-line/fuzzy relocation, scan completeness and
  fingerprint-backfill retry policy.
- Adapter-specific passive presentation and end-to-end coverage.

## 8. Research basis (surveyed 2026-09-02)

The complete [recorded research comparisons](memory-tesserae-design/research-basis.md)
retain the five original leads. They are historical design rationale, not
external sources revalidated by this review.
