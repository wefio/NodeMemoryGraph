# 稳定化轮：search 必须跑赢评测端客户端；提供商不得把 CAS 关住

[English](2026-10-30-stabilisation-round.md) · [Terms](2026-10-30-stabilisation-round.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

15:2x-15:31 的并发 16 突发 + 稳态读日志，四类故障全部可用新日志行定位：

| 故障                                             | 证据                   | 类                                                                                                                              |
| ------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| /search 4.2 秒 503                               | 15:26 trace `2d32d910` | search 第一次（也是唯一一次）读 manifest 与它读分区对象之间，折叠提交并删除了旧对象——CAS 重试循环没了；现在这个竞态没有任何兜底 |
| SEARCH_TIMEOUT · 504                             | 15:31                  | 我们 `SEARCH_DEADLINE_MS` 60 s；评测端客户端窗口不发布具体数值但短于 60 s——我们的"partial at 60 s"总在对方超时之后              |
| `dependency_timeout` ×9+ 于新加坡 embedding host | `nmg_failure` 批次     | 单次 provider 调用顶到 25 s 上限；fold 32 条回填会在 CAS 内带三个并发 25 s 卡死，把所有其他调用卡住 24-30 s                     |
| 120 s 杀，914/907 MB                             | 平台信息               | 调用为一段 stall 的 chunk 全程付 SQLite 状态膜的代价；本轮通过撤 stall 缓解、不直接解决                                         |

## 决策

1. `SEARCH_DEADLINE_MS` 60_000 → 25_000 (`NMG_SEARCH_DEADLINE_MS`)：评测端窗口内的 partial 得分，窗口外的完美答案得 504。
2. search 捕 `snapshot_changed` 后重读一次 manifest 重跑，上限 2 次，第 3 次仍失败才外抛；纯读也要像无锁读者重新确认版本一样重新对齐。
3. `EMBED_DOCUMENT_TIMEOUT_MS` 25_000 → 12_000：折叠 chunk 有两次机会，而不是一次 25 s 扣住 CAS。
4. 文档 chunk 按 `NMG_EMBED_CHUNK_CONCURRENCY`（worker 默认 `1`）顺序发：fold 32 条变为三段 10 行顺序调用；提供商账户队列不再被宽并发击中。
5. `nmg_request` 行加 `execution: "waituntil" | "inline"`；2026-10-30 14:41 那次 `dist/` 旧 chunk 文件未被清导致打包源仍是旧版，部署后下一轮 greppable。
6. `build:edgeone` 已有清 `dist/` 的步骤；发布核查清单加"构建产物入口 grep 当前 capability 标记"，避免再由陈旧 zip 静默替换。

## 考虑过的替代方案

- **按删除速延迟 `retireParts` 来缓解 `snapshot_changed` 竞态**：按分钟保留已删除的对象，会复制 CAS 正确性依赖的删除；一次 manifest 重读比每次给 fold 的垃圾堆墓碑便宜。
- **抬高 search deadline 以推迟 partial 答案**：partial 本来就是要挤进客户端窗口；推迟它就失去了意义。
- **改 lower fold backfill 批而不是 chunk 并发**：32 是"一次折叠吸收多少条"的上限；chunk 竞争才是卡 CAS 的原因，别改错层。
- **把 fold 嵌入整体搬到 accept 的 `waitUntil`**：15:00 那轮折探针已经给了确切数字——25 s 上限当前存在于突发；整个折叠搬过去意味着这个窗口由提供商节奏决定，不是我们。

## 后果

- `search` 不再依赖写 CAS 的重试保障自己的安全；读路径自带重试，代价是一次 manifest GET。
- search deadline 变一个凑术变量（`NMG_SEARCH_DEADLINE_MS`），不改代码即可调；默认值假设评测端窗口 < 60 s（官方未发布具体数字）。
- 两个 env 参数成为文档项：`NMG_EMBED_CHUNK_CONCURRENCY`、12 s 文档超时默认（原 `NMG_EMBED_TIMEOUT_MS` 仍覆盖两者）。
- 15:26 503 类（陈旧分区竞态）终结；读不再被 fold 打拉扯。
- 再说一次：提供商 25 s 上限是回填吞吐的真正天花板；但现在代码没有一边等它一边占住 manifest，表层不再有 120 s 卡死供代码塞 GC 误导。
