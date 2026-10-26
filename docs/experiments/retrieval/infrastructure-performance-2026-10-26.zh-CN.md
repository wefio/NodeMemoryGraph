# 检索基础设施性能，2026-10-26

[English](infrastructure-performance-2026-10-26.md) · [使用的术语](infrastructure-performance-2026-10-26.terms.yaml)

## 结果

InformationView 增量计数消除了反复拼接输出；批量加载证据减少了 SQL 次数，
测量中的检索结果保持一致。性能部分使用合成数据；下方独立的 LME 全量回归部分
验证了 500 道基准题的 recall@20 保持不变。

首次基线与最终运行的中位耗时，单位毫秒：

| 操作 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 上下文准备，20 项，8,000 字符预算 | 0.117 | 0.058 |
| 上下文准备，2,000 项，8,000 字符预算 | 13.698 | 3.179 |
| 上下文准备，2,000 项，全部纳入 | 326.812 | 3.582 |
| 本地检索，200 条记忆，返回 20 条 | 5.019 | 4.265 |
| 每次检索 SQL 执行次数（次数，非毫秒） | 203 | 4 |

全部纳入场景使用 1,000,000 字符压力预算，并非新的产品默认值。
8,000 字符预算下，2,000 项中纳入 42 项、省略 1,958 项；条数与完整输出都未改变。

独立进程复测得到检索中位耗时：优化前 5.019–5.476 ms，优化后 4.265–4.285 ms。
大列表全部纳入场景分别为 325.704–326.812 ms 和 3.582–3.645 ms。
两次运行不足以推断置信区间或生产延迟保证。

## 方法与产物

基线源码修订为 `d8992f99`。环境为 Windows、Node `v24.19.0`、本地内存 SQLite，
不使用外部模型。每个场景预热 5 次、测量 40 次，P50/P95 使用仓库的
`percentileFloor` 口径。各次运行串行；数据构造、SQL 计数和报告写入不计入检索耗时。

合成数据包含 200 条记忆，使用确定性 ID、时间戳和重要度，每条记忆独占一个节点，
关联三条历史记录。查询参数为 `limit=20`、`maxTier=3`、`graphHops=0`、
`secondPass=false`、`persistTrace=false`、`perf=true`；AG 预算为 20 个节点、
20 条证据、6,000 token、tier budget 20。实验运行本地词法路径。
SQL 次数由一次独立查询中 prepared statement 的 `all/get/run` 调用统计，不是返回行数。

InformationView 覆盖 20/200/2,000 项、flat/context 两种输出，以及
8,000/1,000,000 字符预算。每五项中一项为 state 职责，其余为 material；
各项均有 memory 来源句柄和标签。脚本比较完整准备输出与有序检索结果对象的 SHA-256，
12 个视图场景和检索结果全部一致。AG/board 包装和受保护省略场景由契约测试覆盖。

原始 JSON 包含配置、实现哈希、时间戳和阶段耗时。保留的运行：

- [基线](artifacts/2026-10-26-infra-baseline.json)与[基线复测](artifacts/2026-10-26-infra-baseline-repeat.json)。
- [仅优化渲染](artifacts/2026-10-26-infra-rendering.json)：SQL 次数仍为 203。
- [两项优化初测](artifacts/2026-10-26-infra-optimized.json)。
- [最终运行](artifacts/2026-10-26-infra-final.json)与[最终复测](artifacts/2026-10-26-infra-final-repeat.json)。

最终文件包含初测后的格式化和函数提取；哈希标识各次源码快照。
基线与最终测量脚本之间只有格式差异。

## 复跑与解释

安装依赖后，在仓库根目录运行：

```powershell
rtk proxy node --experimental-strip-types evals/retrieval/infra-perf.ts --out docs/experiments/retrieval/artifacts/infra-local.json --compare docs/experiments/retrieval/artifacts/2026-10-26-infra-baseline.json
```

`--iterations` 和 `--records` 接受正整数。对照要求输入配置及输出哈希匹配，
不匹配则以非零状态退出。已执行缺少 `--out` 和迭代次数为零的反例，
均在写报告前正确失败。脚本创建并关闭自己的内存数据库，不打开官方套件存储或共享 daemon。

