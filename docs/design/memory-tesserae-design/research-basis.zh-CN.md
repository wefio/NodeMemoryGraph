# 记忆 tesserae：历史研究线索

[English](research-basis.md) | [简体中文](research-basis.zh-CN.md) · [术语](research-basis.terms.yaml)

**Status:** draft
**Authority:** [记忆 tesserae 设计](../memory-tesserae-design.zh-CN.md)。

## 历史对照

下表是 2026-09-02 讨论中记录的对照，不是当前外部核实；尤其是 `HEAD` URL 并不固定
到某个 revision。仅架构相似不验证 NMG 的成本、生命周期或漂移主张；下述
“指针而非副本”结论是当时讨论的解释，不是使用 Markdown 加派生 SQLite 索引便能证明
的后果。

| Reference | 历史讨论所作的主张 |
| --- | --- |
| [haido DESIGN.md](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md) | 使用具有客观失效判断（`hash_at_link`）的 anchored memory，而非 TTL 或 LLM 自我反思；anchor 可漂移、缺失或移动；召回先对 anchor 排序，再处理全文。当时视为最接近本设计的完整实现。 |
| [gptme `_anchored.py`](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py) | 基于哈希锚定、按内容编辑：内容 anchor 可承受编辑，行号不行。 |
| [agentic-bookmarks](https://github.com/super-mega-lab/agentic-bookmarks) | 具有自愈 anchor、可承受重构的持久书签。 |
| [ai-memory ARCHITECTURE](https://github.com/akitaonrails/ai-memory/blob/v1.8.0/docs/ARCHITECTURE.md) | 以 Markdown wiki 为事实来源、SQLite 为派生索引；当时据此声称可验证“指针而非副本”。 |
| [quote-anchored citations ADR](https://zby.github.io/commonplace/reference/adr/023-quote-anchored-citations-for-code-grounded-reviews/) | 基于代码的引用应按所引内容而非行号定位。 |
