# 形式化检索质量 benchmark

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

本文记录历史本地 SQLite 检索协议和评测结果。新的评测见 [NMG HTTP 指南](../omnimemeval/README.zh-CN.md)。

## 协议（固定）

- **检索路径**：进程内 `OmniMemEvalBridge` → 共享 `searchMemoryContext` →
  `store.searchContext` → 共享的精确证据 Agent Surface。没有 benchmark 本地的
  检索或上下文渲染器，也没有 Python 子进程。
- **检索模式**：必须使用配置的产品路径 —— 记录嵌入加上有界的 surface-anchor
  通道 —— 其 `indexId` 记录在 manifest 中。普通词级 FTS 仍是零配置的产品回退，
  不是 benchmark 臂。surface anchor 通过一个无内容的 Unicode 归一化 trigram
  索引，保留显式引号短语、路径、带点号或标点的版本号、字母数字混合技术标识、
  错误码、驼峰符号、recall triggers 以及 3 字及以上中日韩连续片段；纯散文词、
  裸数字、序数词、年代缩写与 12 小时制时间词保留在词级与日期 FTS 通道中，不进入
  trigram 索引。
  `--summaries` 增加叶子块摘要臂：摄取之后每个块得到一段 LLM 撰写的语义摘要
  （`NMG_SUMMARY_*` 环境变量，回退到 `NMG_JUDGE_*`；提示词版本固定在 manifest
  中），查询在块摘要 FTS 索引上路由，并把该块的逐字成员拉进上下文
  （`leafBlockRouting`）。一个更粗的节点摘要层级（每节点一份摘要，由其块摘要
  构建，按滞后刷新，至少 2 个已摘要块才够资格）在块命中之后加入节点 FTS 与
  节点向量路由。
  摘要文本本身是索引元数据，永不出现在候选中。
- **预算**：`topK = 20` 映射到排序证据预算；追加的链与摘要路由证据共享
  16,000 字符硬上限与 `1024 + 0.75 × primary evidence characters`（即
  1024 加主证据字符数的 0.75 倍）两者中的较小值。链披露最多
  选择 4 条 MMR 多样化链，最多跟随一个链交集跳与两个逻辑 DAG 记忆跳。Bridge
  默认 `secondPass: true`、`tieredDisclosure: true`、`maxTier: 3`、`graphHops: 1`、
  `expandChains: true`、`progressiveWarmDisclosure: false`。
- **摄取**：逐字消息存储（`statement = message.content`），无 LLM 取代判定器
  （确定性）。存储在 `.benchmarks/retrieval-stores/<dataset>/` 下持久化，当摄取
  manifest（dataset sha256 + 样本规则）匹配时跨运行复用；不匹配或
  `--full`/`--limit` 变化会触发一次干净的重摄取。数据集适配器把源特有日期归一化
  为 ISO 时间戳；Core 保持其严格的时间有效性契约。
- **数据集与固定样本**（来自 `.benchmarks/official/OmniMemEval/data/`）：
  - LoCoMo（`locomo/locomo10.json`）：全部 10 个用户；排除 category-5 对抗
    问题（与既有审计相同）。
  - LongMemEval-S（`longmemeval/longmemeval_s_cleaned.json`）：前 100 个问题
    （`--full` 为全部 500）。
  - BEAM（`beam/beam_100k.json`，20 会话 JSONL）：全部 20 个会话；
    `probing_questions` 的 Python 字面量被原生解析。
  - PersonaMem v2（`personamem_v2/benchmark/text/benchmark.csv`）：前 500 个问题
    （`--full` 为全部行）。每个被选中 persona 的官方 32K 聊天只摄取一次；系统
    指令被排除。
  - HaluMem Medium（`halumem/HaluMem-Medium.jsonl`）：前 2 个用户（`--full` 为
    全部用户）。这明确是一个**金标记忆检索臂**：官方 `memory_points` 即被索引的
    记录，问题证据也命名同一批记录。它测量的是在已抽取记忆集上的路由/排序，
    而不是抽取质量或对原始对话的改写匹配。

