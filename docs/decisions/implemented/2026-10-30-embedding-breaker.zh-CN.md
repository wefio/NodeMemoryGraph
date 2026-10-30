# 嵌入故障应该只花延迟，不该花掉写入

[English](2026-10-30-embedding-breaker.md) · [Terms](2026-10-30-embedding-breaker.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

腾讯云对 16:52-17:52 的日志分析（74 条，全部 `调用超时`）把这次故障分成三类：

| 类别         | 特征                                                                                                          | 条数        |
| ------------ | ------------------------------------------------------------------------------------------------------------- | ----------- |
| A 快速失败   | 53 ms、54.48 MB，业务代码没跑                                                                                 | 31（41.9%） |
| B 依赖阻塞   | 120000 ms、588-770 MB，`kind=embedding_failure code=dependency_timeout`，`text-embedding-v4` @ ap-southeast-1 | 39（52.7%） |
| C 空转满时长 | 120000 ms、54.48 MB                                                                                           | 4（5.4%）   |

B 类是我们的问题，而且是机制问题，不是"依赖慢"：

1. accept 内联嵌入（8 s 竞速）**输掉**——条目以无向量方式写入。
2. 折叠随后回填向量：`rememberBatch` 里的 `syncRecordEmbeddings`。提供商超时时它**抛出**。
3. 异常穿出 `rememberBatch` → `addOneBatch` → `mutateUser`，被当作 CAS 冲突，**整轮重试**——最多 12 次，每次都再付一次同样的超时。12 × 12 s = 144 s，这正是"请求达到 120 s 上限，而栈上只有折叠"的成因。

而此时写入其实早已成功。每一条重试都在为已经落库的记录重新嵌入。

## 决策

**向量回填是优化项，不得让写入失败；提供商已经倒下时，根本不该再调用它。**

- `memory-service` 的回填不再抛出——**除了 `EmbeddingPreparation`，那是控制流**：`runPart` 依赖它解开 SQLite 会话、在会话外嵌入、再重进。把它一起吞掉会静默丢记录（被"折叠后的条目仍可检索"测试抓住）；其余错误记入 `backfillStatus`，写入继续。
- `monitoring.embeddingOperation` 加**熔断器**：提供商侧失败（`dependency_timeout`、`embedding_timeout`、`embedding_network_error`、429、5xx）打开 `NMG_EMBED_BREAKER_MS`（默认 30 s）。窗口内嵌入调用以微秒级失败（`embedding_suppressed`），不再等满超时。窗口内接收的记录以无向量方式存储并按词面打分，等后续折叠回填。
- 输入导致的 400 **不触发**熔断：那是我们的 bug，不能被藏起来。

## 证据

| 改前                                                                          | 改后                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| 18 分钟内 39 条撞 120 s 上限，全是 `dependency_timeout`；活下来的 Add 22-63 s | 一次超时即打开熔断；窗口内的后续 Add 完全不做嵌入工作 |
| 提供商超时的折叠会把 CAS 重跑至多 12 次                                       | 折叠的存储工作不再依赖提供商，只缺向量                |
| 窗口内 Add p50 22-36 s                                                        | 部署前无法测量；accept 不再等一个已知不可用的调用     |

## 这确立了什么、没有确立什么

- 它没有让提供商变快，也没有增加配额。故障期间，窗口内接收的记录检索质量下降（词面而非向量）——这是有意的取舍，且被熔断窗口约束。
- A 类（53 ms、54.48 MB、31 条）与 C 类**未处理**：这些调用从未进入 handler（没有 `nmg_request` 行），worker 里没有任何东西能修；诚实的下一步是降低每实例基线（实测 600-800 MB rss）以降低平台快速失败的概率，那是另一个任务。
- OPFS 初始化噪音（`Ignoring inability to install 'opfs' sqlite3_vfs`）来自 vendored 的 SQLite WASM loader，不是我们的代码。

## 考虑过的替代方案

- **把文档超时调回 25 s**：那是 15:2x 的配置，每次等待更久，而重试乘数照旧。
- **降低 `mutateUser` 的重试次数**：能限制损失，但嵌入调用仍在请求路径上；熔断直接去掉调用，故障下严格更优。
- **回填改用 Batch API**：需要本运行时不存在的轮询驱动（见 `2026-10-29-embedding-invocation-budget`）。

## 后果

- `/health limits` 与 `/admin/status` 可报告 `embeddingBreakerStatus()`；提供商恢复后由 `resetEmbeddingBreaker()` 复位。
- 故障期间接收的记录可按词面检索，并在后来的折叠中获得向量。不丢数据，质量自行恢复。
- 折叠的结果不再依赖提供商——这正是 `2026-10-30-search-is-a-read` 对读路径承诺过的事情。
