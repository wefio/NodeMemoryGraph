# NMG 评测策略

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

NMG 使用两类互补的测试：

- 确定性工程用例检测实现回归；
- 公开记忆 benchmark 衡量系统是否改善了 agent 行为。

在公开用户记忆评测上，NMG 优选
[OmniMemEval](https://github.com/MemTensor/OmniMemEval) 作为上游的多
benchmark harness。它的用户记忆赛道已经为 LongMemEval、LoCoMo、BEAM、
PersonaMem v2 与 HaluMem 提供了同一套摄取、检索、作答与打分流水线。NMG
应当通过一个薄的客户端适配器接入，而不是为每个 benchmark 长期维护一套执行
流水线。

公开 benchmark 分数不能替代确定性核心套件。一个记忆系统可以正确回答
benchmark 问题，同时破坏来源、超出检索预算，或者不必要地重建索引。

## 布局

- `omnimemeval/` 是维护中的公开套件适配器及其单一官方执行入口。它的
  `research/` 子树存放非默认的探针、审计与消融。
- `benchmarks/`、`longmemeval/`、`locomo/`、`personamem/` 与 `beam/` 保留
  彼此独立的本地 matched agent runner。它们测试 harness 触发的回忆；它们
  不是互相竞争的公开数据流水线。
- `controller*`、`topology/`、`retrieval/`、`consolidation/`、`disclosure/`、
  `reasoning-workspace/` 以及规模/性能目录是聚焦的研究族。请使用它们各自的
  本地 README 或 package 脚本，不要把目录根当作命令面。

只有稳定的入口点才属于 `package.json`。一次性脚本放在它的证据族旁边，且
不得静默定义 benchmark 或产品策略。

## Pi Agent 集成用例

跑 `npm run eval:agents` 得到全新进程的 Pi+NMG 写/读用例。该 runner 从进程
环境或项目 `.env` 加载 `DEEPSEEK_API_KEY`，按用例隔离 Pi 身份与 NMG 存储，
并在凭据不可用时快速失败。该套件同时包含依赖记忆的问题与普通的、不依赖记忆
的工作。no-memory 用例必须在不调用 `nmg_search` 或 `nmg_get` 的情况下给出
正确答案，因此 NMG 既被检查回忆能力，也被检查是否造成干扰。

## HaluMem 操作级抽取与更新审计

HaluMem 与 OmniMemEval 的 QA runner 分开评测，因为它的官方操作协议会暴露
写入集与更新检索集。签入仓库的报告包含两个 matched 自然切片，用于比较原始
消息接入与执行 NMG 持久写入策略的 Agent。总体干扰准确率始终伴随其逐条决策
一起报告，因为官方判定器可以在注入措辞并未被存储的情况下接受一条带标注的
干扰推断。

```powershell
npm run eval:halumem:prepare -- --users 1 --session-start 6 --sessions 1 --reset
npm run eval:halumem:score -- --users 1 --workers 4
npm run eval:halumem:promotion-audit -- --user 1 --origin-start 5 `
  --origin-end 6 --observe-through 11 --reset 1
```

`promotion-audit` 使用真实的 STG/posterior 路径。它只接纳带精确用户证据的
候选，向之后的会话索取独立支持或反驳，核验返回的用户摘录，并且只导出通过
Core 所配置 consolidation 闸门的候选。HaluMem 不含工具成功或答案被使用的
结果；一次零合格运行是 benchmark 覆盖度的结果，不是削弱产品闸门的理由。

`prepare` 先重放更早的会话，再输出一个有界的打分切片，并写入官方的
`extracted_memories` / `memories_from_system` 字段。`score` 复用 HaluMem 的
官方提示词与判定函数，跳过 QA，并且只聚合分母非零的指标。除了上游要求的围栏
JSON 之外，DeepSeek 合法的裸 JSON 也被接受。结果与存储以
`.benchmarks/halumem-nmg/` 下被忽略的形式存在；见
`docs/experiments/halumem-operation-evaluation-2026-08-11.md`。

做 harness 策略消融时，先跑
`npm run eval:halumem:agent-extract -- --users 1 --through-session 6`，再把它的
JSONL 通过 `--agent-extractions` 传给 `prepare`。抽取器只看到对话与当前的
NMG 记忆策略。它永远拿不到金标记忆点或问题，其缓存键包含策略哈希与模型。

## 真实使用控制器标定

可选的 Pi shadow 桥会写有界本地事件。用彼此独立的命令来审计与标定它们：

```powershell
npm run eval:controller-shadow
npm run eval:controller-dataset -- --compact
npm run eval:controller-calibrate -- --compact
```

新的检索事件包含决策时刻所用的、确切的带版本控制器特征快照与 Active Graph
硬预算信封。数据集构建器拒绝无法重放这些输入的旧带标注行。标定使用按时间
顺序的语义任务划分，并写出候选制品，其中包含特征协议、数据窗口、生效超参、
留出指标、源日志指纹与当前状态回滚指纹。它从不激活或覆盖运行时策略。当独立
标注的真实使用行不足时，该命令以显式 blocker 退出，而不是拿 benchmark 或
合成标签来训练。

紧凑形式报告行/划分/任务计数与 blocker，不把每条重放行倒进终端。确实需要完整
连接数据集做审计或导出时，才省略 `--compact`。

matched benchmark 打分使用同一条失败即关闭的规则。每条官方打分行保留
`taskScore`、可为空的二元 `taskSuccess`、类型化/可为空的证据充分性、Pi 工具
轮次、provider token 与答案延迟。完整的因果臂比较会输出
`matchedProduct.metrics`；标签不完整、行不成对、或候选是观察性的，都会输出
blocker 与 `metrics: null`。要把一份合法的打分制品附加到离线控制器闸门运行：

```powershell
$env:NMG_CONTROLLER_MATCHED_PRODUCT_REPORT = "evals/.../official-score.json"
npm run eval:controller -- locomo 4
```

这里只导入类型化指标。它不会把 benchmark 行合并进自然 shadow 训练数据集，
并且仅 shadow 的制品会被拒绝，因为候选没有影响排序。

## 实验日志

本文件刻意只保留稳定的指引与原则。原始运行矩阵、根因分析与协议笔记存放在
`docs/` 下带日期的独立日志里（此处建索引，使新工作能找到既有证据）：

- `docs/experiments/longmemeval-profile-regression-2026-08-03.md` —— LongMemEval
  基线的 "drift"（94.15% → 76.0%）根因定位到 embedding profile 配置漂移；
  BGE 模型现在自动选择 bge-en 提示词模板。修正配置下的完整 fixed-vs-dynamic
  矩阵：94.15%/87.95%/81.2% 对 95.19%/89.71%/82.3%
  （any-evidence recall / overall / answer accuracy）。
- `docs/experiments/qpp-evidence-signal-experiments-2026-08-02.md` —— QPP 触发
  信号审计（top1 gap、cohesion、LLM sufficiency）与 strong-hit 评测。
- `docs/experiments/locomo-evidence-mode-signal-2026-08-02.md` —— LoCoMo 官方
  search-only 协议对齐与 evidence-mode 信号协议。
- `docs/experiments/qpp2-local-probe-experiment-2026-07-29.md` —— 本地 QPP2/elbow 探针。
- `docs/design/daemon-lifecycle-design.md` —— daemon 生命周期加固（超时、
  store 上限作为警告、重启保真）及其验收测试。
- `docs/design/llm-sufficiency-recall-design.md` —— LLM-sufficiency 回忆设计。
- `docs/experiments/lme-recall-headers-2026-08-04.md` —— recall-header 细化经
  核实仅为格式变化（94.15/87.95/82.67 不变；answer acc 82.3%）。

## 统一 OmniMemEval 运行

LongMemEval、LoCoMo、BEAM、PersonaMem v2 与 HaluMem 使用同一个 NMG 入口点。
稳定的运行参数保存在 `evals/omnimemeval/benchmark.config.json`，而不是在每条
命令行上重建。该入口点拥有环境编码、生成的运行身份与续跑校验；被固定版本的
OmniMemEval 脚本继续拥有各数据集自己的解析、提示词、打分、检查点实现与报告
schema。

```powershell
# Complete pipeline using the checked-in configuration.
npm run benchmark:omni -- longmemeval

# Use a copied config for a bounded or one-off experiment.
npm run benchmark:omni -- beam --config evals/omnimemeval/canary.config.json

# Resume only from an exact old result directory.
npm run benchmark:omni -- --resume `
  .benchmarks/official/OmniMemEval/results/lme/nmg-fixed20-rerun

# Validate the resolved official command without running it.
npm run benchmark:omni -- personamem-v2 --dry-run
```

签入仓库的配置目前记录 `workers=16`、`llm-workers=16`、`top-k=20` 与
`num-runs=1`；仅套件使用的官方参数存在套件名旁边。请有意识地修改该文件或
选择一份复制的配置，而不是再长出一个 CLI 参数面。OmniMemEval 隔离 benchmark
用户存储，因此摄取/检索与作答/判定各自使用一个有界的 16-worker 池，而不是
为每个条目生成数量不设限的进程。
该 runner 从不杀掉 Pi、NMG daemon、嵌入服务或无关的 Python 进程。外部服务
仍是调用方的责任。

续跑是失败即关闭的：目录必须位于所选官方结果树内，记录 `LIB=nmg` 与版本，
并与生效配置一致。套件与版本由 runner 推断，而不是由调用方重复。不安全的
生命周期标志不会被重放。数据集专属审计仍是独立命令；它们不改变执行，也不
改变官方打分。

存储：用户存储（`omnimemeval-nmg/*.sqlite`）以 `sha256(userId)` 为键，而
userId 内嵌版本标签，因此每次运行都会创建约 500 个全新的约 12 MB 存储，且
永不复用。嵌入是可共享、可复用的部分：所有评测共用
`.benchmarks/shared-embedding-cache.sqlite` 这一份按内容哈希的缓存（键为
`(model, kind, text_hash)`，因此同一模型下的同一文本在任何地方都映射到同一
向量）。**边界 —— 不要新建按评测划分的嵌入缓存。** `OmniMemEvalBridge` 与
探针/审计脚本默认使用共享缓存；只有在确实需要隔离时才传显式的
`embeddingCachePath`（或硬编码路径），并在完成时把其内容折回共享缓存
（`evals/omnimemeval/merge-embedding-caches.mjs`）。合并前测得：27% 的缓存行
（248k）在各评测变体之间重复 —— 合并后的共享缓存是唯一事实来源。运行结束后
用 `--prune-stores` 丢弃除本次运行之外的所有存储（摄取会重建它们；真正让
重跑变便宜的是共享嵌入缓存）。

## 一次性测量脚本

每个脚本测量一个属性，且都不在 CI 中运行。它们把 JSON 或文本写到 stdout，
想保留数字就自行重定向。

| Command                                      | Measures                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run eval:concurrency`                   | Concurrent writers across sessions into a temporary store, then one read per session; prints write/read latency p50, p95, p99. |
| `npm run eval:perf-overhead`                 | `searchContext` with performance timing on and off, at two store sizes, plus a phase profile from one run.                     |
| `npm run eval:recall-compression`            | The same recall payload in the recall representations, compared by context size.                                               |
| `npm run benchmark:merge:longmem`            | Merges LongMemEval shard result files into one result set (`merge-longmemeval-shards.ts`).                                     |
| `npm run benchmark:ablate:reverse-retrieval` | The reverse-retrieval ablation; its arms and runner are described in `omnimemeval/README.md`.                                  |

## Benchmark 角色

| Suite               | Primary role                  | NMG mechanisms under test                                                                          |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| NMG core cases      | Fast deterministic regression | storage, provenance, STG/LTG lifecycle, Active Graph budgets, deletion and cache invalidation      |
| LongMemEval         | Main development gate         | extraction, multi-session reasoning, updates, temporal reasoning and abstention                    |
| PersonaMem          | User-memory gate              | automatic fact/preference/constraint writes, evolving profiles, scope and current-state selection  |
| LoCoMo              | Relational-memory gate        | temporal and causal links, multi-hop evidence, node-to-leaf expansion and event summarization      |
| BEAM                | Scale and cache-pressure gate | progressive retrieval, cache misses, maintenance cost and growth from 128K through 10M tokens      |
| Reasoning workspace | Lab scratchpad gate           | explicit task-state retention, Pi compaction recovery, overhead, and unsupported scratchpad claims |
| SkillOpt policy     | Offline policy decision gate  | answer/expand/stop, noise folding, held-out policy selection, matched Pi promotion                 |

各套件分别报告。它们的分数不得被平均成一个数字，因为它们测量的是不同的
分布与失败模式。

## 官方协议 benchmark 命令

下面这些 npm 入口点是不依赖 README 的复现面。数据放置与覆盖项记录在 `evals/`
下各 adapter 的 README 中；`validate` 解析官方本地数据并在不调用模型的情况下
报告分层样本。

```bash
# LongMemEval development comparison (also see "Reproducible LongMemEval runs")
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
npm run eval:longmem -- matched 1
npm run benchmark:score:longmem -- <result-directory>

# LoCoMo / PersonaMem / BEAM share one runner and the same matched modes
npm run eval:locomo -- validate 1
npm run eval:personamem -- validate 1
npm run eval:beam -- validate 1

npm run eval:locomo -- matched 1
npm run eval:personamem -- matched 1
npm run eval:beam -- matched 1
npm run benchmark:score -- <locomo|personamem|beam> <result-directory>

# Deterministic invariants and ablations (no model call)
npm run eval:quality
npm run eval:adaptive

# Scale ladder: 100 / 1K / 10K / 100K memories (see evals/scale/README.md)
npm run eval:scale
```

matched 行保留确切的 Pi 工具轮次、工具调用、provider token 用量与答案延迟。
官方打分额外给出无损的 `rowScore`；当上游协议没有定义任务成功与证据充分性时，
它们保持为 `null`。打分制品还包含一份失败即关闭的 `matchedProduct` 审计。
当前的 `nmg-shadow` 臂不改变排序，因此其审计有意报出
`candidate_does_not_affect_ranking`，而不是产品闸门指标。

更早的 LongMemEval 诊断消融比较了 raw-session、flat-hybrid、Lite 与 Graph
变体。它们早于严格三臂协议，仅作为历史机制证据保留，不是当前的 matched-gate
或 benchmark 主张。

## SkillOpt policy Lab

`evals/skillopt` 只导出已去标识的可观察检索状态与显式决策标签。它从不导出
记忆陈述或证据。官方 SkillOpt 优化器仍是外部被忽略的 checkout；NMG 安装一个
薄适配器，而不是把它 vendor 进来或重新实现。

```powershell
npm run eval:skillopt:install
npm run eval:skillopt:export
```

在自然的 train/validation/test 最小量满足之前，导出器是失败即关闭的。只有在
做文件布局/适配器冒烟时才用 `--allow-insufficient`。见
`docs/design/skillopt-policy-optimization.md`。

## 可复现的官方协议工作流

NMG 把预测生成与 benchmark 打分分开。reader 运行写出 `report.json` 与
`predictions.jsonl`；之后的打分命令写出 `official-score.json`，而无需重跑
reader 模型。

```powershell
npm run benchmark:setup
npm run benchmark:validate

npm run eval:locomo -- matched 1
npm run benchmark:score -- locomo <result-directory>

npm run eval:longmem -- matched 1
npm run benchmark:score:longmem -- <result-directory>
```

### 本地分数快照

运行目录被忽略，因此打分还会在
`evals/snapshots/<benchmark>/<timestamp>_<revision>.json` 下写一份小快照。
快照与原始日志是本地运行时制品，被 Git 忽略。

每份快照保存各模式分数，以及解读它们所需的来源信息：代码版本、样本指纹、
判定模型、协议、样本量，和一份已解析的非机密参数块。该参数块记录 QPP1、
QPP2、retained mass、推荐模式、渐进通过设置、QPP 阈值、graph-hop 覆盖，以及
嵌入的模型/profile/维度/批大小。API key、provider 凭据与机器专属数据路径
永不写入。
只有当两份快照的 `sampleFingerprint` 相同时它们才可比较；指纹不同意味着两次
运行覆盖了不同用例，而不是质量发生了改变。

快照支持本地回归比较。任何要写进设计文档的结果都必须被复制进一份小的、经人工
审阅的摘要，并带上其样本指纹与协议；原始运行输出永不提交。

`benchmark:setup` 在被忽略的 `.benchmarks/official` 下按
`evals/official/upstreams.json` 中的提交检出四个官方仓库。它还会为官方打分器
创建一个由 uv 管理的隔离 Python 3.11 环境；benchmark 代码不会被复制进 NMG
core。

OmniMemEval 与本地 Pi runner 测量不同的边界。OmniMemEval 的用户记忆赛道总是
调用后端的 `search()` 方法，因此它是首选的 backend-retrieval harness，应当
拥有公开数据集的解析、重放、检查点与报告生成。本地 matched runner 仍是 Pi
集成闸门，因为它测量 harness 是否触发回忆、以及 agent 是否使用返回的证据。
即使 OmniMemEval 达到对等，它也不会退役。

由判定器支撑的协议目前用 `deepseek/deepseek-v4-flash` 替代上游的专有判定器。
这些输出被标注为 `official-protocol/deepseek-judge`；LoCoMo 与 PersonaMem 被
标注为 `official-protocol/deterministic`。所有实验性输出都保留
`leaderboardComparable: false`。LoCoMo 使用其官方确定性 QA 与检索函数，
PersonaMem 使用其官方选项抽取规则，BEAM 使用其 rubric 量表。BEAM 的
`event_ordering` 使用官方归一化 Kendall tau-b 聚合，而不是 rubric 分数平均。

## Matched 能力闸门

默认的 `matched` 命令恰好运行三个臂：

1. `no-memory`：不带 NMG 扩展的 Pi；
2. `nmg-deterministic`：关闭控制器 shadow 的确定性 NMG；
3. `nmg-shadow`：同样的确定性 NMG 检索，开启控制器打分与遥测，但不改变排序。

每个 NMG 臂都从同一份种子数据库的独立副本开始。三个臂使用相同的 reader 模型、
thinking 等级、用户提示词、问题 ID 与官方打分器。runner 为每行记录提示词哈希。
用 `NMG_BENCH_REPEATS` 设置重复的随机试验；一次重复只是冒烟信号。

其他模式（`raw-session`、`flat-hybrid`、`nmg-nodes` 与 `nmg-graph`）仍是
诊断消融，不属于严格三臂闸门。

独立的 backend 能力消融在同一个共享样本/语料与预算上运行设计清单里的四个
架构臂：

```powershell
npm run eval:longmem -- backend-ablation 1
```

其臂为 `no-memory`、`flat-hybrid`、`nmg-lite`（`graphHops=0`）与
`nmg-graph`（`graphHops=1`）。每行同时记录完整的生效提示词哈希，以及覆盖不变
问题/指令的 `taskPromptHash`。这是匹配的本地开发比较，不是 leaderboard 运行。

## 必须测量的项

### 能力

- 官方答案分数与分类别分数；
- 存在证据标签时的证据 Recall@K 与 Precision@K；
- 知识更新、错误作用域与陈旧记忆的错误率；
- 弃答准确率与虚假记忆注入率；
- 适用时的偏好遵循与冲突消解准确率。

### 成本

- 记忆后端读取的记录数与证据 token 数；
- 注入 reader 的 token 数；
- 访问的图节点、边、跳数、本地层级与扩展步数；
- 查询、嵌入、重排与端到端 P50/P95 延迟；
- 写入、索引、consolidation 与重建工作量。

### 纵向行为

- 随总历史增长时的检索成本与质量；
- STG 驻留与晋升延迟；
- 错误 consolidation 与错误节点合并率；
- 缓存命中率与冷查询惩罚；
- 摘要命中但缺失叶子证据；
- 每个追加会话的索引工作量。

每条结果都记录模型标识、模型参数、代码版本、数据集版本、固定问题 ID、受支持
时的随机种子、并发、预算与重试策略。随机 reader/判定器实验需要重复运行，否则
必须标注为开发信号而非能力主张。

做命令级冒烟测试时，把 `NMG_BENCH_CASE` 设为所选分层样本中的一个 ID。
`NMG_BENCH_CONCURRENCY`、`NMG_BENCH_TIMEOUT_MS` 与
`NMG_BENCH_CONTEXT_CHARS` 控制共享 runner。

每臂启动的 NMG daemon 自我限制：`NMG_DAEMON_IDLE_TIMEOUT_MS`（默认
`300000`，`<=0` 关闭）使孤立 daemon 在这么多毫秒无请求后退出，
`NMG_DAEMON_LIMIT`（默认 `32`，`<=0` 关闭）在活 daemon 数超过上限时于
stderr 警告，然后才生成新的 daemon。见
[daemon-lifecycle-design.md](../docs/design/daemon-lifecycle-design.md)。

`validate` 在不调用模型的情况下解析与采样。一次 matched 运行对每个选中用例
执行三次 reader 实验，可能耗时数分钟；runner 把逐用例/逐模式的进度写到 stderr。

## 推进顺序

1. **已完成：** 给 OmniMemEval 的用户记忆客户端注册表加上一个薄的 NMG 客户端。
   它只能实现 harness 契约（`add`、`search` 与按用户清理）并调用稳定的 NMG
   服务/CLI 边界。
2. **冒烟已完成：** 在改变检索行为之前，把当前固定 LongMemEval 样本通过
   OmniMemEval 的 search-only 重放一遍。这是 backend 对等闸门；它不替代 Pi
   matched 闸门。
3. 用同一个适配器跑 PersonaMem v2、LoCoMo 与 BEAM。只有在头四个套件可复现
   之后才加 HaluMem。
4. BEAM 规模运行保持分阶段：128K，然后 500K，只有当更小层级尚未暴露同一失败时
   才到 1M/10M。
5. 只有在分数、样本、来源与成本遥测对等被证明之后，才退役重复的公开数据集
   解析与打分。保留小型本地 Pi 端到端 runner。

### 2026 年七月 LongMemEval search-only 冒烟

被固定版本的 OmniMemEval checkout 在 Pi 开发运行所用的同样七个固定 LongMemEval
问题上成功跑通了 NMG 适配器。第一轮强制检索使七个用例中的五个变得可合理作答。
诊断显示未经验证的 assistant 回复与英文疑问词挤占了用户证据。NMG 现在提供一个
可选的 source-actor 过滤器；适配器把用户记忆问题默认限定为用户断言，并在显式
的 assistant/先前对话回忆时回退到两个 actor。词法排序也会忽略常见英文疑问词/
功能词。

在固定样本上，这找回了两条时间证据记录（2/2），保留了更新记录（2/2）、偏好
证据（1/1）与 assistant 证据（1/1）。衣物计数从两条重复的靴子提及改善为互补的
靴子与西装外套证据，但相对官方证据列表仍只有 2/3。检索延迟保持在约 126–166 ms。
上下文通常是 2.8–4.1k 字符；那个较长的 assistant 日程用例达到 7.5k。

从默认 legacy 路径改为混合 FTS 的受控变更被否决。它在两个欠缺用例上没有找回
缺失证据，把上下文扩大到 7.2–7.9k 字符，并把该时间查询推到 2.04 s。这表明
无差别的候选扩张不是下一步修复；多证据聚合与时间覆盖需要针对性工作。

在 Windows 上要设置 `PYTHONUTF8=1`，因为上游进度输出包含 emoji。
适配器安装器必须补丁 OmniMemEval 的中心客户端注册表、通用文本检索分发器与
conversation-ID 白名单；这些注册目前在上游是分开维护的。

OmniMemEval 的 agent-memory 赛道不是初始集成目标。它目前耦合于
AgentBench/OpenClaw 生命周期插件，而 NMG 的运行时集成目标是 Pi。因此 Pi 端到端
测试保持本地，直到有证据支持一个小型的运行时中立插件协议。

适配器应把官方数据翻译成一个小型的共享用例/结果 schema，而不是把各 benchmark
专属假设复制进 NMG core。

## NMG 专属消融

能力实验至少应隔离：

- STG 关闭与开启；
- 节点/叶子检索与扁平记录检索；
- Active Graph 投影与无界上下文注入；
- 图扩展关闭与开启；
- agent 确认的使用反馈关闭与开启；
- consolidation 关闭与开启；
- 纯词法、纯向量与混合路由。

目的是把增益归因到机制。当同一个结果来自更小的检索臂时，更大的 NMG 配置不被
认为更好。

## 适配器校验

用 `npm run benchmark:validate` 作为本地可用官方数据的权威检查。不要在本文件中
保留临时的模型分数：当采样、提示词、检索策略或模型版本变化时它们就会过期。
每个 benchmark 客户端都使用 `--no-extensions` 并且至多加载一个显式 NMG 实例；
no-memory 对照一个都不加载。

## Consolidation 策略审计

`npm run eval:consolidation` 用 LoCoMo 的官方证据 ID 作为独立正任务结果，来审计
STG → LTG 的 posterior 闸门及其保留滞后。它报告覆盖率与"矛盾到撤回"的压力，
且不调用 LLM。证据列表中的缺席永不当作负面标签，因此该审计有意不报告错误晋升
的精确率。见 `docs/experiments/consolidation-evaluation-2026-08-09.md`。

对普通产品数据，运行独立的只读证据清单：

```powershell
npm run eval:natural-maintenance -- --project-dir C:/path/to/project
```

它以只读方式打开权威 LTG 与项目 STG 的 SQLite 文件，报告 claim 结果/posterior、
STG 晋升与保留候选、已物化的 STG→LTG 标记、维护积压、拓扑提案、身份闸门理由、
transform 与回滚。它从不记录结果、运行维护、晋升记忆或执行合并。缺失的证据以
显式 `evidenceGaps` 列表输出；一次干净的命令运行不是"自然精确率或可逆性已被
验证"的证据。审计多于一个项目本地 STG 时使用可重复的 `--stg` 参数。
`maintenanceBacklog` 区分本地到期节点与分布式全局压力，因此高总数不会被误当成
一个热点节点。

## 拓扑身份闸门审计

`npm run eval:topology` 用 LoCoMo 稳定的说话人身份构造同人早晚节点对与跨人
负对。它测量生产中的 `same_as` 评估闸门、竞争身份撤回，以及"评估永不改变拓扑"
这一不变量。候选生成被刻意保持不变，因此结果不是别名消解或端到端自动合并的
分数。见 `docs/experiments/topology-gate-evaluation-2026-08-09.md`。

`npm run eval:topology:bpid` 增加多字段身份硬负例，
`npm run eval:topology:namesakes` 则可选地读取官方 CC BY 4.0 Namesakes
Entities JSONL，以测量类别名正例召回与对"同名但指向不同实体"的拒绝。两者都
报告候选生成曲线且保持只读：两个分数都不被允许授权一次合并。Namesakes 数据
属于 `.benchmarks/namesakes/data/` 且不提交。见
`docs/experiments/topology-bpid-evaluation-2026-08-09.md` 与
`docs/experiments/topology-namesakes-evaluation.md`。

官方 LoCoMo 打分器使用 `npm run benchmark:setup` 创建的环境。如果该 uv 管理的
解释器在当前 sandbox 里无法执行，把 `NMG_BENCHMARK_PYTHON` 设为一个兼容的、
含固定打分器依赖的 Python 环境。NMG 使用这一个显式路径；它不会在无关的
Python 安装之间静默逐级尝试。
