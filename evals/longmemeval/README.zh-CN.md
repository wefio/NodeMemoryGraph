# LongMemEval 适配器

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

本地数据目录包含官方的清洗版 LongMemEval-S 与 oracle 文件，并被刻意让 Git 忽略。

从七个 benchmark 类别各跑一个确定性样例：

```powershell
npm run eval:longmem -- validate 1
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
npm run eval:longmem -- matched 1
npm run benchmark:score:longmem -- <result-directory>
```

最后一条命令用 LongMemEval 的任务专属官方提示词语义、以 DeepSeek V4 Flash 作为
临时判定器给既有预测打分。它不重跑 reader，并被标注为不可与 leaderboard 比较。

最后一个参数是每个类别的样例数。选择始终来自 `longmemeval_s_cleaned.json` 中的
顺序，因此每个模式都用同一批问题 ID。每个答案由一个全新的 DeepSeek V4 Flash
会话判定；判定器返回空响应时会重试一次。

要使用签入仓库的、与顺序无关的样本以及重复的 reader 试验，用：

```powershell
$env:NMG_LONGMEM_SAMPLE_FILE = "evals/longmemeval/samples/development-v1.json"
$env:NMG_LONGMEM_REPEATS = "3"
npm run eval:longmem -- validate 1
npm run eval:longmem -- matched 1
```

manifest 优先于位置参数式的分类别计数。每次重复都得到隔离的 NMG 数据库，因此
早先试验的访问统计不会改变后一次试验。报告包含 Wilson 95% 准确率区间，以及相对
`no-memory` 按问题与重复配对的 win/loss/tie 计数。报告还把各模式的答案延迟与
确定性的 NMG 摄取、嵌入索引准备时间分开。每个 NMG 臂都得到同一份确定性种子语料
的独立副本。多臂运行会按问题与重复确定性地轮转执行顺序，使 provider 冷启动成本
不会总是记在同一个臂上。`tokenUsageByMode` 把 provider 输入、输出、缓存读、
缓存写与总 token 记账与延迟分开报告。`answerTimingByMode` 分别报告 Pi 启动、
总提示词墙钟时间、assistant 模型流式时间、工具执行时间与关闭时间。
`injectedContextByMode` 报告平均字符数与一个显式标注为近似的"每 token 四字符"
估算；它不作为 provider tokenization 呈现。NMG 检索小节仍留在每行的
`memoryPerformance` 中，而语料摄取与嵌入索引构建留在 `preparations` 中。

答案正确性与检索充分性分开打分。检索判定器只看到 `raw-session`、`flat-hybrid`
或 `oracle` 实际注入的上下文，或显式 NMG 模式下成功的 `nmg_get` 输出。报告包含
`retrievalByMode` 以及一张流水线矩阵，把"证据充分但答案错误"与真正的检索未命中
区分开。Pi 不通过 RPC 暴露自动注入的回忆，因此评估器从持久化的检索轨迹重建紧凑
的注入头。对显式 `nmg_get`，官方 LongMemEval session recall 由实际加载的确切记忆
ID 及其不可变 `sourceRef` 值计算。报告把它单独暴露为 `officialRetrievalByMode`；
LLM 检索判定器仍是诊断性的充分性度量，而不是官方证据指标。
`durationMs` 只测量答案调用；`evaluationDurationMs` 还包含两次独立的判定调用。

每个答案行还记录 `toolCallCount` 与 `toolRounds`；一个 round 是返回了至少一个
工具结果的一次 Pi 模型轮次。独立的官方打分器额外给出二元 `taskSuccess` 与类型化
的 session-ID 证据 any/all/recall/NDCG。它随后审计同问题/同重复的确定性与候选臂。
由于当前的 `nmg-shadow` 臂无法改变排序，预期结果是
`matchedProduct.metrics: null` 伴随 `candidate_does_not_affect_ranking` blocker。
这证明的是测量路径，不是控制器激活质量。

检索判定器默认启用。做更低成本的吞吐运行时可设
`NMG_LONGMEM_RETRIEVAL_JUDGE=off`；此时检索与流水线摘要不可用，而答案打分保持
完整。

runner 默认四个并发问题与五分钟的模型调用超时。用 `NMG_LONGMEM_CONCURRENCY`
与 `NMG_LONGMEM_TIMEOUT_MS` 覆盖。单条答案超时只记录在那一行，而不是丢弃整个
实验；判定失败得到一次全新重试。

## 模式

- `no-memory`：reader 只收到问题与日期。
- `nmg-auto`：自然问题依赖带预算的自动回忆，而不强制调用记忆工具。
- `oracle`：reader 只收到官方证据会话。
- `nmg-oracle`：Pi 把官方证据会话导入隔离的 NMG 数据库，然后由全新的 Pi 会话用
  NMG 检索作答。这是摄取/检索冒烟测试，不是全 haystack 分数。
