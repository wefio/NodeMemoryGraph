# Memory tesserae: bookmarks as a searchable source

**Status:** proposed
**Updated:** 2026-09-02

This document supersedes the file-content-source design
([file-content-source-design.md](file-content-source-design.md)) as the owner of
"how an Agent reaches file content through NMG". It records a first-principles
redesign reached through an extended design discussion (surveyed 2026-09-02).

> **Terminology note.** This design originally called its bookmarks "anchors"
> and shipped under that name. The implementation was renamed to *tesserae*
> (singular *tessera*; from the Latin tessera hospitalis — a token broken in two
> so that matching the halves proves identity) because "anchor" already named an
> unrelated retrieval concept in the codebase (`surface anchors`: explicit
> quoted phrases/paths/IDs indexed for exact-match retrieval). This document
> uses the shipped name. "Anchored" as a general adjective (content-anchored,
> hash-anchored) and references to other systems' anchors keep their original
> meaning.

## 1. Problem

The Agent repeatedly "searches around" for things it already knows exist. NMG
memory stores *long-lived, low-churn* facts — "there is a budget mechanism". But
memory does not say *where* that mechanism lives in the current file tree, so
every session re-discovers file locations by hand (`grep` / `read` / `glob`).

The previous answer was a **file content index**: passively scan files, index
their full text, and search them as a second source
([file-content-source-design.md](file-content-source-design.md)). Experience
with the MVP showed this direction is usable but not good: whole-file blobs,
trigram fragments with no surface anchors, and — decisively — **a whole index to
maintain** (scope file, incremental crawler, content hashes, file FTS, scope
observer). The maintenance cost outweighs the retrieval benefit for a memory
system whose files are already reachable by path.

## 2. First-principles reframing

Three layers, each answering one question:

```text
memory  (long-lived, low-churn)  — "there is this thing"
tessera (bookmark, position)     — "the content of that thing is here"
file    (content host)           — the actual bytes
```

The Agent does **not** need to remember which file, at which line, holds which
content — that is high-churn, fragile knowledge. It needs to remember *that the
thing exists* (memory) and have a cheap, objective way to reach *its content*
(tessera → file). The tessera is the bridge; it is an **external buffer layer**,
not memory content and not a file-content replica.

## 3. Decisions

### 3.1 No file full-text search

The file content source (full-text index over files, `.nmg-search-scope`,
incremental crawler, file FTS) is **dropped** as a maintained feature. Files are
not indexed, not crawled, not searched by NMG. They remain reachable through
tesserae (and through the Agent's own `read`/`grep` tools, which NMG does not
replace).

Rationale: maintaining a file index is expensive and its marginal value over
tesserae + direct tool access is low. The file is the content host; NMG only
needs *pointers into it*.

The design declared the drop; the **code removal is ticket 8** (the original
tesserae PR shipped with `file-index.ts` still live — every search still
crawled it). Removing the full-text machinery is prerequisite to the drift
tolerance below: tesserae need a file fingerprint, not a file index.

### 3.2 Tesserae are an independent, searchable source

A **tessera** (a bookmark) is a first-class row, not a field glued onto a
memory. Tesserae live in their own store and are **searched alongside memory** —
a single query returns memory hits *and* tessera hits.

```text
nmg search "budget"
  ├── memory source:  FTS over memory_records       (existing)
  └── tessera source: FTS over tesserae (label/snippet)  (new)
```

A tessera row carries:

| field       | meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `path`      | file the tessera points into (project-relative)                |
| `snippet`   | short content excerpt used for *relocation*, not line          |
| `label`     | Agent-written one-liner (searchable)                           |
| `kind`      | e.g. `code`, `doc`, `note` (optional)                          |
| `memory_id` | optional back-pointer to the memory that raised it             |

Tesserae are searchable independently: even with no matching memory (or after a
memory is superseded), a matching tessera is still found.

### 3.3 Tesserae are content-anchored, not line-anchored

