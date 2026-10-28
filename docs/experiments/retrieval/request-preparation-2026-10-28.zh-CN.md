# 请求内查询准备，2026-10-28

[English](request-preparation-2026-10-28.md) · [使用的术语](request-preparation-2026-10-28.terms.yaml)

## 结果

两个索引健康的 Store 检索相同查询时，请求内准备把查询 embedding 调用从两次降为一次。
两个独立进程运行中的 180 个计时比较对，按序排列的完整候选对象全部严格一致。
这是合成数据检索等价检查，不是数据集 recall@20 结果。

| 场景（每轮各 30 个计时请求） | 调用数优化前／后 | 首轮 p50 ms 前／后 | 重复轮 p50 ms 前／后 |
| --- | ---: | ---: | ---: |
| 单查询、单 Store | 30 / 30 | 30.680 / 31.152 | 30.197 / 30.512 |
| 同查询、双 Store | 60 / 30 | 60.624 / 32.656 | 59.258 / 32.411 |
| 不同查询、双 Store | 60 / 60 | 61.501 / 61.046 | 60.635 / 60.330 |

同查询场景 p95 为 68.822 → 38.176 ms，重复轮为 67.793 → 39.827 ms。
这些耗时包含**每次调用模拟 20 ms 的 provider 等待**；Windows 定时器调度与 SQLite 工作也计入耗时，
不能估计线上 provider 延迟。没有重复查询的场景没有调用数下降，也未证明提速。

## 方法与复现

基线版本：`cd193624f10d`。Windows，Node v24.19.0。
保留的探针使用两个内存 SQLite Store，各生成 60 条记忆与固定二维记录／查询向量。
两组搜索相同的 fixture；生成的记忆 ID 不要求在跨进程运行间一致。建库不计入耗时。
各场景预热三对，再测 30 对，交替执行顺序。
直接组沿用 `searchMemoryContext`，请求组像 daemon 一样传入 `requestQueryEmbeddingClient`。
每次调用重新创建包装。P50/P95 使用仓库的 `percentileFloor` 口径。

```powershell
node --experimental-strip-types evals/retrieval/request-perf.ts --out docs/experiments/retrieval/artifacts/2026-10-28-request-reuse.json --iterations 30 --records 60 --delay-ms 20
```

脚本拒绝缺少输出路径、无效计数、非有限测量值、空候选页、错误 embedding 调用数及完整有序结果不一致。
limit 为 20，graph hops 为零，禁用 second pass 和轨迹持久化。
不访问真实 provider、答题模型或生产数据库。
原始报告包含运行时、参数、输入说明、时间戳、实现哈希、调用数与两组延迟分布：

- [首轮](artifacts/2026-10-28-request-reuse.json)
- [重复轮](artifacts/2026-10-28-request-reuse-repeat.json)

独立的[契约测试](../../../tests/integration/query-embedding-request.test.ts)覆盖真实 Store 读取、
读取之间删除、并发消费者、失败与空响应重试、修改隔离、自动取消和纯词法选择。
本地 HTTP provider 测试执行真正的 `NmgService` 多查询路径，验证每次调用拥有独立准备。

## 范围与剩余工作

本次只消除本地 daemon 的重复查询准备。不缓存索引健康或记忆结果，不批处理不同查询文本，
不修改排序或云端存储。不证明整个 daemon 的吞吐、p99、事件循环延迟、请求背压或远端取消能力。
这些需要独立负载测量；本次没有据探针结果添加并发策略。
[检索契约](../../design/design/progressive-retrieval.zh-CN.md#请求内查询准备)拥有行为，
[决策](../../decisions/implemented/2026-10-26-retrieval-infrastructure-cost.zh-CN.md#请求内查询准备扩展)拥有取舍。
