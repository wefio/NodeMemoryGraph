# File content source for search

**Status:** superseded
**Updated:** 2026-09-01
**Superseded by:** [memory-anchors-design.md](memory-anchors-design.md) — the
full-text file index is dropped in favor of sparse, Agent-authored anchors as an
independent searchable source. This document is kept for lineage; its
"files are not memory" and separated-presentation conclusions carry forward.

This document proposes giving `nmg search` a second content source — the
project's own files and documents — so an Agent does not have to re-discover the
project by hand every session. The design is intentionally scoped: a **bounded,
passively-scanned file index** whose range is learned from the Agent's own search
behaviour. It is not a general crawler, not a document-management system, and it
does not turn files into memory.

## 1. Problem

NMG stores *extracted semantic memory*, not the project's current files. When an
Agent needs to know "what is in this project, where, and what does it look like
now", it must fall back to manual `grep`/`read`/`glob` over the tree every time.
This is exactly the pain of "browsing a changing project by hand":

- documents and code change; memory does not track the current file state;
- every session re-discovers the project layout from scratch;
- the Agent has no "search the project" entry point that returns both *memory*
  and *current file content* in one call.

## 2. Goal

Add a **file content source** to `nmg search`:

```text
nmg search "query"
  ├── memory source (existing): FTS5 + optional vector over memory_records
  └── file source (new):         FTS5 over project files in the search scope
       → one result surface, memory items and file items distinguishable
```

The file source is a *search index*, not memory: file content is never written to
LTG/STG, never gets provenance/scope/verification semantics, and is physically
separate. It only makes "current project state" searchable alongside memory.

## 3. Design: bounded passive scan with a learned scope

The crawler is a **passive scan with a scope** — it scans automatically (no
manual trigger) but only inside the configured search scope. The scope is what
the Agent learns by searching.

```text
┌─ scope evolution (Agent-driven) ──────────────────────────────┐
│  observe grep/read tool results → files that were actually    │
│  useful → add their paths to .nmg-search-scope                │
└───────────────────────────────────────────────────────────┘
┌─ bounded passive scan (crawler) ─────────────────────────────┐
│  scan files under .nmg-search-scope → FTS index               │
│  git status/diff → incremental re-index of changed files only │
│  never scans outside the scope (cost + privacy)               │
└───────────────────────────────────────────────────────────┘
┌─ search fusion ───────────────────────────────────────────────┐
│  nmg search → memory results + file results (scoped)          │
│  presentation: mixed or separated (switchable)                │
└───────────────────────────────────────────────────────────┘
```

### 3.1 The scope file: `.nmg-search-scope`

A simple path-list file at the project root, **semantically opposite to
`.gitignore`**: `.gitignore` excludes paths from Git; `.nmg-search-scope`
*includes* paths as search hot zones. Functionally similar (a path-list config),
opposite in meaning.

```gitignore
# .nmg-search-scope — paths the Agent searches most, indexed first
src/core/store/
docs/design/
src/cli/
skills/nmg-memory/
```

- **Format:** one path per line; comments with `#`; directories imply recursion.
- **Editable:** by the Agent or the user, like `.gitignore`.
- **Auto-grown:** the scope-evolution step appends newly discovered hot paths
  (deduplicated), so the range adapts as the project changes.

### 3.2 Scope evolution: the Agent is the first crawler

Observe the Agent's own search behaviour to grow the scope:

- **Signal (weak):** a `grep`/`read` tool result is non-empty → the searched
  paths are candidate hot zones.
- **Signal (strong):** a `grep` hit is followed by `read` and later `edit`/
  reference → the file is genuinely used (mirrors memory's verified-outcome
  idea, and classic search-engine frequency signals).

Implementation note: on DSH this is a `tools/result` listener (observe, never
intercept); on Pi the existing `tool_result` hook + `isMemorableToolResult`
already provide the observation seam.

### 3.3 The crawler: bounded passive scan

- **Trigger:** daemon maintenance (like existing opportunistic maintenance) or an
  explicit `nmg crawl` — automatic, not per-search.
- **Scope:** only paths under `.nmg-search-scope`; never `node_modules`/`.git`/
  binaries (`.gitignore`-aware for exclusion, scope file for inclusion).
