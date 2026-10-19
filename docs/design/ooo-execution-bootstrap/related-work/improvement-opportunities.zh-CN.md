# 由此得到的改进清单

[English](improvement-opportunities.md) · [术语](improvement-opportunities.terms.yaml)

**Status:** draft; 以下实现细节为带日期的历史研究记录，不构成产品运行时集成证据。  
**Authority:** [父级范围](../related-work.zh-CN.md).

## 改进机会与记录状态

1. S2 采用日志+重放的轮次记录，把模型调用作为不确定 activity 记录其结果，使重启可恢复，而不是只留一份报告。**已做（仅重放，不重跑模型）**：`src/integration/ooo-round-log.ts` 把一轮记成 JSONL 事件流（计划 / 检查签发与终局 / 认领 / 产物或 worker 失败 / 回推 / 判定 / 每个变异的去处 / reopen / 终局），`recordedWorker()` 用记录里的答案代替模型，`compareTerminal()` 对比终局。第一次重放**证伪了编排的确定性**：A 的冻结指令里嵌入了每次随机生成的 `checkId`，于是每轮摘要都不同，宿主以 `stale patch digest` 正确拒收了记录中的产物；修法在协调器一侧 —— 检查身份改为由轮次自身状态派生（`digest([taskId, attempt])`，作用域是存储，`runId` 仍是判别符）。重放**不**重新执行模型；它重新执行宿主检查，所以“本轮产物被接受”这件事可以在不花 worker token 的前提下重新验证。**重放绑定轮次身份**（2026-09-12）：日志的每条认领都带该任务的冻结摘要（基线文件、指令、声明故障、预算与限额全在其中），plan 事件另带录制时的 revision 与**验证规则摘要**（检查命令/参数/标签，它不在任何任务的冻结工作里）。重放先逐项核对这三样：不同就**指名拒收**（`replay refused: the frozen work differs from the log`），而不是输出一个“看起来像复现”的结果；核对通过才用**录制的 revision**检出候选 worktree。这个缺口是被实测抓到的：提升 round 7 的产物后，同一份日志重放得出 A/B/C 全部 rejected（基线变了 → 摘要全变 → 记录中的产物全部过期），而只比较终局是看不出“这不是同一轮”的；写测试时又发现改掉检查命令后摘要与终局都不变 —— 那正是必须把验证规则也纳入身份的原因。仍未做：日志不是防篡改的（没有哈希链，信任它就是信任一个普通文件）；录制时的产物仍是记录下来的答案，不是“模型当时最好的答案”。
2. 审计每一处写入路径是否都在提交点校验 token；当前 `submit()` 已做到，`cancel`/`issue`/已接受结果的等价性需要逐项确认。**已做**：`submit()` 在提交事务内重校 `bound()`；新增的 `cancel()` 以推进尝试号围栏整个轮次，因此迟到产物得到 `stale` 而非被接受；`abandonCheck()` 只认签发的票据（伪造票据无效）。
3. 增加显式的本轮取消路径，保证取消后没有孤儿 worker 或检查进程。**已做**（机制层）：`cancel(reason)` 推进每个任务的尝试号、撤销未决 handoff、把检查表置为终端，`next()`/`claim()`/`issueCheck()`/`externalReady()` 一律拒绝，取消原因跨重启保留。孤儿进程的**实测**已补（2026-09-12）：`runCycle` 接受操作者的 `AbortSignal`，取消时（a）在协调器里真正 `cancel(reason)`（推进每个任务的尝试号，迟到产物得到 `stale`），（b）杀掉在途检查的**进程树**（`candidate.ts` 用 `spawn` + `detached`（POSIX）/`taskkill /T`（Windows）），（c）本轮不再派发、也不再做组合验证，终局记为 `cancelled`。实测两条：`cancellation.test.ts` 用真实子进程与真实 worktree 证明取消后检查进程与其子进程都不再存活、worktree 不泄漏、没有任何产物被接受；多进程那条用真实 worker 进程证明在途投递变 `stale`、依赖不被解锁、取消原因跨守护进程重启保留。两处诚实边界：Windows 上 libuv 的 job object 本来就会回收非 detached 子进程（把杀树换成 `child.kill()` 测试仍通过 —— 已实测），所以显式杀树在那里是冗余保险，POSIX 的进程组杀伤才是让性质成立的那一步；测试里的孙进程不是 detached，故意 detached 的孙进程不在断言范围内。
4. **前提先于派发**：任务的指令断言“宿主已证明这些故障存活”，该断言就是这条任务的依赖。早先矩阵与 B 的模型调用并行，一轮因此把 204,164 tokens 花在一个已经为假的前提上；现在证明先于认领，假前提的 worker 代价是 0。派发被拒绝时必须**撤回它已发布的 handoff**（`withdrawHandoff`）：板对待办条目是串行的，一个不会有人认领的 handoff 会堵死本轮后续的每次认领。
5. **无法测量不等于测过且干净**：前提矩阵有三种结果（`survived` / `killed` / `unmeasured`）。并发 `git worktree add` 偶发失败时该检查什么都没测到，早先把 `undecidable` 归入“已检测”，于是一轮把存活的变异报成 76 ms 内被杀。现在 `unmeasured` 让本轮以 `premise-unmeasured` 终止（不是 `premise-invalid`），候选 worktree 做有界重试。
6. **产物通道只有一套标准**：补丁尝试的文本作答过去被原样记录，宿主只能在账付完之后以 `invalid patch structure` 拒收。现在文本作答必须通过工具同一套信封校验，不合格就是记下原因的一次失败尝试；系统提示词也不再描述文本通道，补丁尝试被明确要求走产物工具。
7. S4 的对照必须回答“本设计会不会更慢”：变异复检与候选目录都是本轮新增的宿主开销，不能只报收益。

S2 的退出条件“故障注入后无重复完成、错误解锁或无限等待；重启可恢复或明确终止”现由
`evals/ooo-execution/recovery.test.ts` 的 8 个确定性测试覆盖：崩溃后继者不偷活认领、重复提交为
`duplicate` 且不二次释放依赖、被撤认领的产物为 `stale`、租约失效是新一代而非静默成功、永不回报的检查以
`undecidable` 显式终止、伪造票据不能终止等待、取消围栏迟到产物且跨重启保留、存储按列增量迁移且保留既有状态。另加两条真实进程的取消实测（`cancellation.test.ts`：杀进程树、无幽灵完成、依赖不解锁、原因跨重启保留）与“重放要么复现要么指名拒收”。5. 统一术语：协调器=retire/commit 阶段，接受=commit，拒绝=squash，attempt digest=fencing token。
