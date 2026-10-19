# 检索用的文件内容源

[English](file-content-source-design.md) · [术语](file-content-source-design.terms.yaml)

**Status:** superseded
**Updated:** 2026-09-01
**Superseded by:** [memory-tesserae-design.md](../memory-tesserae-design.md)——全文文件索引被放弃，改为以稀疏的、由 Agent 撰写的 tesserae（书签）作为独立可检索来源。本文为血统保留；其中「文件不是记忆」与「呈现分离」两条结论继续成立。

本文提出给 `nmg search` 增加第二个内容源——项目自身的文件与文档——使 Agent 不必每个会话都靠手重新发现本项目。设计有意收窄范围：一个**有界、被动扫描的文件索引**，其范围从 Agent 自己的检索行为中学习。它不是通用爬虫，不是文档管理系统，也不把文件变成记忆。

## 1. 问题

NMG 存的是*抽取出的语义记忆*，不是项目当前的文件。当 Agent 需要知道「这个项目里有什么、在哪、现在长什么样」时，每次都得退回到对整棵树手打 `grep`/`read`/`glob`。这正是「靠手浏览一个不断变化的项目」的痛感：

- 文档和代码在变；记忆不跟踪文件的当前状态；
- 每个会话都要从零重新发现项目布局；
- Agent 没有一个「搜索本项目」的入口，能在一次调用里同时返回*记忆*与*当前文件内容*。

## 2. 目标

给 `nmg search` 增加一个**文件内容源**：

```text
nmg search "query"
  ├── memory source (existing): FTS5 + optional vector over memory_records
  └── file source (new):         FTS5 over project files in the search scope
       → one result surface, memory items and file items distinguishable
```

文件源是一个*检索索引*，不是记忆：文件内容永不写入 LTG/STG，永不带 provenance／作用域／验证语义，而且物理上分离。它只让「项目当前状态」与记忆一起可检索。

## 3. 设计：有界被动扫描加学习式范围

爬虫是一次**带范围的被动扫描**——它自动扫描（无需手动触发），但只在配置的检索范围内。范围就是 Agent 通过检索学到的那一份。

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

### 3.1 范围文件：`.nmg-search-scope`

项目根目录下一个简单的路径清单文件，**语义上与 `.gitignore` 相反**：`.gitignore` 把路径从 Git 中排除；`.nmg-search-scope` 把路径*纳入*为检索热点区。功能上相似（都是路径清单配置），含义相反。

```gitignore
# .nmg-search-scope — paths the Agent searches most, indexed first
src/core/store/
docs/design/
src/cli/
skills/nmg-memory/
```

- **格式：** 一行一个路径；用 `#` 注释；目录意味着递归。
- **可编辑：** 由 Agent 或用户编辑，和 `.gitignore` 一样。
- **自动生长：** 范围演化步骤追加新发现的热点路径（去重），因此范围随项目变化而适配。

### 3.2 范围演化：Agent 就是第一个爬虫

观察 Agent 自己的检索行为来生长范围：

- **信号（弱）：** 一次 `grep`/`read` 工具结果非空 → 被检索的路径是候选热点区。
- **信号（强）：** 一次 `grep` 命中之后跟着 `read`、随后又有 `edit`／引用 → 该文件确实被用到（对应记忆里的已验证结果思路，也对应经典搜索引擎的频率信号）。

实现注记：在 DSH 上这是一个 `tools/result` 监听器（只观察，从不拦截）；在 Pi 上既有的 `tool_result` 钩子加 `isMemorableToolResult` 已经提供了这处观察接缝。

### 3.3 爬虫：有界被动扫描

- **触发：** daemon 维护（与既有的机会式维护相同）或显式的 `nmg crawl`——自动进行，不是每次检索都跑。
- **范围：** 只在 `.nmg-search-scope` 之下的路径；绝不碰 `node_modules`／`.git`／二进制（排除依靠 `.gitignore`，纳入依靠范围文件）。
- **增量性：** git status/diff 说明自上次扫描以来哪些文件变了；只重建那些（对应 Zoekt 基于 git 的索引与 CocoIndex 的增量框架）。
- **索引：** 复用 NMG 的 FTS5 流水线（`ftsIndexedText`／`surfaceIndexedText`、trigram 表面锚点）——词法优先，不需要向量（与「词法检索通常已足够且更便宜」的发现一致）。

