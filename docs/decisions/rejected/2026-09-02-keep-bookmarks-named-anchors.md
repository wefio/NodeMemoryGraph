# Keep the bookmark feature named "anchors"

[中文](2026-09-02-keep-bookmarks-named-anchors.zh-CN.md)

**Status:** rejected  
**Date:** 2026-09-02

## Problem

The memory-bookmark feature (file locations a memory points into, content-anchored
by snippet) shipped as "anchors" (`anchors` table, `anchor_ref` markers,
`--anchor` CLI flag). While reviewing the name for long-term clarity, three
unrelated "anchor" concepts were found already living in the same codebase and
ecosystem:

- **Surface anchors** (`surfaceAnchorCandidates` / `surfaceAnchors` in
  `src/core/store/`): retrieval-side explicit quoted phrases/paths/IDs indexed
  for exact-match search — an unrelated, pre-existing product concept in the
  _same search path_ as the bookmark hits.
- **Pi task anchors** (`state.anchors` in the Pi extension): recent substantive
  user-task context carried across terse turns.
- **Support anchors** (`reasoning-workspace`, `qpp`, `hierarchical-activation`):
  "a stable evidence reference" in Lab reasoning, the top-1 query anchor in QPP,
  LTG node vectors as anchors.

One word, four meanings; two of them inside the same file
(`src/core/store/retrieval.ts` hosts both `surfaceAnchorCandidates` and
`searchAnchors`).

## Proposal

Keep the shipped name "anchors" for bookmarks, relying on context and the
`(bookmark)` parenthetical to disambiguate.

## Alternatives considered

- **Qualified name, e.g. `memory-anchor` / `file-anchor`.** Rejected: it is
  longer on every CLI flag and still overloads the shared word; grep and search
  results would need the qualifier to be meaningful.
- **Keep "anchor" only in code, rename user-facing surfaces.** Rejected: the
  confusion is worst at the rendering boundary (`anchor=` lines), so partial
  renaming leaves the collision where readers actually see it.
- **Rename the other concepts instead.** Rejected: `surfaceAnchor` is an older,
  widely-referenced retrieval term (design docs, benchmark notes), and Pi's
  task-anchor lives in another repository we do not own; renaming bookmarks was
  the single change fully inside our control.

## Why rejected

- **Same search path, two meanings.** Bookmark hits and surface-anchor hits both
  flow through the retrieval context; a reader or agent seeing `anchor=` render
  lines cannot tell which concept produced them without reading the code.
- **Retrieval quality discussion needs the distinction.** The retrieval
  benchmark and design notes distinguish surface anchors (explicit-token
  retrieval) from ordinary word overlap; overloading "anchor" makes that
  discussion ambiguous.
- **Rename cost was lowest at this moment.** The feature was merged days earlier,
  had no external consumers, and all real-store rows were test data — a rename
  was a mechanical, low-risk operation (see the rename PR). Naming debt only
  compounds with age.
- The replacement name chosen was **tessera** (plural _tesserae_), from the
  Latin _tessera hospitalis_ — a token broken in two so matching the halves
  proves identity — matching the snippet-relocation model (the bookmark's
  snippet half must match the file's content half). The word had zero prior
  usage in the codebase, so it cannot collide.

## Consequences

- The feature is now `tesserae` end-to-end: table, FTS, markers
  (`tessera_ref`), CLI (`--tessera`), search rendering (`tessera=`), types
  (`TesseraRecord/Input/Hit`), and the design doc
  (`docs/design/memory-tesserae-design.md`).
- A forward migration renames a pre-rename `anchors` table in place and rewrites
  `anchor_ref` markers to `tessera_ref`, so existing stores upgrade without data
  loss.
- "Anchor" remains in the codebase only where it means one of the other three
  concepts (surface / task / support), each now unambiguous.
