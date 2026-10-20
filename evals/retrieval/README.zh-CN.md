# 形式化检索质量 benchmark

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

一条命令、一份固定协议、一张表：`npm run eval:retrieval` 把自动回忆、
`nmg_search`、Pi 级 adapter、daemon 与 OmniMemEval 桥共用的 NMG 产品检索与
Agent Surface 当作纯 retriever 来测量，不需要答案模型或判定器。数据集适配与
打分仍归 benchmark 所有；候选生成、投影、精确证据、链、脱敏与显示预算不归它。

既有的审计脚本（`evals/omnimemeval/research/audits/audit-*-retrieval.*`）测量
渲染后上下文的文本覆盖率，并丢失排序信息。本 runner 保留排序：每条金标证据
记录它在返回候选中的首次命中排名。

## 协议（固定）

- **检索路径**：进程内 `OmniMemEvalBridge` → 共享 `searchMemoryContext` →
  `store.searchContext` → 共享的精确证据 Agent Surface。没有 benchmark 本地的
  检索或上下文渲染器，也没有 Python 子进程。
- **检索模式**：必须使用配置的产品路径 —— 记录嵌入加上有界的 surface-anchor
  通道 —— 其 `indexId` 记录在 manifest 中。普通词级 FTS 仍是零配置的产品回退，
  不是 benchmark 臂。surface anchor 通过一个无内容的 Unicode 归一化 trigram
  索引，保留显式引号短语、路径、版本、ID、错误码、类代码标识符与 recall
  triggers；纯散文不会仅仅因为英文词与金标答案重叠就变成 anchor。
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

- `R@k`（k = 1, 5, 10, 20）：在排名 k 以内命中的金标证据占比。
- `any@20` / `all@20`：问题级别任一/全部金标是否在排序前缀内命中。
- `any@full` / `all@full`：问题级别任一/全部金标是否在渲染窗口任意位置被找到，
  包括未获得排名的链/块补充。
- `MRR(Q)`：每个问题首个命中金标的平均倒数排名。
- `legacy evid`：在渲染上下文上的证据召回，定义与既有审计相同，用于与历史数字
  交叉核对。
- 成本：平均渲染上下文字符数；检索延迟 p50/p95。

指标是分层的：LoCoMo 按类别，LongMemEval 与 HaluMem 按问题类型，BEAM 按能力，
PersonaMem 按偏好类型。

## 输出与可复现性

报告落在 `evals/results/retrieval/<run-id>/`（被 git 忽略）：
`report.json`（manifest 加逐问题的 id/query/ranks，供抽查）与 `table.md`。
manifest 固定 dataset sha256、git commit（含 dirty 标记）、Node 与 NMG 版本、
检索模式与每个预算旋钮。

```powershell
npm run eval:retrieval                          # all five datasets, pinned samples
npm run eval:retrieval -- --dataset locomo      # one dataset
npm run eval:retrieval -- --dataset personamem,halumem
npm run eval:retrieval -- --dataset longmemeval --full
npm run eval:retrieval -- --summaries           # leaf-block summary arm (LLM endpoint)
```

在数据与配置不变的情况下重跑会复用已摄取的存储，并逐位复现指标（只有墙钟延迟
不同）。

## 环境

规范 runner：`npm run eval:retrieval -- [options]`。TypeScript runner 加载
`.env` 与可选的 `.env.nmg-bgefix`，然后在运行之前检查所配置的嵌入服务。package
脚本还设置 LME 堆上限。benchmark 调用路径中没有 Shell 启动器。

两个外部服务，都由环境变量配置（NMG 不自带模型）：

- **嵌入（产品/摘要臂）**：BGE-small-en-v1.5，由唯一服务入口
  `evals/omnimemeval/bge_server.py` 在 `127.0.0.1:8000` 提供。
  GPU 设置（一次性，PyTorch CUDA wheel 约 3GB，venv 位于被 git 忽略的
  `.benchmarks/bge-venv`）：
  ```bash
  uv venv .benchmarks/bge-venv
  uv pip install --python .benchmarks/bge-venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cu126
  uv pip install --python .benchmarks/bge-venv/Scripts/python.exe sentence-transformers fastapi "uvicorn[standard]"
  .benchmarks/bge-venv/Scripts/python.exe evals/omnimemeval/bge_server.py --device cuda
  ```
  `uv run --with` 在 Windows 上可能解析出 PyPI 的纯 CPU torch，因此它不是受支持
  的启动路径。请直接调用准备好的解释器。不给 `--device` 时，服务在可见时选
  CUDA，否则选 CPU；`--device cuda` 与 `--device cpu` 强制该选择。显式 CUDA 失败
  时会报错而不是静默回退。`/health` 报告实际的 Python、PyTorch、设备与动态批处理
  状态。并发请求进入一个有界队列，在 `BGE_BATCH_WAIT_MS`（默认 5 ms）之后合并到
  最多 `BGE_MAX_BATCH_TEXTS`（默认 256）；`BGE_MAX_QUEUE_REQUESTS` 限定准入。
- **LLM（摘要臂 / 写入时判定器）**：默认是 OpenCode **Go** 订阅端点
  `https://opencode.ai/zen/go/v1` 配 `deepseek-v4-flash`（`.env` 中的
  `OPENCODE_API_KEY`；包含在 Go 模型列表中，零数据保留）。Go 配额：每 5 小时
  $12 / 每周 $30 / 每月 $60；deepseek-v4-flash 约每 5 小时 7,600 次请求。
  配额耗尽时的回退：DeepSeek 官方（
  `NMG_SUMMARY_BASE_URL=https://api.deepseek.com`、
  `NMG_SUMMARY_MODEL=deepseek-chat`、`NMG_SUMMARY_API_KEY=$DEEPSEEK_API_KEY`）。
  注意：Go 网关当前忽略 `thinking: {type: "disabled"}` —— 响应仍带 `reasoning`
  字段，因此每次调用的延迟/成本高于关闭 thinking 的官方端点。

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
