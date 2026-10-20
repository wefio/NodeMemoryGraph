# Memory tesserae: recorded research leads

[English](research-basis.md) | [简体中文](research-basis.zh-CN.md) · [Terms](research-basis.terms.yaml)

**Status:** draft
**Authority:** [Memory tesserae design](../memory-tesserae-design.md).

## Recorded comparisons

These are the 2026-09-02 discussion's recorded comparisons, not current external
verification. In particular, a `HEAD` URL is not a pinned revision. Architectural
similarity alone does not validate NMG's cost, lifecycle or drift claims; the
"pointers, not replicas" conclusion below is the discussion's interpretation,
not a demonstrated consequence of using Markdown with a derived SQLite index.

| Reference | What the historical discussion claimed |
| --- | --- |
| [haido DESIGN.md](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md) | Anchored memory with objective staleness (`hash_at_link`), not TTLs or LLM self-reflection; anchors drift/missing/moved; recall ranks anchors before full text. Closest full implementation to this design. |
| [gptme `_anchored.py`](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py) | Hash-anchored, content-based editing — content anchors survive edits, line numbers do not. |
| [agentic-bookmarks](https://github.com/super-mega-lab/agentic-bookmarks) | Durable bookmarks with self-healing anchors that survive refactors. |
| [ai-memory ARCHITECTURE](https://github.com/akitaonrails/ai-memory/blob/v1.8.0/docs/ARCHITECTURE.md) | Markdown wiki as source of truth, SQLite as derived index — validates "pointers, not replicas". |
| [quote-anchored citations ADR](https://zby.github.io/commonplace/reference/adr/023-quote-anchored-citations-for-code-grounded-reviews/) | Cite by quoted content, not line number, for code-grounded references. |