- `matched`：在同一批固定 ID、提示词、reader 配置与完整清洗 haystack 上运行严格
  三臂闸门：`no-memory`、`nmg-deterministic` 与 `nmg-shadow`。Shadow 打分被记录，
  但不能影响检索排序。
- `raw-session`：在共享上下文字符预算下的词法会话排序。
- `flat-hybrid`：在同样预算下对单个轮次做词法加确定性哈希向量排序。
- `nmg-lite`：把同样的轮次级证据导入 NMG，并用 `NMG_GRAPH_HOPS=0` 强制禁用图跳。
- `nmg-graph`：同样的 NMG 导入，附带一跳类型化关系扩展。

作答 agent 运行时没有内置文件系统/shell 工具、技能、上下文文件或提示词模板。
NMG 臂只暴露三个 NMG 工具。这样可防止 agent 检索已检出的 benchmark 文件或读取
金标答案；记忆投递机制是唯一的臂专属信息通道。

`raw-session`、`flat-hybrid`、`nmg-auto`、`nmg-lite` 与 `nmg-graph` 仍是可单独
运行的诊断消融；它们不属于严格 matched 闸门。

matched 导入是确定性的：每个源轮次变成不可变的 `conversation_evidence`，相邻
session 节点得到一条时间性的 `related_to` 边。这把检索与随机的记忆抽取隔离开。
它不测试自动抽取或学习到的拓扑的质量。

报告与逐问题 NMG 数据库写在 `results/` 下，该目录同样被 Git 忽略。

## 2026-08-11 控制器遥测变更后的 matched 回归

运行 `2026-08-11T07-34-42.046Z` 用 `deepseek/deepseek-v4-flash`、关闭 thinking、
四个并发问题、无外部嵌入 provider、QPP1 shadow，以及一个无法影响排序的控制器，
重复了七类别、单重复的严格 matched 闸门。通用诊断判定器与独立的 LongMemEval
协议打分器给出：

| Arm | Diagnostic | Protocol score | Evidence judge | Mean answer latency |
|---|---:|---:|---:|---:|
| No memory | 1/7 | 2/7 | n/a | 5.64 s |
| Deterministic NMG | 4/7 | 4/7 | 4/7 | 10.35 s |
| NMG + non-ranking shadow | 4/7 | 4/7 | 4/7 | 9.24 s |

两个 NMG 臂通过了同样的四个类别：弃答、知识更新、单会话 assistant 证据与单会话
用户证据。它们都没过多会话聚合、偏好检索与时间推理。相对 no memory，每个 NMG
臂都有三次仅候选方的胜利、零次仅基线的失败、一次共同通过、三次共同失败。这是
一个小的回归闸门，不是 leaderboard 主张，但它显示 shadow 遥测路径没有带来答案
质量回归。

尽管控制器不参与排序，官方精确证据召回仍然不同：确定性 NMG 为
`recallAny=5/7`、`recallAll=3/7`、`NDCG=0.567`；shadow 为 `5/7`、`2/7`、`0.538`。
模型做出了不同的 search/get 选择，并加载了不同的精确证据，即使检索排序未变。
因此相等的 4/7 答案与证据判定分数并不确立检索等价；在做出成本或召回主张之前
仍需要重复的配对试验。

provider 总量：确定性 NMG 133,327 token，shadow 97,207，no memory 5,136，
其中缓存读分别为 107,392、82,304 与 1,408 token。两个 NMG 臂的平均注入上下文
估算为 1,404 与 657 token。这些单重复成本差异是对 Agent 工具行为的观察，不是
可归因于非排序控制器的影响。

## 严格 matched 开发运行

运行 ID：`2026-07-26T09-47-30.923Z`。七个问题类别各取一个固定样例，所有臂使用
同一个 DeepSeek V4 Flash reader、提示词、问题与确定性全 haystack 导入。未配置
外部嵌入 provider，因此这次运行测量的是零配置的 FTS/哈希路径，而不是 BGE 或
Qwen 语义检索。

独立的 LongMemEval 协议打分器给出：

| Arm | Correct | Accuracy | Mean answer latency |
|---|---:|---:|---:|
| No memory | 1/7 | 14.3% | 4.1 s |
| Deterministic NMG | 2/7 | 28.6% | 6.9 s |
| NMG with non-ranking shadow logging | 3/7 | 42.9% | 6.7 s |

shadow 控制器无法改变排序。它多出的一个答案属于 reader/判定器方差，不是控制器
改善检索的证据。独立的检索诊断在确定性 2/7 与 shadow 3/7 的试验中找到了充分
证据。当确定性检索充分时，2/2 的答案正确；五次确定性检索未命中全部产生错误
答案。