实验不覆盖 embedding 准备、RPC 传输、磁盘竞争、图扩展、二次检索、答题和判分。
读者预算与排序策略保持原样。这个小规模样本中，剩余 direct-search 阶段占据大部分耗时；
继续优化候选加载或索引需要代表性存储的剖析数据。
本轮没有重跑答题与判分；召回一致性由下方独立测量验证。

## LME 全量召回回归检查

优化工作区与基线 `d8992f99125958a331b63f2aeb98f7571e2bba93`
分别运行 LongMemEval-S 全部 500 题，复用 `nmg-longmemeval_20261025T095539Z`
留下的 500 个存储。每题先从只读源数据库通过 SQLite backup 生成快照，
再将完全相同的副本交给两个版本。基线运行于独立的 detached worktree，
使用与优化版相同的已安装依赖。

500 个查询向量全部命中 `bge-small-en-v1.5@1e9807091681` 缓存。
cache-only 模式和拒绝访问的 provider 委托阻止在线调用；
所有响应必须报告 record 检索，降级到词法路径会让检查失败。
两版均执行 `OmniMemEvalBridge`，topK 为 20、AG 预算为 6,000 token，
开启二次检索与链扩展，关闭摘要路由，使用固定的追加上下文限制。

现有数据加载器与 `evals/retrieval/score.ts` 提供 gold 答案会话文本及
`candidate-in-gold` 匹配。500 题共含 948 个 gold 会话；
未排序的追加上下文不计入 recall@20。这个指标与 LLM-as-Judge 答题分数分别计量。

| 指标 | 基线 | 优化后 |
| --- | ---: | ---: |
| Recall@20，证据微平均 | 794/948 = 83.7553% | 794/948 = 83.7553% |
| 任一证据命中@20 | 479/500 = 95.8% | 479/500 = 95.8% |
| 全部证据命中@20 | 386/500 = 77.2% | 386/500 = 77.2% |
| MRR(Q) | 0.873278 | 0.873278 |

500 对结果中，逐题 recall 回退数、排序 ID 列表变化数和输出哈希变化数均为零。
输出哈希绑定完整渲染文本与 memory DTO，包含分数和证据摘录；六个分类指标也全部一致。
全量运行零失败、零跳过。这证明当前 LME 配置下无回退；其他数据集和答题模型结果
不属于本部分的测量范围。

[全量逐题证据](artifacts/2026-10-26-infra-recall-lme500.json)
记录快照哈希、代码哈希、数据身份、命中位置和输出哈希。
[冒烟运行](artifacts/2026-10-26-infra-recall-smoke.json)在全量运行前检查了两题。
本部分没有采样耗时；聚合结果的 latency 字段是评分器的默认零值，不代表检索耗时为零。

复跑时，先准备上述修订的干净基线 checkout，安装相同依赖，并在其中执行
`npm run prompts:generate`。从优化版仓库运行，以 `--baseline-root` 指定该 checkout：

```powershell
rtk proxy node --max-old-space-size=8192 --experimental-strip-types evals/retrieval/infra-recall.ts --baseline-root C:/Documents/GitHub/NodeMemoryGraph-recall-baseline --stores .benchmarks/omnimemeval-nmg --run-input .benchmarks/official/OmniMemEval/results/lme/nmg-longmemeval_20261025T095539Z/nmg_lme_search_results.json --cache .benchmarks/shared-embedding-cache.sqlite --index-id bge-small-en-v1.5@1e9807091681 --out docs/experiments/retrieval/artifacts/infra-recall-local.json --scratch .benchmarks/test-runs/infra-recall-local
```

`--scratch` 必须是尚不存在的目录，由脚本创建并清理。`--limit 2` 选择冒烟运行。
脚本校验数据集与用户的绑定；缺少存储、缓存查询缺失、降级、召回回退或输出变化
都会以非零状态失败。脚本通过独立 TypeScript 与 ESLint 检查；
已执行缺少必填参数的反例，按预期失败。
