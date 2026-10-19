# 相关性训练数据与评估

[English](relevance-training.md) | [简体中文](relevance-training.zh-CN.md) · [术语](relevance-training.terms.yaml)

**状态：**当前。

## 边界

离线相关性训练器使用外部相关性判断或独立核实的证据。本地 recall trace 用于后续校准与失效案例；训练不等待本地流量。Memory benchmark 仅用于评估。答案字符串包含、复用答案、沉默和未判定候选都不是负相关性标签。

`tools/relevance-training-data.ts` 负责版本化数据集与 manifest 校验；`tools/relevance-model-train.ts` 负责准备、拟合和报告。这些是离线研究工具；成功运行不会启用 runtime head。

## 准备与分区

通过 NMG search path 准备候选列表，并显式划分 source partition：

```sh
node --experimental-strip-types tools/relevance-model-train.ts --prepare-only --qrels /data/corpus-a --qrels-split train --cache /data/derived/a-train.json
node --experimental-strip-types tools/relevance-model-train.ts --prepare-only --qrels /data/corpus-a --qrels-split dev --cache /data/derived/a-cal.json
node --experimental-strip-types tools/relevance-model-train.ts --prepare-only --qrels /data/corpus-b --qrels-split test --cache /data/derived/b-test.json
```

输入包括 `corpus.jsonl`、`queries.jsonl` 和 `qrels/<partition>.tsv`。不会覆盖已有输出。Corpus 内容 hash 绑定可复用 store；数据集文件保留 query ID、source-unit ID、candidate ID、判断来源、feature 列以及 retrieval protocol／embedder identity。空检索列表仍计入分母。Lexical preparation 忽略环境中的 embedding 设置；embedding preparation 必须同时提供 `--embeddings` 与 `--embedder <indexId>`。

显式 qrels 分数 0 为负例，正分为相关，缺失判断记为 `-1`（未知）。导入器不会把未判定文档当成不相关，因此只有稀疏正例的 qrels 不足以提供有监督训练所需的正负两类。

Manifest 在拟合前按完整 source unit 分配角色：

```json
{"version":1,"train":["a-train.json"],"cal":["a-cal.json"],"test":["b-test.json"]}
```

路径相对于 manifest。拟合／校准会拒绝已发布的 test partition 与 memory-benchmark corpus ID。测试 corpus 必须在声明 ID 与内容 hash 上都不同于训练和校准数据；共享 source unit、规范化重复 query 不能跨角色；feature/retriever protocol 必须一致。这些检查只能发现记录出来的 identity 重叠，不能发现语义改写，也不能纠正数据生产者伪造的来源。

对于离线构造的 memory task，生产者使用 `labelSource: verified-evidence` 并保留可核验的 `labelEvidence` 引用。同一 conversation 的所有变体共享 `sourceUnitId`；应在生成变体前拆分原始 conversation。单靠 generator 或 LLM judge 不构成独立核实。导入器接受此类记录，但不提供自动标注服务。

## 拟合与评估

```sh
node --experimental-strip-types tools/relevance-model-train.ts --manifest /data/derived/training.json --out /data/derived/candidate.json --json
```

只有已知标签的候选可训练 item head 或校准概率。每个角色都必须有明确正例与负例。Calibration set 选择一个 operating floor；test sets 评估该冻结 floor。默认 `--min-retention 1` 要求校准集保留所有已知正候选和含正例的完整列表。较低值是显式实验容差，不是产品策略，也不保证未见数据。

报告包含输入 hash 与角色、各 test corpus 指标、判断覆盖率、已知噪声移除量、候选缩减、正例保留、hit 保留与全正例保留；未知候选单独统计。指标以检索候选池与已知判断为条件：全正例保留不证明多跳充分性；候选缩减不是实测 token 节省；跨 corpus 表现不是 live automatic-recall 质量。

默认输出为 `.benchmarks/relevance/candidate.json`，并附 `.report.json`；它不是 runtime model 路径。Artifact 记录训练 provenance 与离线用途，`deploymentEligible` 保持 `false`。自然目标域验证与 runtime admission 是分开的操作。

`--certify` 也要求 manifest，并拒绝存在未知候选判断或同一 source unit 多个评估 query 的情况。Threshold lattice 从训练数据构造，再在 calibration 与独立 test 数据评估。统计界限保留其抽样假设；不能据此证明跨域不变性或证据保留。常规 retention report 是主要的保守比较。

## 数据获取

外部标注数据提供规模；离线构造提供带可追踪证据的 memory 特定时间、偏好和多跳案例；本地明确确认的 outcome 提供小规模目标域审计。自动注入、披露或模型未引用某条记忆都不是真实反馈。Candidate relevance、整份列表的 sufficiency 与 expansion usefulness 是不同目标；本训练器只拟合第一个目标。

理由见[独立训练数据决策](../decisions/implemented/2026-09-15-independent-relevance-training.zh-CN.md)。