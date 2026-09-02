# Memory anchors: bookmarks as a searchable source

**Status:** proposed
**Updated:** 2026-09-02

This document supersedes the file-content-source design
([file-content-source-design.md](file-content-source-design.md)) as the owner of
"how an Agent reaches file content through NMG". It records a first-principles
redesign reached through an extended design discussion (surveyed 2026-09-02).

## 1. Problem

The Agent repeatedly "searches around" for things it already knows exist. NMG
memory stores *long-lived, low-churn* facts — "there is a budget mechanism". But
memory does not say *where* that mechanism lives in the current file tree, so
every session re-discovers file locations by hand (`grep` / `read` / `glob`).

The previous answer was a **file content index**: passively scan files, index
their full text, and search them as a second source
([file-content-source-design.md](file-content-source-design.md)). Experience
with the MVP showed this direction is usable but not good: whole-file blobs,
trigram fragments with no anchors, and — decisively — **a whole index to
maintain** (scope file, incremental crawler, content hashes, file FTS, scope
observer). The maintenance cost outweighs the retrieval benefit for a memory
system whose files are already reachable by path.

## 2. First-principles reframing

Three layers, each answering one question:

```text
memory  (long-lived, low-churn)  — "there is this thing"
anchor  (bookmark, position)      — "the content of that thing is here"
file    (content host)            — the actual bytes
```

The Agent does **not** need to remember which file, at which line, holds which
content — that is high-churn, fragile knowledge. It needs to remember *that the
thing exists* (memory) and have a cheap, objective way to reach *its content*
(anchor → file). The anchor is the bridge; it is an **external buffer layer**,
not memory content and not a file-content replica.

## 3. Decisions

### 3.1 No file full-text search

The file content source (full-text index over files, `.nmg-search-scope`,
incremental crawler, file FTS) is **dropped** as a maintained feature. Files are
not indexed, not crawled, not searched by NMG. They remain reachable through
anchors (and through the Agent's own `read`/`grep` tools, which NMG does not
replace).

Rationale: maintaining a file index is expensive and its marginal value over
anchors + direct tool access is low. The file is the content host; NMG only
needs *pointers into it*.

### 3.2 Anchors are an independent, searchable source

An **anchor** (a bookmark) is a first-class row, not a field glued onto a
memory. Anchors live in their own store and are **searched alongside memory** —
a single query returns memory hits *and* anchor hits.

```text
nmg search "budget"
  ├── memory source: FTS over memory_records        (existing)
  └── anchor source: FTS over anchors (label/path)  (new)
```

An anchor row carries:

| field     | meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `path`    | file the anchor points into (project-relative)             |
| `snippet` | short content excerpt used for *relocation*, not line      |
| `label`   | Agent-written one-liner (searchable)                       |
| `kind`    | e.g. `code`, `doc`, `note` (optional)                      |
| `memory_id` | optional back-pointer to the memory that raised it        |

Anchors are searchable independently: even with no matching memory (or after a
memory is superseded), a matching anchor is still found.

### 3.3 Anchors are content-anchored, not line-anchored

An anchor stores a **content snippet**, never a line number. Line numbers drift
on every edit; content is relocatable. To resolve an anchor, locate its snippet
in the current file (exact match → position; fuzzy fallback → nearest match;
absent → anchor is stale). This is the established pattern from
[gptme hash-anchored editing](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py),
[agentic-bookmarks self-healing anchors](https://github.com/super-mega-lab/agentic-bookmarks),
and [haido `hash_at_link` drift detection](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md):
never persist a position that the file can invalidate; persist content and
relocate.

Staleness is **objective**: resolve on read; if the snippet no longer exists,
report the anchor as stale (memory stays valid — only the position is gone).

### 3.4 Markers are the index pointer between memory and anchor

NMG memory already carries an open-string metadata channel — `MemoryMarker`
(`kind` open, `attributes` key/value), used today by `board_origin` and
`retrieveHint`. The memory↔anchor link rides the same channel:

```jsonc
markers: [{
  "kind": "anchor_ref",
  "attributes": { "anchorId": "…" }
}]
```

The marker is a *pointer*; the anchor row is the *content*. This keeps the
schema untouched (no migration) and gives RAII for free: markers follow their
memory through supersede/delete.

### 3.5 Writing is active; recall is active + passive

- **Write (active):** when the Agent records a memory that refers to a file
  location, it optionally supplies an anchor (`nmg remember … --anchor
  path:label`, or a dedicated `nmg anchor` action). Writing memory is already an
  active act; adding an anchor is the same act, one extra field. No observer, no
  auto-extraction.
- **Recall (active + passive):** active search queries both sources; passive
  automatic recall can surface anchors alongside memory. The marker lets recall
  walk memory → anchor → file position when needed.

## 4. Architecture

```text
┌─────────────── search ────────────────────────────────┐
│  query → memory hits (existing) + anchor hits (new)   │
└───────────────────────────┬───────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
┌───────────────┐                    ┌───────────────────┐
│ memory_records│                    │ anchors           │
│  (LTG/STG)    │  marker anchor_ref  │ (path, snippet,   │
│               │ ──────────────────► │  label, memory_id)│
└───────────────┘                    └─────────┬─────────┘
                                               │ resolve snippet
                                               ▼
                                        file (content host,
                                        never indexed by NMG)
```

## 5. Boundaries

- Anchors are **not memory**: no LTG/STG semantics, no provenance/verification
  on anchor content. The `memory_id` back-pointer is optional linkage, not
  memory content.
- Files are **not indexed**: NMG stores pointers, never file content. The
  "files are not memory" red line is preserved by construction.
- Anchors are **sparse and Agent-authored**: no parser, no crawler, no
  tree-sitter, no mdast. Document "concept units" remain out of scope (no
  deterministic parser; see the superseded design's structured-unit note).

## 6. Relation to the superseded design

[file-content-source-design.md](file-content-source-design.md) proposed a
full-text file index as a second search source. This design keeps its
conclusions that are still true — files are not memory; scope discipline
matters; separated presentation is sane — but **drops the file index itself** in
favor of sparse, Agent-authored anchors. The maintenance-heavy machinery
(`.nmg-search-scope`, incremental crawler, file FTS, scope observer) is not part
of this design.

## 7. Open questions (deferred)

- Anchor store location (separate table in the memory DB vs project-local
  file). TBD at implementation.
- Snippet length and relocation tolerance (exact vs fuzzy).
- Whether anchors get a TTL or are retired by staleness only.
- Presentation: anchors shown as a third partition, or merged with memory.

## 8. Research basis (surveyed 2026-09-02)

| Reference | What it validates |
| --- | --- |
| [haido DESIGN.md](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md) | Anchored memory with objective staleness (`hash_at_link`), not TTLs or LLM self-reflection; anchors drift/missing/moved; recall ranks anchors before full text. Closest full implementation to this design. |
| [gptme `_anchored.py`](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py) | Hash-anchored, content-based editing — content anchors survive edits, line numbers do not. |
| [agentic-bookmarks](https://github.com/super-mega-lab/agentic-bookmarks) | Durable bookmarks with self-healing anchors that survive refactors. |
| [ai-memory ARCHITECTURE](https://github.com/akitaonrails/ai-memory/blob/v1.8.0/docs/ARCHITECTURE.md) | Markdown wiki as source of truth, SQLite as derived index — validates "pointers, not replicas". |
| [quote-anchored citations ADR](https://zby.github.io/commonplace/reference/adr/023-quote-anchored-citations-for-code-grounded-reviews/) | Cite by quoted content, not line number, for code-grounded references. |
