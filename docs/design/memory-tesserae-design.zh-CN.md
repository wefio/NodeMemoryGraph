# 记忆 tesserae：作为可检索来源的书签

[English](memory-tesserae-design.md) | [简体中文](memory-tesserae-design.zh-CN.md) · [术语](memory-tesserae-design.terms.yaml)

**Status:** draft
**Updated:** 2026-09-02

## 范围与证据边界

**源码审阅，2026-10-17：**本文仍是附带日期化实现说明的设计草稿，不是端到端验收记录。
本轮读取的 owner 为 [`schema.ts`](../../src/core/store/schema.ts)、
[`writes.ts`](../../src/core/store/writes.ts)、[`retrieval.ts`](../../src/core/store/retrieval.ts)
与 [`service.ts`](../../src/cli/service.ts)。未执行测试、benchmark 或外部文献核实。
历史 ticket 编号不证明相关工作当前仍未完成。

本文取代文件内容来源设计
（[file-content-source-design.md](archived/file-content-source-design.md)），成为
“Agent 如何经 NMG 到达文件内容”的设计 owner，记录一次从第一性原理出发的重新设计，
其基础是持续的设计讨论（调查日期为 2026-09-02）。

> **术语说明。** 本设计最初把书签称为 anchors，并以该名称发布。实现后来改名为
> tesserae（单数 tessera；命名讨论借用拉丁语 tessera hospitalis，作为配对信物的类比，
> 而非 NMG 身份证明），因为 anchor 已指代代码库中另一种检索概念：`surface anchors`，
> 即为精确匹配而索引的显式引用短语／路径／ID。本文使用发布后的名称。
> anchored 作为一般形容词（content-anchored、hash-anchored），或出现在其他系统的
> anchor 名称中时，保留原义。

## 1. 问题

Agent 不断为已经知道存在的东西“到处搜索”。本用例中的 NMG memory 保存
*长期、低变动*的事实，例如“存在预算机制”。但 memory 不说明机制在当前文件树的
哪个位置，于是每次会话都要用 `grep`／`read`／`glob` 重新找文件。

此前的答案是**文件内容索引**：被动扫描文件、索引全文，再作为第二个来源检索
（[file-content-source-design.md](archived/file-content-source-design.md)）。MVP 经验表明，
这条路能用，却不理想：整文件 blob、缺少 surface anchor 的 trigram 碎片，尤其是
**还得维护完整索引**——scope 文件、增量 crawler、内容哈希、文件 FTS、scope observer。
对文件本就可按路径访问的记忆系统而言，该维护成本高于检索收益。

## 2. 从第一性原理重新界定

对本用例，三个层次各回答一个问题：

```text
memory  (long-lived, low-churn)  — "there is this thing"
tessera (bookmark, position)     — "the content of that thing is here"
file    (content host)           — the actual bytes
```

Agent **不必**记住哪个文件的哪一行存着什么内容——这些知识变动频繁且脆弱。
它需要记住*某事存在*（memory），并有低成本、客观的途径到达*对应内容*
（tessera → file）。Tessera 是桥梁，是**外部缓冲层**，不是权威 memory 事实，
也不是持续维护的整文件副本。

## 3. 决定

### 3.1 不做文件全文搜索

文件内容来源（文件全文索引、`.nmg-search-scope`、增量 crawler、文件 FTS）
**不再作为维护中的特性**。NMG 不为该来源维护整文件文本索引，但会索引选定的
书签 label／snippet、读文件进行定位，并可能为漂移回退执行有界文件扫描；
“不提供全文来源”不表示没有文件 IO。文件仍可经 tesserae 访问，也可经 Agent 自身的
`read`／`grep` 工具访问；NMG 不替代这些工具。

理由是文件索引维护昂贵，相比 tesserae 加直接工具访问，边际价值有限。
文件是内容宿主，NMG 只需要*指向其内部的指针*。

原记录把移除工作列为 **ticket 8**，并报告首个 tesserae PR 的搜索仍运行
`file-index.ts`。这是历史推广背景，不表示该 ticket 当前仍未完成。本轮所读 service
现查询书签 FTS 来源，并执行下述有界定位；未审计 DSH 原有的 scope observer。