主要失败是语义与覆盖缺失：个人最好成绩状态、多会话聚合、Premiere Pro 偏好、
学位，以及双事件时间证据。一个把推荐请求从 cue-only 改为自动检索的单问题实验
仍返回无关节点并得分 0/1，因此该闸门变更被回退。下一个公平实验是用同一个固定
样本配一个可用的外部节点与叶子嵌入 provider。在那之前，改变图拓扑、控制器或
答案提示词都会与被诊断出的检索瓶颈混淆。

这个七问题、单重复的结果是开发诊断，不是通用能力或 leaderboard 主张。

## 首次七问题开发运行

| Mode | Correct | Accuracy |
|---|---:|---:|
| No memory | 1/7 | 14.3% |
| Oracle evidence | 5/7 | 71.4% |
| NMG over oracle evidence, pre-semantic architecture | 2/7 | 28.6% |
| NMG over oracle evidence, typed graph architecture | 6/7 | 85.7% |
| NMG over oracle evidence, adaptive retrieval architecture | 6/7 | 85.7% |
| NMG three-layer recall, corrected judge parser | 6/7 | 85.7% |

自适应检索那次运行加入了持久化向量、学习到的路由打分与 Huffman 派生块层级。
它保持了同样的总分；剩下的多会话失败只返回一项，而要求是三项。样本太小且模型
执行是随机的，因此这不是 benchmark 主张。第二次 NMG 运行在加入稳定状态身份、
类型化记忆、多证据派生、图感知上下文组装与类型化使用说明之后，使用同样的七个
固定问题 ID。它解决了先前的状态更新、assistant 细节、偏好与时间失败。剩下的失败
是多会话聚合：reader 数出两项，而参考答案要求三项。

这次运行暴露的下一个工程目标是跨多个会话与记忆的可靠聚合。仍需要更大的全
haystack 运行来衡量检索质量与可扩展性。

三层那次运行加入了常驻内核、确定性的 `none/cue/retrieve` 闸门、自动证据回忆、
类型感知的超量取回/重排与精确来源摘录。偏好推荐与候选覆盖得到改善。剩下的一次
失败是摄取/来源问题：一个同时包含归还旧物品与取走替换品的用户轮次仍可能被摘要
成一条记忆，而模型选择的"最短引文"可能漏掉另一个动作。下一步的数据模型是稳定的
逐消息原始历史 ID，直接链接到每条被抽取的记忆。

判定器解析器现在使用最后一行行首的 PASS/FAIL 判定。这修复了一个用例：判定器先
给出 PASS，重新考虑后以 FAIL 结束。

在 Windows 上，不要针对同一个全局 Pi 配置并发运行独立的 Pi 评测进程：它们会在
`settings.json.lock` 上争用。请串行运行，或为每个进程分配隔离的 Pi agent 目录并
采用合适的凭据策略。同一次评测内部的模型请求仍可并发。

## 历史闸门前开发运行

下面的结果早于严格三臂 matched 协议，仅作为诊断历史保留。它们不得被当作当前
matched-gate 结果来比较。

### 首次全 haystack 诊断运行

运行 ID：`2026-07-19T10-34-21.919Z`。七个问题类别各取一个固定样例，用 DeepSeek
V4 Flash 评测。

| Control | Correct | Accuracy |
|---|---:|---:|
| No memory | 1/7 | 14.3% |
| Raw-session retrieval | 1/7 | 14.3% |
| Flat hybrid turn retrieval | 5/7 | 71.4% |
| NMG Lite, no graph expansion | 5/7 | 71.4% |
| NMG Graph | 6/7 | 85.7% |

图扩展找回了三项的多会话答案，而 Lite 与两个非 NMG 检索对照都没找到。flat hybrid
单独赢下一个单会话用户用例，两个 NMG 模式都没找到。只有七个问题且 reader/判定器
随机，这些数字确立的是一个可复现的开发信号，不是统计优越性。下一步 benchmark 工作
是更大的固定样本、重复模型运行与置信区间。

### 扩展的 14 问题诊断运行

运行 ID：`2026-07-19T10-49-26.309Z`。每个类别两个固定样例、四路问题并发、无答案
超时：

| Control | Correct | Accuracy |
|---|---:|---:|
| No memory | 2/14 | 14.3% |
| Raw-session retrieval | 4/14 | 28.6% |
| Flat hybrid turn retrieval | 8/14 | 57.1% |
| NMG Lite, no graph expansion | 10/14 | 71.4% |
| NMG Graph | 9/14 | 64.3% |

在配对问题上，Lite 独有地通过了 flat 未通过的五例，而 flat 独有地通过三例。Graph
独有地通过一例 Lite 未通过的，并独有地失败两例 Lite 通过的。因此更大样本不支持
默认启用图扩展。一次仅 Graph 的未命中还在没有 RPC 错误的情况下产生了空的最终模型
答案，说明为什么仍需要重复 reader 运行，才能把检索效应与模型方差分开。