A tessera stores a **content snippet**, never a line number. Line numbers drift
on every edit; content is relocatable. To resolve a tessera, locate its snippet
in the current file (exact match → position; absent → tessera is stale). This
is the established pattern from
[gptme hash-anchored editing](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py),
[agentic-bookmarks self-healing anchors](https://github.com/super-mega-lab/agentic-bookmarks),
and [haido `hash_at_link` drift detection](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md):
never persist a position that the file can invalidate; persist content and
relocate.

**Drift tolerance (ticket 8).** A tessera additionally stores a 64-bit SimHash
fingerprint of its target file (`tesserae.file_simhash`, computed once at write
time). Relocation is two-stage:

1. **Exact** — locate the snippet line in `tessera.path` (`includes`). Hit → done.
2. **Fingerprint fallback** — exact miss does not immediately mean stale. Compare
   the stored file SimHash against the current files in scope (all readable
   files under the project). If one is within Hamming ≤ 6 — the same document
   after small edits, or the file after a move — re-locate the snippet against
   that candidate file. SimHash is document-level: measured on real repo files
   (5–60 KB), near-identical pairs sit at Hamming 1–3 and unrelated at ~24, so
   ≤ 6 cleanly separates (100% recall / 0.24% false positive), while short
   memory/snippet text has no such signal and is never fingerprinted this way.

The fingerprint finds a *candidate file*; the snippet match confirms the exact
position. The tessera row is never auto-rewritten — the caller decides whether
to update `path` after confirmation.

Staleness is **objective**: resolve on read; if the snippet no longer exists
anywhere the fingerprint points (exact or fallback), report the tessera as
stale (memory stays valid — only the position is gone).

### 3.4 Markers are the index pointer between memory and tessera

NMG memory already carries an open-string metadata channel — `MemoryMarker`
(`kind` open, `attributes` key/value), used today by `board_origin` and
`retrieveHint`. The memory↔tessera link rides the same channel:

```jsonc
markers: [{
  "kind": "tessera_ref",
  "attributes": { "tesseraId": "…" }
}]
```

The marker is a *pointer*; the tessera row is the *content*. This keeps the
schema untouched (no migration) and gives RAII for free: markers follow their
memory through supersede/delete.

### 3.5 Writing is active; recall is active + passive

- **Write (active):** when the Agent records a memory that refers to a file
  location, it optionally supplies a tessera (`nmg remember … --tessera
  PATH::SNIPPET`, or a dedicated `nmg tessera` action). Writing memory is
  already an active act; adding a tessera is the same act, one extra field. No
  observer, no auto-extraction.
- **Recall (active + passive):** active search queries both sources; passive
  automatic recall can surface tesserae alongside memory. The marker lets
  recall walk memory → tessera → file position when needed.

## 4. Architecture

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
                                        never indexed by NMG)
```

## 5. Boundaries

- Tesserae are **not memory**: no LTG/STG semantics, no provenance/verification
  on tessera content. The `memory_id` back-pointer is optional linkage, not
  memory content.
- Files are **not indexed**: NMG stores pointers, never file content. The
  "files are not memory" red line is preserved by construction.
- Tesserae are **sparse and Agent-authored**: no parser, no crawler, no
  tree-sitter, no mdast. Document "concept units" remain out of scope (no
  deterministic parser; see the superseded design's structured-unit note).

## 6. Relation to the superseded design

[file-content-source-design.md](file-content-source-design.md) proposed a
full-text file index as a second search source. This design keeps its
conclusions that are still true — files are not memory; scope discipline
matters; separated presentation is sane — but **drops the file index itself** in
favor of sparse, Agent-authored tesserae. The maintenance-heavy machinery
(`.nmg-search-scope`, incremental crawler, file FTS, scope observer) is not part
of this design, and ticket 8 removes the code that PR #18 left behind
(`file-index.ts`, the per-search crawl, the DSH scope observer). The only
machine-derived file signal tesserae keep is a single 64-bit SimHash per
target file (§3.3) — a drift detector, not an index.

## 7. Open questions (deferred)

- Tessera store location (separate table in the memory DB vs project-local
  file). TBD at implementation.
- Snippet length and relocation tolerance (exact vs fuzzy).
- Whether tesserae get a TTL or are retired by staleness only.
- Presentation: tesserae shown as a third partition, or merged with memory.

## 8. Research basis (surveyed 2026-09-02)

| Reference | What it validates |
| --- | --- |
| [haido DESIGN.md](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md) | Anchored memory with objective staleness (`hash_at_link`), not TTLs or LLM self-reflection; anchors drift/missing/moved; recall ranks anchors before full text. Closest full implementation to this design. |
| [gptme `_anchored.py`](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py) | Hash-anchored, content-based editing — content anchors survive edits, line numbers do not. |
| [agentic-bookmarks](https://github.com/super-mega-lab/agentic-bookmarks) | Durable bookmarks with self-healing anchors that survive refactors. |
| [ai-memory ARCHITECTURE](https://github.com/akitaonrails/ai-memory/blob/v1.8.0/docs/ARCHITECTURE.md) | Markdown wiki as source of truth, SQLite as derived index — validates "pointers, not replicas". |
| [quote-anchored citations ADR](https://zby.github.io/commonplace/reference/adr/023-quote-anchored-citations-for-code-grounded-reviews/) | Cite by quoted content, not line number, for code-grounded references. |