### 3.2 Tesserae 是独立、可检索的来源

**Tessera（定位书签）**是一等行，不是附着在 memory 上的字段。当前 schema 在记忆数据库
中设独立的 `tesserae` 表，`tesserae_fts` 索引 `label` 与 `snippet`，`path` 为
`UNINDEXED`。Service 把该来源与 memory 一起查询，但返回独立的 `tesserae` 分区，
不是联合排序的单一列表。

```text
nmg search "budget"
  ├── memory source:  FTS over memory_records       (existing)
  └── tessera source: FTS over tesserae (label/snippet)  (new)
```

Tessera 行包含：

| field | 含义 |
| --- | --- |
| `path` | 书签所指文件，按约定使用项目相对路径 |
| `snippet` | 短摘录；当前定位要求单行子串 |
| `label` | Agent 编写、可检索的一行说明 |
| `kind` | 例如 `code`、`doc`、`note`，可选 |
| `memory_id` | 指向提出该书签的 memory 的可选反向链接 |

书签查询不连接或过滤所链接 memory 的状态。因此，即使没有匹配的活动 memory，
书签仍可能被检索到。该表没有 project／session 区分字段；项目根只是定位上下文，
不是数据库隔离或文件授权保证。

### 3.3 Tesserae 以内容为锚，不以行号为锚

