# Namesakes alias／homonym 拓扑评测

[English](namesakes-evaluation-2026-08-18.md) | [简体中文](namesakes-evaluation-2026-08-18.zh-CN.md) · [术语](namesakes-evaluation-2026-08-18.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史记录，其配置、测量结果和实现状态不是当前测试回执，也不授权默认策略。本轮未重跑实验，未独立复核原始运行产物。

## 目的

LoCoMo 拓扑审计衡量自然对话中的 candidate 噪声，BPID 衡量独立标注的 profile hard negative。两者都不直接包含标注好的 alias 提及与指向不同实体的同名引用。可选的 Namesakes adapter 用来填补这个更窄的证据缺口。

官方 [Namesakes 数据集](https://figshare.com/articles/dataset/Namesakes/17009105) 含 4,148 个歧义 Wikipedia 实体，以及来自 Wikipedia 与新闻的 58,862 条 mention。其 Entities split 把每条 mention 标注为 `Same`（即该页面实体）或 `Other`（同名或近似名的不同实体）。发布协议为 CC BY 4.0。完整的多文件发布约 216 MB；本评测只下载 10,033,495 字节的 Entities JSONL。

## 协议

把官方 `Namesakes_entities.jsonl` 放到：

```text
.benchmarks/namesakes/data/Namesakes_entities.jsonl
```

然后运行：

```powershell
npm run eval:topology:namesakes
```

做有界 smoke run：

```powershell
$env:NMG_NAMESAKES_MAX_ENTITIES = "200"
npm run eval:topology:namesakes
```

adapter 以流式方式读取 JSONL，因此不会把完整发布保留在内存中。对每个至少有两条正向 mention 的实体，第一条 `Same` mention 的上下文构成确定性的本地 prototype。其余的 `Same` 与 `Other` 上下文用 NMG 的本地 hashing embedder 打分。gold label 用于确定 prototype 资格并选出第一条 `Same` prototype；candidate 上下文打分不使用该 candidate 的标签，而在之后用标签评估。因此 prototype 构造有 gold 引导，不是完全无标签。

报告包含：

- 在一条固定且完整报告的阈值曲线上的 candidate precision 与 positive recall；
- 规范化表面形式与页面标题不同的正向 mention（类 alias 的正样本）上的 recall；
- 对规范化表面形式与页面标题完全相同的 `Other` mention（同名 hard negative）的拒绝情况；
- 一个流式反事实：把每条非 anchor mention 视为一次在线到达，报告该分数会多频繁地发出 proposal，并统计若把错误 proposal actuate 会共置多少外来记录。

没有任何阈值被复制进 NMG 配置。adapter 从不创建、提交、接受或 actuate 拓扑 proposal。它的结果是 candidate 生成证据，不是已校准的身份置信度。

### 配对 Agent 归因探针

结构性审计由一个小的固定下游探针补充：

```powershell
$env:NMG_NAMESAKES_AGENT_CASES = "10"
$env:NMG_NAMESAKES_AGENT_REPEATS = "5"
$env:NMG_NAMESAKES_AGENT_CONCURRENCY = "2"
npm run eval:topology:namesakes-agent
```

对每个被选实体，探针依据官方标签形成两个组：

- `clean`：最多三条 `Same` mention 上下文；
- `contaminated`：完全相同的前缀，再加一条来自不同官方实体行的记录。只有当某条 `Other` mention 的规范化文本唯一对应到那一行的标题时才使用它；而该外来行自身的 `Same` 上下文必须对目标 anchor 得分至少 `0.7`。

Agent 收到目标标题与不透明记录 ID，然后返回它归因给该实体的 ID。`Same`／`Other` 标签从不暴露给模型，并提供精确的、非 LLM 的评分键。组的顺序被确定性地平衡。最多启动两个 Pi RPC worker，每个 worker 复用一个进程、为每组开始一个新 session。响应在 `.benchmarks/namesakes/agent-cache/` 下做内容寻址，因此相同的重跑不会再调用 provider。固定的 prompt 前缀也让 provider 侧的 prefix cache 得以复用。

## 完整官方数据结果（2026-08-11）

结果章节标为 2026-08-11；文件名中的 2026-08-18 不证明较晚日期又执行了一次实验。

官方文件从 Figshare 文件 `31463402` 下载。它含 4,148 行 JSONL，MD5 为 `6224c849f67c8f591e6f7a2f0f02dddf`，与 Figshare API 元数据一致。完整的只读 run 评估了 3,975 个实体与 23,996 条非 anchor mention：17,294 条正样本、6,702 条负样本、16,661 条类 alias 正样本，以及 38 条完全同名 hard negative。

| 阈值 | Recall | Precision | Alias recall | 完全同名负样本拒绝率 |
|---:|---:|---:|---:|---:|
| 0.3 | 1.000 | 0.721 | 1.000 | 0.000 |
| 0.5 | 0.942 | 0.716 | 0.941 | 0.026 |
| 0.6 | 0.675 | 0.694 | 0.672 | 0.395 |
| 0.7 | 0.304 | 0.636 | 0.302 | 0.684 |

四个报告阈值都没有在该样本上确立可用于自动接受的 precision／recall 工作点：提高阈值不会改善 precision，只能以丢掉大部分真实 alias 为代价来拒绝完全同名 hard negative。因此 hashing 上下文分数只适用于宽泛的 blocking／candidate 生成。它不得被解释为已校准的身份置信度，也不得用于自动接受 `same_as`／合并 proposal。

在线到达反事实让操作成本更具体：

| 阈值 | Proposal 率 | 出现错误 proposal 的实体 | 外来记录 | 受影响实体的均值／最大值 |
|---:|---:|---:|---:|---:|
| 0.5 | 94.74% | 2,307 / 3,975 (58.04%) | 6,450 | 2.80 / 27 |
| 0.6 | 70.07% | 1,995 / 3,975 (50.19%) | 5,140 | 2.58 / 22 |
| 0.7 | 34.42% | 1,479 / 3,975 (37.21%) | 3,003 | 2.03 / 16 |

即便用所报告的最严格阈值，若 proposal 等同于合并，它仍会对大约三分之一的到达 mention 发出 proposal，并污染超过三分之一被评估的实体。这是结构性共置损害，不是模拟的答案分数。hashing 可以提名一个待审集合，但只有独立 evidence 与既有的可逆拓扑 gate 才能授权一次变换。

## 配对 Agent 结果（2026-08-11）

修正后的固定十实体 DeepSeek V4 Flash protocol 跑了五次随机重复（50 次配对观测、100 次模型调用），没有解析或 provider 错误：

| 组 | 精确归因（Wilson 95%） | 平均 precision | 平均 recall | 平均延迟 |
|---|---:|---:|---:|---:|
| Clean | 84% (71.49--91.66%) | 100% | 92.67% | 627 ms |
| 一条外来记录 | 88% (76.20--94.38%) | 100% | 94.67% | 621 ms |

加入外来记录后，有五次配对观测从正确变为错误，同时有七次从错误变为正确。精确双侧 McNemar p 值为 0.774，逐次重复的差值为 +10、0、+10、-20 与 +20 个百分点。这些区间和 p 值描述十个固定实体上的 50 次重复观测，不是 50 个独立实体，也不是总体层面的不确定性估计。Agent 在全部 50 次受污染观测中都拒绝了那条外来记录。在最初的实况调用中，provider 报告 6,670 个未缓存输入 token、71,040 个 cache-read token、1,383 个输出 token，按 Pi 的用量约定共 79,093 个 total token。相同的重跑使用了全部 100 条本地响应缓存条目，未发起任何 provider 调用。

这次重复运行既没有检测到错误归因，也没有检测到稳定的准确率效应。早先单次重复出现的十个百分点下降不是分心效应的稳定证据；这些重复也不能单独识别此前下降的原因。结构性审计仍然支持「相似度仅用于提名」，但这个 Agent 探针不证明下游的 false-merge 损害、纠正频率或端到端答案影响。

更早的一个 pilot 错误地把目标页面上 `Other` mention 周围的段落当作完全外来的记录。这些段落往往仍在描述目标（例如以人名命名的机构），因此它表面上的 90% 到 20% 的下降是无效的，不再作为证据保留。protocol version 1 现在要求构造跨页记录。

生成的报告写入 `evals/topology/results/` 下，该目录被 Git 忽略。

即便完成这些 run，Namesakes 仍不包含用户纠正事件，且配对探针只覆盖十个固定实体对。自然的可归因纠正、更大的实体覆盖范围与恢复成本，都仍是考虑无人值守身份变更之前的独立证据 gate。
