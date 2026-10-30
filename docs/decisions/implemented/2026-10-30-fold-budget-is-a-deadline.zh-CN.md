# 折叠预算即截止时间；且该运行时不提供 waitUntil

[English](2026-10-30-fold-budget-is-a-deadline.md) · [Terms](2026-10-30-fold-budget-is-a-deadline.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

两条事实，都来自生产日志行，而非读代码推断。

**一：上一轮的前提对这个运行时是错的。** 稳定化部署之后，每次请求的常开日志行都报 `execution: "inline"`——适配器探测的 `context.waitUntil` 从未存在。在这类不提供该钩子的平台上是正确行为：Makers 的**Node 云函数** context 文档只列 `uuid / params / env / clientIp / server{region,requestId,geo}`。之前引用的 `waitUntil` 属于 **Pages 边缘函数**（`FetchEvent`）与 Pages 边缘 handler，和本项目部署的 Node 云函数不是同一个运行时。所以“折叠在响应之后跑”在生产从未生效；`2026-10-30-fold-runs-after-the-response` 中关于此的判断由本记录取代。15:00 那次 Add p50 1.02 s、尾部 6.5 s 是**内联**折叠在 1/8 排程下的形态，16:59 那两行同样写着 `execution: "inline"`。

**二：折叠预算只管起点。** `if (dueBySchedule && Date.now() - startedAt < foldBudget)` 只决定折叠**要不要开始**；19.9 s 开始的折叠照样要把整个分区重写加 32 条回填跑完。这正是 14:09-14:15 的数字（Add 11-25 s、尾 100.7 s、5 个 120 s 被杀请求，栈全在 `foldPending`）的机制，前两轮没有覆盖，是因为没有任何东西在折叠开始之后约束它。

同一批日志的第三个发现：两个 `/add`、`/search` 请求在**全冷 isolate** 上以 24-47 ms 返回 **404**（81 MB、`wasm_linear_mb: null`，从未碰 SQLite）。我们的 `/add`、`/search` 只接受 POST，所以那不是工作请求；请求行现在记录 `method`，让下次出现时是被识别而不是被猜。

## 决策

- **折叠接收截止时间并遵守它。** `foldPending(env, userId, { deadline })` 过了截止点不开始；在逐条应用之间检查，超时即停，把这一批剩余留在日志里。accept 传 `startedAt + foldBudget`；`/admin/fold` 传自己的 100 s。停下永远安全：条目已持久、折叠幂等、下一次排程的 accept 会重试。
- **不依赖 `waitUntil`。** 分支保留给提供该钩子的运行时（测试提供），实际发布路径是有界的内联折叠——这也是本平台唯一支持的形态。
- 请求行增加 `method`，仅用于诊断。

## 证据

| 改前                                                                         | 改后                                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 14:09-14:15：Add 11-25 s、尾 40-100 s、5 次 120 s 被杀、栈全在 `foldPending` | 超预算的折叠返回 `{ folded, remaining: null, deferred: "budget" }`，剩余条目等下一次排程 |
| 15:00 p50 1.02 s / max 6.5 s：1/8 内联折叠，预算只管起点                     | 排程不变，但受调用方测量到的同一个时钟约束                                               |
| 请求行没有 `method`；两个来源不明的 404                                      | 记录 `method`，404 要么可解释、要么能证明没有副作用                                      |

## 这确立了什么、没有确立什么

- 它没有让 16 并发写者下的 Add 变快：折叠仍在请求路径上，排程命中时 accept 仍要付一次折叠的成本。
- 对其他 EdgeOne 运行时是否提供 `waitUntil` 未验证，本记录不假设任何一种。
- 那两条 404 仍未解释；`method` 是让它被解释的手段，“连通性探测”目前只是猜测。

## 考虑过的替代方案

- **迁到 Pages 边缘函数运行时以取得 `waitUntil`**：这是另一个产品、另一条部署路径；迁移不是用来同周修一个折叠预算的手段。
- **提高 `FOLD_EVERY` 让折叠更少发生**：那是拿积压换延迟，正是前三轮把已接收数据藏起来的机制；兜底仍是折叠，不是放弃。
- **请求路径不再折叠、改用定时器**：本运行时没有定时器；cron 是第二套要运维的部署，而且折叠依然需要边界。

## 后果

- `FOLD_TRIGGER` 分之一的 accept 仍会付折叠，但绝不超过它自己的预算；超了照旧 200，日志更长。
- 折叠“被推迟”的结果在 `/admin/fold` 的计数器里可见，而回滚需要的排空正是走那条路。
- `nmg_request` 现在带 `method` 与 `execution`，两者都只用于诊断，不产生额外往返。
- 早前两份记录（`fold-runs-after-the-response`、`accept-without-cas` 里的 waitUntil 论证）在平台事实上被取代；它们引入的机制（有界、幂等、写在写侧的折叠）由本记录加强。