Tessera 保存**内容 snippet**，不持久化行号。当前定位会 trim 该 snippet，返回第一个
把它作为子串包含的行；不做模糊或多行匹配，重复 snippet 也不证明位置唯一。
原设计将 [gptme hash-anchored editing](https://github.com/gptme/gptme/blob/ae707fc8233e77d4da97fc74f94db1eaff1e381a/gptme/tools/_anchored.py)、
[agentic-bookmarks self-healing anchors](https://github.com/super-mega-lab/agentic-bookmarks)
和 [haido drift detection](https://github.com/lebac-svg/haido/blob/HEAD/docs/DESIGN.md)
列为研究线索；它们不是本轮独立核实的实现证据。

**漂移容忍。** `tesserae.file_simhash` 以 16 个小写十六进制字符保存 64-bit 书签漂移指纹。
写入时目标可读，service 才计算指纹；失败时可以不带指纹写入，不阻塞 memory 写入。
搜索可按*当时的当前文件字节*补填缺失值，每行至多一次。晚补的指纹不证明原始写入时的
内容。补填有界且尽力而为：某轮对缺失行一个也未成功写入时，当前实现可停止该 root
的补填，其中包括不可读或失败的行；不保证最终重试。

给定项目根时，定位分两步：

1. **精确定位**——在保存的路径中找 snippet；命中便返回当前的 1-based 行号。
2. **指纹回退**——精确未命中时，必须已有指纹。若旧路径仍可读，且当前指纹的
   Hamming ≤ 6，则将缺失 snippet 视为失效，不扫描其他文件。否则 service 最多扫描
   **200 个普通文件**，跳过隐藏／VCS／依赖／构建目录及符号链接条目，返回第一个
   Hamming ≤ 6 且包含 snippet 的候选。这只是文件数上限，不是字节、耗时或完整项目
   覆盖的上限。

2026-09-02 的讨论报告了 5–60 KB 仓库文件上的观察：近乎相同的文件对为 Hamming 1–3，
不相关文件对约为 24；阈值 6 对应 100% recall／0.24% false positive。本轮未重新验证
底层样本或这些比率。它们不是普适分离保证，也不是短 memory／snippet 指纹的测量。
本特性计算文件指纹，不计算 snippet 指纹。

指纹选择的是**候选文件**，不是已证实的身份；精确 snippet 匹配提供位置。
定位可返回新的相对 `path`、`line` 和 `relocated: true`，但不重写持久化路径或 snippet。
指纹补填是上文另述的有限行更新。

**书签定位失败**在当前可访问视图及有界程序内设置 `stale: true`，不证明所有位置都不存在
该文本。未提供项目根时，service 返回未定位命中，不做本次读取检查，因此缺少 stale
标志不构成新鲜度证据。无论书签可定位还是失效，都不能证明所链接 memory 为真或仍有效。

### 3.4 Marker 是 memory 与 tessera 之间的索引指针

NMG memory 已有开放字符串元数据通道 `MemoryMarker`（开放的 `kind`、键值
`attributes`）；原讨论用 `board_origin` 和 `retrieveHint` 作示例。
Memory↔tessera 链接复用该通道：

```jsonc
markers: [{
  "kind": "tessera_ref",
  "attributes": { "tesseraId": "…" }
}]
```

**Tessera 引用标记**是指针，独立行保存书签数据。它复用 memory 元数据，不增加
memory-record 列，但不表示完全没有 schema 工作：实现创建 tessera／FTS 表，并有旧名
改名及指纹迁移。`memory_id` 没有级联外键，独立查询也不按 memory 状态过滤。
因此，仅携带 marker 并不给独立行带来 RAII、删除、退役或 acceptance 保证。

### 3.5 主动写入；主动与被动召回

- **写入（主动）：**本轮读取的 CLI 支持可重复的
  `nmg remember … --tessera PATH::SNIPPET[::LABEL]`；core 在 memory 写入中接受可选的
  `tesserae`。Service 协议每次写入最多接受 10 个。Core 规划跳过缺 path／snippet
  的项，并在 memory-write 事务中插入已规划的行。此前建议的独立 `nmg tessera` action
  在本文只是设计选项，不是调用已发布命令的指示。编写书签不要求 observer 或自动抽取。
- **召回（主动与被动）：**service 搜索可返回 memory 和 tessera 分区，由 adapter 决定
  在主动或自动召回中如何呈现。Marker 标识书签，文件位置定位则需要项目根。
  这不保证每种原始 core 搜索或 adapter 都执行该路径或显示两种来源。

## 4. 架构

下图表达设计关系，不是覆盖每一种 residence 或 adapter 的证明。

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

## 5. 边界

- Tesserae **不是 memory**：没有 LTG／STG 语义，不对 tessera 内容做来源／验证。
  `memory_id` 反向指针是可选链接，不是 memory 内容。
- 文件**不是持续维护的全文来源**：书签保存路径、label 与选定文本摘录，不是持续维护的
  整文件副本。它并非不含内容；作者不得把所存 snippet 当成已验证 memory，或据此认定
  系统没有保留任何文件文本。
- Tesserae **稀疏且由 Agent 编写**：没有持续维护的内容 parser 或后台 crawler，
  不使用 tree-sitter 或 mdast；但有界回退文件 IO 仍存在。文档“概念单元”继续不在范围内，
  没有确定性 parser，见被取代设计中的结构化单元说明。

## 6. 与被取代设计的关系

[file-content-source-design.md](archived/file-content-source-design.md) 曾提议把文件全文
索引作为第二检索来源。本文保留其仍成立的结论：文件不是 memory、scope 纪律重要、
分开呈现合理；但**放弃文件索引本身**，改用稀疏、由 Agent 编写的 tesserae。

维护较重的机制（`.nmg-search-scope`、增量 crawler、整文件 FTS、scope observer）
不属于目标设计。Ticket 8 最初列出了 PR #18 遗留的 `file-index.ts`、逐次搜索 crawl
与 DSH scope observer；该安排属于历史，本文不认证当前 DSH 清理。
定位所保留的文件级指纹是单个 64-bit SimHash（§3.3），不是持续维护的整文件内容索引。

## 7. 未决问题（推迟处理）

部分原始问题已有源码可见答案：独立表位于 SQLite，当前定位采用单行精确匹配加有界
指纹回退，service 结果使用独立分区。这些选择并未履行全部设计义务，本文仍推迟处理：

- TTL／退役，以及所链接 memory 删除或 supersession 时的策略。
- 显式项目身份、路径授权及跨项目可见性。
- 歧义 snippet、多行／模糊定位、扫描完整性及指纹补填重试策略。
- 各 adapter 的被动呈现与端到端覆盖。

## 8. 研究基础（调查于 2026-09-02）

完整的[历史研究对照](memory-tesserae-design/research-basis.zh-CN.md)保留五条原始线索。
它们是历史设计依据，不是本轮重新验证过的外部来源。