### 3.4 检索融合

- 记忆结果与文件结果在一次 `nmg search` 调用中融合。
- 呈现可切换：**混合**（一份排序列表，文件项打 `file:` 标签）或**分离**（记忆块加文件块）。两者实现成本都低；默认值可以在一次快速可用性检查之后再定。
- 融合避免在不可比的尺度之间做朴素加权评分；按 Hybrid Search 模式，优先基于名次的处理（RRF 式）或直接分离。

## 4. 研究依据（2026-09-01 调研）

| 工作 | 相关性 |
| --- | --- |
| [Is Grep All You Need?](https://arxiv.org/abs/2605.15184) | Agent 检索：词法（grep）通常 ≥ 向量，噪声下尤其如此——支持词法优先的文件索引。 |
| [Zoekt (Sourcegraph)](https://github.com/sourcegraph/zoekt) | 生产级基于 git 的代码检索；git 作为内容源、预建 trigram 索引、增量——本设计在小规模上照搬的架构。 |
| [CocoIndex](https://cocoindex.io/docs/examples/index-codebase/) | 增量索引框架（遍历仓库 → 切块 → 嵌入 → 更新）；验证了增量扫描模式。 |
| [Agent Patterns: Hybrid Search](https://www.agentpatternscatalog.org/patterns/hybrid-search/) | BM25 加向量的融合用基于名次的融合（RRF），不是原始分数加权。 |
| agent-trace / agent_recorder / agentacta | 观察工具调用来建立 agent 行为的审计／索引——与本设计学习范围时所用的同一处观察接缝。 |
| forge watch.rs / relay-knowledge | 后台 fs.watch 加文件变更时的增量重建索引——有界扫描的机制。 |
| `.qwenignore` / semgrepignore / acp.config | 控制工具范围的路径清单配置——`.nmg-search-scope` 的先例。 |

## 5. 边界（明确不在范围内）

- 文件**不是**记忆：不写 LTG/STG，不带 provenance／作用域／验证语义，不对文件内容记录 claim outcome。
- 不是通用爬虫：扫描被有界地限制在学习到的范围内，绝不是整个磁盘或整个仓库。
- 不是文档管理系统：没有文件版本，没有文档生命周期。
- 默认词法优先；向量是可选的未来增强，不是要求（依据 §4 的发现）。
- **目前不解析结构化单元**（2026-09-02 调研）：代码符号单元（tree-sitter）与 Markdown 章节锚点（mdast）原则上可靠，但文档侧的「概念单元」没有确定性解析器——散文结构住在语义层，不在语法层。我们留一个抽取器协议槽位（爬虫 → 按类型抽取器 → 单元行），在出现真实缺口或有成熟工具要求之前不实现它。

## 6. MVP 路径

1. `.nmg-search-scope` 读／写（简单的路径清单格式）。
2. `nmg crawl`（或 daemon 维护钩子）：扫描范围 → 在 `.nmg/` 下建 FTS 索引（项目级，与记忆表分离）。
3. `nmg search` 的文件源分支：查文件 FTS，结果打 `file:` 标签。
4. DSH `tools/result` 监听器：观察 grep/read 命中 → 把热点路径追加进范围（去重、设上限）。
5. 呈现切换（混合／分离）放在一个 flag 后面。
6. 通过 git status 做增量重建索引。

## 7. 未决问题

- 默认呈现：混合还是分离？（两者都已实现；短期试用后再选。）
- 范围自动生长的上限与衰减（避免范围无限膨胀）。
- 文件索引是按项目（`.nmg/`）还是共用 daemon store；按项目可以保持隔离、可整体删除。
- **结构化单元的演进（推迟，只保留协议槽位）**：当前索引是整个文件的 blob。未来的抽取器层可以为代码（tree-sitter）和 Markdown（mdast 标题章节）产出单元行（`path, kind, name, start_line, end_line`），给出 file:line 锚点而不是 trigram 片段。文档「概念单元」没有确定性解析器，刻意不追；语义理解仍归 embedding。