- **Incrementality:** git status/diff tells which files changed since last scan;
  re-index only those (mirrors Zoekt's git-based indexing and CocoIndex's
  incremental framework).
- **Index:** reuse NMG's FTS5 pipeline (`ftsIndexedText`/`surfaceIndexedText`,
  trigram surface anchors) — lexical-first, no vector required (consistent with
  the finding that lexical retrieval is usually sufficient and cheaper).

### 3.4 Search fusion

- Memory results and file results are fused in one `nmg search` call.
- Presentation is switchable: **mixed** (one ranked list, file items tagged
  `file:`) or **separated** (memory block + file block). Both are cheap to
  implement; the default can be decided after a quick usability check.
- Fusion avoids naive score weighting across incompatible scales; prefer
  rank-based handling (RRF-style) or separation, per the Hybrid Search pattern.

## 4. Research basis (surveyed 2026-09-01)

| Work | Relevance |
| --- | --- |
| [Is Grep All You Need?](https://arxiv.org/abs/2605.15184) | Agent retrieval: lexical (grep) usually ≥ vector, esp. under noise — supports lexical-first file index. |
| [Zoekt (Sourcegraph)](https://github.com/sourcegraph/zoekt) | Production git-based code search; git as content source, prebuilt trigram index, incremental — the architecture this design mirrors at small scale. |
| [CocoIndex](https://cocoindex.io/docs/examples/index-codebase/) | Incremental indexing framework (walk repo → chunk → embed → update); validates the incremental-scan pattern. |
| [Agent Patterns: Hybrid Search](https://www.agentpatternscatalog.org/patterns/hybrid-search/) | BM25 + vector fusion with rank-based fusion (RRF), not raw score weighting. |
| agent-trace / agent_recorder / agentacta | Observing tool calls to build an audit/index of what an agent did — the same observation seam this design uses to learn the scope. |
| forge watch.rs / relay-knowledge | Background fs.watch + incremental re-index on file change — the bounded-scan mechanism. |
| `.qwenignore` / semgrepignore / acp.config | Path-list config files controlling tool scope — precedent for `.nmg-search-scope`. |

## 5. Boundaries (explicitly out of scope)

- Files are **not** memory: no LTG/STG writes, no provenance/scope/verification
  semantics, no claim outcomes on file content.
- Not a general crawler: the scan is bounded to the learned scope, never the
  whole disk or whole repo.
- Not a document-management system: no file versions, no document lifecycle.
- Lexical-first by default; vector is an optional future enhancement, not a
  requirement (per §4 finding).
- **No structured-unit parsing for now** (surveyed 2026-09-02): code-symbol
  units (tree-sitter) and Markdown section anchors (mdast) are reliable in
  principle, but document-side "concept units" have no deterministic parser —
  prose structure lives at the semantic layer, not the syntax layer. We leave
  an extractor protocol slot (crawler → per-type extractor → unit rows) and do
  not implement it until a real gap or a mature tool demands it.

## 6. MVP path

1. `.nmg-search-scope` reader/writer (simple path-list format).
2. `nmg crawl` (or daemon maintenance hook): scan scope → build FTS index under
   `.nmg/` (project-level, separate from memory tables).
3. `nmg search` file-source branch: query the file FTS, tag results `file:`.
4. DSH `tools/result` listener: observe grep/read hits → append hot paths to
   scope (dedup, cap).
5. Presentation switch (mixed / separated) behind a flag.
6. Incremental re-index via git status.

## 7. Open questions

- Default presentation: mixed or separated? (Both implemented; pick after a
  short trial.)
- Scope auto-growth cap and decay (avoid unbounded scope growth).
- Whether the file index should be per-project (`.nmg/`) or share the daemon
  store; per-project keeps it isolated and deletable.
- **Structured-unit evolution (deferred, protocol slot only)**: the current
  index is whole-file blob. A future extractor layer could emit unit rows
  (`path, kind, name, start_line, end_line`) for code (tree-sitter) and
  Markdown (mdast heading sections), giving file:line anchors instead of
  trigram fragments. Document "concept units" have no deterministic parser and
  are deliberately not pursued; semantic understanding stays with embeddings.
