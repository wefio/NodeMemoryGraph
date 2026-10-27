# 记忆呈现统一：输出兼容性与渲染成本

[English](memory-surface-unification-2026-10-26.md) · [术语](memory-surface-unification-2026-10-26.terms.yaml)

## 问题与方法

共享记忆工具改走 InformationView 后，交付文本是否保持一致，准备过程增加多少成本？
本次离线探针直接调用产品的搜索、紧凑搜索、精确证据和保存回执渲染函数。
输入为确定性呈现 fixture，不访问数据库、embedding 或 LLM。

基线采用 `5f0cb01736bdea722642155380d862ba56eae2dd` 的共享呈现实现。
两轮均在 Windows、Node v24.19.0 下执行，每例预热 30 次、测量 200 次。
搜索与读取各含 0、1、20、200 条记录，覆盖长正文、原始来源、时间戳、open 状态及检索退化标签。
保存回执每类后续候选分别为 0、1、6 条（渲染器每类最多接纳 3 条）。
报告保存输入、实现与完整输出哈希、字符数及延迟分布。两轮之间仅格式化了探针，
输入身份与测量逻辑保持一致。

## 首轮统一结果

15 例的完整输出哈希与字符数全部一致。20 条证据的例子完整保留 20,972 字符，
通用准备函数默认的 8,000 字符上限没有再次截掉已接纳页面。

| 用例 | 基线均值，ms | 统一后均值，ms |
| --- | ---: | ---: |
| 搜索，20 条 | 0.0552 | 0.1514 |
| 紧凑搜索，20 条 | 0.0090 | 0.0826 |
| 精确证据，20 条 | 0.0824 | 0.2007 |
| 保存，每类 6 个候选 | 0.0113 | 0.0128 |
| 精确证据，200 条 | 0.9849 | 1.8727 |

快照与来源指纹增加了计算。本轮测量共享协议的成本，不声称提速。
微秒级计时存在噪声；单进程小样本不代表生产延迟或吞吐。

## 延迟生成元数据

最终实现只在读取 `included` 时计算来源哈希，并将数组缓存于不可变输出。
去重在规范来源、用途与预览标记组成的键下精确比较正文。15 例文本仍与基线一致。
独立的基础设施比较中，12 组完整输出摘要（含来源哈希）与确定性检索结果摘要均一致。

改动后的两轮仅读文本复测中，search-20 均值为 0.1945/0.1299 ms，
evidence-20 为 0.2519/0.2006 ms。这些存在噪声的结果不能证明相对首轮统一实现
有稳定的端到端提速。两轮在同一台机器上较晚执行，第一轮还与契约测试并行。
独立的准备过程探针分别测量文本与元数据消费：

| 平铺准备，8,000 字符预算 | 完整元数据 p50，ms | 仅读文本 p50，ms |
| --- | ---: | ---: |
| 20 个输入项 | 0.1056 | 0.0417 |
| 200 个输入项 | 0.3183 | 0.2010 |
| 2,000 个输入项 | 2.1180 | 1.9793 |

`infra-perf.ts` 在原完整输出计时内部读取 `included`，避免把延迟工作偷偷移到计时外。
独立的 `textOnlyLatencyMs` 测量准备与文本读取，两者均运行 40 次，仍属于小规模合成负载。
每次准备仍复制一次输入快照，没有新增跨请求的验证或权限缓存。

## 证据与复现

- [基线产物](artifacts/2026-10-26-memory-surface-baseline.json)
- [统一后产物](artifacts/2026-10-26-memory-surface-unified.json)
- [延迟计算产物](artifacts/2026-10-26-memory-surface-lazy.json)
- [延迟计算复测](artifacts/2026-10-26-memory-surface-lazy-repeat.json)
- [提取摘录辅助函数后的最终源码测量](artifacts/2026-10-26-memory-surface-final.json)
- [完整元数据一致性与成本](artifacts/2026-10-26-memory-surface-metadata.json)
- [探针](../../../evals/retrieval/memory-surface.ts)

在已安装依赖的检出中先生成提示词产物，再运行探针。比较会拒绝输入不一致或完整文本变化：

```powershell
npm run prompts:generate
node --experimental-strip-types evals/retrieval/memory-surface.ts --out memory-surface-result.json --compare docs/experiments/retrieval/artifacts/2026-10-26-memory-surface-baseline.json
node --experimental-strip-types evals/retrieval/infra-perf.ts --out memory-metadata-result.json --compare docs/experiments/retrieval/artifacts/2026-10-26-infra-final.json
```

## 验证范围

2026-10-27 最终验证通过了 `agent:verify` 的全部 16 项阻塞检查。
产品测试共 2,073 项：2,071 项通过、2 项跳过、0 项失败。

契约测试另覆盖来源快照不可变、预览与完整披露的区别、已撤回来源的遮盖、超过 8,000 字符的
完整证据、保存回执保留，以及较小上下文预算下候选与限定语整项保留或省略。
保存确认和组合后续提示均不生成记忆披露回执。

本轮测量共享 search/get/save 呈现；其他变更动作的确认、宿主错误文本及 JSON/RPC 业务结果
不属于此次投影改动。探针不启动真实宿主，也不测模型答题质量。
未重新运行 recall：此前 LME 成对结果属于基础设施改动，不能当成本修订的新验证。

一次完整验证在 `stg-isolated.test.ts` 删除临时目录时遇到 `EPERM`；存储路径断言已经完成。
使用以下命令单独复测同一用例 10 次，复现率为 0/10。该清理失败的原因尚未确定，
这些重试不能证明它不会在整套测试并发运行时再次出现。

```powershell
node --experimental-strip-types --test --test-name-pattern='Phase1: stgStorePath derives' tests/core/stg-isolated.test.ts
```
