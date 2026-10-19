# 分布式通讯：现有机制都有既有名字

[English](distributed-coordination.md) · [术语](distributed-coordination.terms.yaml)

**Status:** draft; 以下是设计类比，不是当前产品运行时集成证据。

**Authority:** [父级范围](../related-work.zh-CN.md).

## 机制对应关系

- **fencing token**。本设计的 `attempt` + `inputDigest` 就是 fencing token：一个每次重新认领就递增的值，而**资源方必须自己拒绝倒退的 token**（[Kleppmann, How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)：“requires the storage server to take an active role in checking tokens, and rejecting any writes on which the token has gone backwards”）。协调器的 `submit()` 在事务内重新校验 `bound()` 后才写入产物，符合“检查必须由资源在提交点执行”这一要求，而不是在写之前顺手看一眼。Kleppmann 的 GC 暂停案例（持有者不知道租约已过期，回来继续写）正是本设计里“worker 在租约失效后继续工作、其产物被判 stale”的情形，这给了那条规则一个已发表的正确性论证。
- **失败检测器**。异步系统里无法区分“已经崩溃”与“只是很慢”，一致性因此需要额外的失败检测器假设（[FLP](https://homes.cs.washington.edu/~arvind/cs425/doc/fischer.pdf)、[Chandra–Toueg](https://dl.acm.org/doi/10.1145/226643.226647)）。所以“检查宿主永不上报”只能得到无法判定、绝不能算成功，而失败的检查可以释放修复任务却不能接受它——这是该边界上的教科书选择，不是本工作的新意。
- **exactly-once 是 at-least-once 加幂等接收方**（outbox/inbox 与消息 ID 去重，见 [delivery guarantees](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/)）。本设计里重复的终态证据返回 duplicate、同一产物重复提交是惰性的，属于同一模式；“只自动重试已声明可重入的检查”也该按这个口径解释。
- **saga/补偿**。失败的检查释放后续修复任务而不接受它，是把回滚换成了补偿动作。
- **结构化并发**。每个任务都有明确所有者和有界生命周期，子任务不得超出父作用域（[Swift 提案](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0304-structured-concurrency.md)）。这正是“最多一个等待任务和一个执行任务”“worker 不超出本轮”“拒绝的认领不被人为过期”背后的口径，也是 S2 应该保持的不变量。
- **持久执行需要确定性与重放**。以日志重放为核心的系统要求编排代码确定、副作用隔离到 activity 并记录其结果（[Temporal](https://learn.temporal.io/tutorials/go/background-check/durable-execution/)、[确定性与重放](https://jack-vanlightly.com/blog/2025/11/24/demystifying-determinism-in-durable-execution)）。本设计“冻结接口 + worker 只能产出不可信产物、由宿主应用”已经符合这个分割（模型调用就是不确定的 activity），但**缺重放**：轮次状态目前只存在于 SQLite 协调器与 JSON 报告里，进程结束后无法重放，S2 的恢复能力应当采用日志+重放模型。
- **黑板与 tuple space**。黑板架构的经典缺陷是没有控制结构，需要显式的控制组件（[Hayes-Roth](https://www.semanticscholar.org/paper/A-Blackboard-Architecture-for-Control-Hayes-Roth/c79a41dc13c796c26388f8cbf599c67126374e39)）；Linda 把这一点抽象成共享元组空间（[Linda](<https://en.wikipedia.org/wiki/Linda_(coordination_language)>)）。本设计的黑板只承担跨进程交接与认领，控制留在固定计划与协调器的选择函数里，正是该缺陷的对应处置。