## 金标匹配

归一化与既有审计一致（小写、折叠非字母数字序列、去首尾空白）。一个候选携带两个
文本部分 —— `statement` 与有界逐字 `evidenceExcerpt` —— 命中任一部分即计一次。

- **LoCoMo / BEAM**（`gold-in-candidate`）：金标 = `evidence` dia_ids /
  `source_chat_ids` 的源消息文本；当该金标文本出现在候选某部分内部时命中。
- **LongMemEval**（`candidate-in-gold`）：金标 = 整个 `answer_session_ids` 会话
  块；当候选某部分出现在金标块内部时命中，即候选由一个金标会话支撑。
- **PersonaMem v2**（`gold-in-candidate`）：金标 = 官方
  `related_conversation_snippet` 中的每条消息；当该源消息出现在候选某部分内部时
  命中。
- **HaluMem**（`gold-in-candidate`）：金标 = 每条官方证据 `memory_content`；
  没有证据的问题（例如 Memory Boundary）仍留在报告中，但被排除在金标比率之外。

Namesakes 有意不在此适配：它是实体消解语料，缺少本排序感知检索打分器所需的
"查询到源证据"契约。它的拓扑评测仍留在 `evals/topology/` 下。

## 指标

对每条金标证据，报告同时记录它在排序检索前缀中的首个排名，以及在完整渲染窗口中的
首个位置。排序之后追加的链与块成员永不获得排名位置。

- **`R@k`（`recallAt`，k = 1, 5, 10, 20, 50, 100）**：证据级微平均召回率 —— 在排名
  `k` 以内命中的全部金标证据占比。在多金标题目上（如 BEAM 平均每题约 3.54 条、
  PersonaMem 约 3.04 条金标），Top-1 最多命中 1 条，因此 `R@1` 的理论上限约为
  `1 / G`，主要衡量多证据是否"找齐"。
- **`Any@k`（`anyAt`，最大档对应 `any@20`）**：问题级任一命中率 —— 在排名 `k` 以内
  至少命中 1 条金标证据的问题占比，衡量检索是否在截断窗口内"摸到边"。
- **`All@k`（`allAt`，最大档对应 `all@20`）**：问题级全量命中率 —— 全部所需金标证据
  均落入排名 `k` 以内的问题占比，决定多跳推理题能否拿到完整事实前提。
- **`MRR(Q)` / `MRR(G)`（`mrrQuestion`、`mrrGold`）**：分别对每题首个命中金标或每条
  金标计算倒数排名 `1 / rank` 的均值（未命中计 `0`），专注衡量榜首及最靠前位置的
  精确排序质量。
- **`nDCG@k`（`ndcgAt`，k = 10, 20）**：基于去重后的金标首中排名（通过
  `max(rank_j, j + 1)` 防止单条包含多事实的记忆重复推高得分，保证结果严格落在
  `[0, 1]`）计算的二元归一化折损累计增益，综合衡量多条不同证据是否被尽量集中排在
  LLM 上下文窗靠前位置。
- **`any@full` / `all@full`**：问题级别任一/全部金标是否在渲染窗口任意位置被找到，
  包括未获得排名的链/块补充。
- **`legacy evid`**：在渲染上下文上的证据召回，定义与既有审计相同，用于与历史数字
  交叉核对。
- **成本**：`meanContextChars` 与检索延迟 `mean / p50 / p95`（`latencyMs`）。

指标是分层的：LoCoMo 按类别，LongMemEval 与 HaluMem 按问题类型，BEAM 按能力，
PersonaMem 按偏好类型。

### 按测试目标选择指标

- **与业界通用指标的对应关系**：通用信息检索与 RAG（如 BEIR / MTEB / MS MARCO）
  最常使用 **`nDCG@10`**、**`MRR`** 与 **`Recall@k`**（`k = 5, 10, 20, 100`）；记忆
  评测在此基础上拆分出 **`Any@k`（Hit@k）** 与 **`All@k`**，用以区分单跳定位与多跳
  拼图场景。
- **粗召回与多通道融合上限**（`k = 50, 100`）：重点看 **`R@50`**、**`R@100`** 与
  `all@full`，验证向量、FTS5 与邻域扩展是否把足够证据送入重排池。
- **单跳问答与入口会话定位**（`k = 1..10`）：重点看 **`Any@5`**、**`Any@10`**、
  **`R@1`** 与 **`MRR(Q)`**，适合 LongMemEval 等单线索主导或定位核心会话的测试。
- **多跳推理、画像聚合与冲突更新**（`k = 10, 20`）：重点看 **`R@10`**、**`R@20`**、
  **`All@20`**、**`nDCG@10`** 与 **`nDCG@20`**，避免 BEAM、PersonaMem 与 HaluMem
  漏掉第 2、3 条线索却被 `Any@k` 掩盖。
- **计算图多目标自动化选优**：向 `findParetoOptimalGraphs` 传入
  `[R@1, R@20, R@100, MRR(Q), nDCG@20, -latencyMs.mean]`，以一次过滤找出质量与延迟
  无支配解。

## 输出与可复现性

报告落在 `evals/results/retrieval/<run-id>/`（被 git 忽略）：
`report.json`（manifest 加逐问题的 id/query/ranks，供抽查）与 `table.md`。
manifest 固定 dataset sha256、git commit（含 dirty 标记）、Node 与 NMG 版本、
检索模式与每个预算旋钮。

历史设置和命令见[归档检索指南](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/retrieval/README.zh-CN.md)。

## 环境

这些结果的环境和服务设置属于归档版的本地 runner。NMG HTTP 评测的向量和检索配置由选定的服务负责。

## 结果

正式运行结果以带日期的实验记录在 `docs/` 下：

- [Lexical tie ranking and neural ranker outcome](../../docs/experiments/retrieval-quality/lexical-tie-ranking-2026-09-30.md)
  —— 五数据集配对词法评测与失败的本地神经排序臂。

- [Retrieval-quality baseline 2026-08-16](../../docs/experiments/retrieval-quality/baseline-2026-08-16.md)
  —— 首次固定运行、词法臂、最初的三数据集协议。
- [Retrieval-quality hybrid arm 2026-08-16](../../docs/experiments/retrieval-quality/hybrid-2026-08-16.md)
  —— 三个数据集上的混合（外部嵌入）臂，外加两个臂的 LME 全 500 运行；含
  supersede-scan O(N²) 修复的测量。
- [Retrieval-quality summaries arm 2026-08-18](../../docs/experiments/retrieval-quality/summaries-2026-08-18.md)
  —— 叶子块摘要臂（`--summaries`）与叠加臂（`--hybrid --summaries`）；LoCoMo
  R@20 24.1% → 48.6%，BEAM 16.9% → 27.0%。
- [Retrieval-quality node-summary tier 2026-08-24](../../docs/experiments/retrieval-quality/node-summaries-2026-08-24.md)
  —— 节点摘要（由块摘要构建，滞后刷新）；BEAM 叠加 27.0% → 27.4%，LoCoMo 不受
  影响（退化的 1 块节点）。
- [Retrieval-quality cross-block chain pull 2026-08-24](../../docs/experiments/retrieval-quality/chains-2026-08-24.md)
  —— ±1 跳链邻居（边 + 位置）被拉进块成员预算；BEAM 27.4% → 27.7%，历史
  `any@full`（当时被误标为 `any@20`）65.1% → 80.0%，ctx 51.1k → 159.4k 字符。
- [Retrieval-quality activation-gated chain expansion 2026-08-25](../../docs/experiments/retrieval-quality/chain-activation-2026-08-25.md)
  —— 整链 `expandChains` 被激活门控取代（邻近度 + 查询重叠 + 重要性，硬上限）；
  BEAM ctx 159.4k → 93.9k 字符，约为覆盖率增益的 40%；event_ordering 回到无链
  水平。
