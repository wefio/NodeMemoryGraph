# 与公开工作的相对位置

[English](related-work.md) · [术语](related-work.terms.yaml)

**Status:** draft; external metrics below reproduce cited reports and were not rerun here.  
**Authority:** [父级范围](../ooo-execution-bootstrap.zh-CN.md)。

## 成熟度与已发表系统对照

这一节记录外部对照，不重复本文自己的契约。[五级自改进分级](https://d2i-ai.github.io/awesome-recursive-self-improving-agents/)把“能提议、能应用、能验证”与“能改写改进机制本身”分开：L1 手工、L2 辅助（系统可提议候选与诊断证据，人负责验证与应用，改进机制由人维护）、L3 程序化自改进（自主提议、应用并验证运行组件，但改进机制固定或外部维护）、L4 有界 RSI（连自己的改进机制一起改写）、L5 通用 RSI。

按这个标准，**本文记录的项目状态是 L2**：每轮的指令、清单、验证器和提升都由人预先写好并人工批准，没有自动把候选变成下一轮基线。该快照中的 S1 只有单轮、单模型、单检查记录；其出口条件（一个有用变更被独立验收并被下一轮采用）是从 L2 迈向 L3 的一步，当时尚未达到。后续研究样本可能补充实验证据，但本身不能证明产品运行时已经接入。

对照的是同一条战线的已发表系统，它们都在 L3 且有可测增益：

| 系统 | 自改范围 | 验收方式 | 报告增益 |
| --- | --- | --- | --- |
| [MOSS](https://arxiv.org/html/2605.22794v1) | harness 层：路由、状态、派发、钩子、会话生命周期 | 计划评审 + 代码评审 + 短命试验容器重跑任务，结论收敛后仍需使用者显式执行 `moss evo apply` 才提升 | 四任务均分 0.25 → 0.61 |
| [DGM](https://arxiv.org/html/2505.22954v3) | 自身 Python 代码库，经验证据代替可证明改进 | 在编码基准上实测，能编译且保留编辑能力的版本才入档 | SWE-bench Verified 20.0% → 50.0%，Polyglot 14.2% → 30.7% |
| [SICA](https://arxiv.org/abs/2504.15228) | 自身实现，用基础编码工具 | 基准实测 | SWE-bench Verified 子集 17% → 53% |
| [AHE / 可演化 harness](https://arxiv.org/html/2608.08466v1) | prompts、tools、memory、状态、执行策略 | 外部奖励信号，runs 目录、tracer、验证器与模型配置只读 | BabyAI +39.3、Crafter +33.0、TextWorld +25.0、MiniHack +15.0 |

本设计与它们的重合部分是已经形成共识的做法，不是本工作的新意：验证器与奖励信号应在自改进回路之外（[harness 自改进综述](https://lilianweng.github.io/posts/2026-07-04-harness/)：“The evaluator and permission control should likely sit outside the loop”），被测面之外的目录、跟踪器、验证器、模型配置只读，提升须经人显式批准。这里的外部系统结果按引用来源报告，不是本项目复现实验。DGM 记录了绕过验证的实际案例：其 agent 删除了标记工具调用的日志，从而绕开了幻觉检测函数，而检测函数对该 agent 是不可见的——本设计用“worker 不能改验证器、不能自批、不接受 worker 的通过标记”在结构上排除这一路径。

三个可以指认的差别：

- **对象**。已发表系统优化的是提示、技能、记忆、工具或整个代码库，或者如 [HarnessX](https://arxiv.org/abs/2606.14249)、[自演化 harness](https://jxzhangjhu.github.io/blog/2026/self-evolving-agentic-harnesses/)那样做整块 harness 的演化。本工作把**等待结构本身**当作开发对象：固定顺序、显式依赖、最多一个等待任务与一个执行任务、不抢占、不推测；越过队首的许可来自真实外部检查这一事件，而不是推测未来调用。harness 自改进的讨论里，并行与后台任务是被建议的能力（“make parallelism explicit and inspectable”），不是自改进维度。
- **对等待的处理**。把工具延迟变成收益的已发表做法是推测执行，例如 [PASTE](https://arxiv.org/html/2603.18897v1) 用离线挖掘的模式在空闲资源上预跑可能用到的调用，任务完成时间平均降 48.5%，但它的预测量依赖于对下一步的预测（Top-1 约 27.8%），并且必须能抢占推测工作。本工作不做预测也不抢占：它用等待时间跑一个本来就必须做、且与 A 无依赖的任务。这是设计空间里另一个点，不是同类方法的改进版。
- **验收语义**。已发表系统用基准分数或评分器作为唯一信号；本设计要求每个用例解析到可核对的依据，并把“无法完成”与“无需修改”区分为阻塞报告与已解决结论。

本记录所处阶段**缺少**这个领域的证据标准：可测增益、重复试验（MOSS 用多轮短命容器暴露 flakiness）、留出任务集与跨模型检验。该快照中的 S1 只有单轮、单模型、单检查记录，因此即使出现被采纳的变更，也不能据此声称速度或质量收益；S4 对照应按重复试验和留出任务集设计。后续实验见[arm 试点](../../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)；其结论仍受各自样本与研究 instrument 限定。

### 乱序执行：真正的对应物是“乱序执行 + 顺序提交”

处理器里与本工作同构的不是“并行”，而是**乱序执行 + 顺序提交**：指令乱序进入功能单元，但通过 reorder buffer 在 retire/commit 阶段按程序顺序生效，从而得到可精确恢复的状态（[Out-of-order execution](https://en.wikipedia.org/wiki/Out-of-order_execution)、[Reorder buffer](https://wwang.github.io/teaching/slides/Comp_Arch/Reorder_Buffer.pdf)）。本设计的位置与之几乎逐个对应：worker 乱序运行（B 先于被阻塞的 A），计划与票据充当 reorder buffer，协调器是唯一的 retire 阶段，A 的输入只在检查终态事件之后绑定。验收规则（接受/拒绝/无法判定）就是“什么算提交”的定义。

差别在推测。经典 OoO 的收益很大一部分来自推测执行和回滚（分支预测、squash），代价是必须能丢弃错误路径的状态。本设计**不推测也不回滚**：它只重排本来就必须做的工作，越过队首的许可来自真实外部事件。所以它不需要 squash 机制，但收益上限也明显更低——这个取点必须诚实保留，不能在对照中把它当成“同类的更快版本”。

### Agent 乱序执行：领域默认是无界并行，本设计更严

把计划当 DAG 做依赖感知调度已是主流做法：plan-as-DAG 先把整个依赖图规划出来再并行执行（[LLMCompiler](https://www.agentpatternscatalog.org/patterns/llm-compiler/)），生产口径的 fan-out 报告把墙钟时间降低 36–50%，依赖感知 DAG 相对串行约 1.35×，而“忽略依赖全并行”会牺牲正确性（[DAG 编排](https://particula.tech/blog/dag-agent-orchestration-fan-out-fan-in-latency-parallel-execution)）；工具延迟的另一条路是猜测下一步调用（[PASTE](https://arxiv.org/html/2603.18897v1)，平均完成时间 −48.5%）。本设计比这些**都更严**：固定顺序、最多一个等待任务与一个执行任务、不抢占、不推测。因此本轮的价值主张只能是验收语义（可证明的缺口、宿主验证、不能自批），不是并行吞吐；对照时必须按这个定位设计。

后台委派、持久会话快照、断线重连与人工暂停恢复在当代 harness 框架里已是常规能力（[Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/concepts/harness)、[Mastra durable agents](https://mastra.ai/docs/harness/durable-agents)、[Inngest durable agents](https://www.inngest.com/docs/learn/durable-agents)）。S3 若要加提交/查询/取消入口，应直接对齐已有形状，而非重造轮次脚本。该形状曾作为历史 round 工具实现，但专用 `ooo_round` 工具于 2026-09-14 离开产品工具目录，且此记录不证明产品 `nmg_board` host path 调用了抽取的 dispatch loop；见[历史 S3/S4 记录](historical-round-tooling.zh-CN.md)。

### 分布式通讯：现有机制都有既有名字

详见完整内容：[分布式通讯：现有机制都有既有名字](related-work/distributed-coordination.zh-CN.md)。

### 由此得到的改进清单

详见完整内容：[由此得到的改进清单](related-work/improvement-opportunities.zh-CN.md)。

### 推测的落点（规则由决策记录拥有，本节只列可落地的位置）

详见完整内容：[推测的落点（规则由决策记录拥有，本节只列可落地的位置）](related-work/speculation-integration.zh-CN.md)。

### 状态机、LLM 猜测与 LLM 打回

**任务登记状态机：采纳。** 每个任务声明自己的状态与就绪条件，转移由宿主根据已记录的事实计算。这正好解决黑板架构“没有控制结构”的老问题（需要显式控制组件），也是 S2 缺失的重放能力的前提：持久任务编排用事件源（append-only 历史）表示状态，崩溃后靠重放恢复决策，并要求编排代码确定、副作用隔离在 activity 并记录其结果（[Durable Task 重放](https://github.com/Azure/durabletask/blob/main/docs/concepts/replay-and-durability.md)、[编排代码约束](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-code-constraints)）。因此：**转移只能由宿主规则对已记录事实求值，LLM 永不得直接写转移**；模型只能产出制品或声明，由宿主规则消费。

**让 LLM 猜任务：分两种，一种不允许。** 猜“计划本身”（下一步该做哪些任务）是自动重规划，它同时破坏两件东西：固定计划带来的可验收性，以及“宿主先证明缺口再派任务”的闭环；不出现在本设计中。可允许的只有猜“已声明条件的结果”（即上节的受门控推测），并且假设必须写进冻结信封，使 digest 绑定它。

**另一个 LLM 打回：只能做建议，不能做裁判。** 这不是我的个人偏好，而是已发表立场：自改进 agent 应把评判者从 oracle 降为 advisor，其结论只能是多个输入之一（[LLM-as-a-Judge Is Not an Oracle](https://arxiv.org/abs/2609.02246v1)）；实测中评判者的成对偏好平均有 13.6% 会翻转（[The Coin Flip Judge?](https://arxiv.org/html/2606.13685v1)）；而无参考评判者打的是**像不像对**，不是**对不对**，这正好留下“貌似有理但错误”的假阳性盆地供策略利用（[Self-Play Reward Hacking of Reference-Free LLM Judges](https://arxiv.org/html/2607.05904v1)）。本工作自己就量到过同一个现象：第 2 轮 B 的引用看起来像覆盖，实际语义成立性未被证明。

因此定下一条不对称规则：**建议者只能说“不”，只有宿主能说“是”。** 第二个 LLM 的打回可以作为廉价预过滤（早退、省一次宿主检查），但任何时候都不能把“打回”当作接受依据，也不能让它取代已存在的确定性检查——在已有确定性检查的任务上，用一次 20–50 s 的付费、概率性判定去替代一个本地、免费、几秒内确定结论的检查是降级。它只在**没有确定性检查**的断言上才值得付费（设计是否自洽、意图是否匹配、结论是否有依据），而且应优先要求**宿主能解析的引用**（第 3 轮已经建立的机制），而非再买一个模型的意见。

顺带一条外部印证：代码 RL 环境里，28.5% 的任务其测试套件弱到让 Docker 验证过的错误补丁能通过（[Auditing Reward Hackability](https://arxiv.org/pdf/2606.16062)）——这正是第 3 轮改用变异证明的理由。

### 输出格式、产物提交与验证成本

详见完整内容：[输出格式、产物提交与验证成本：实况结果的外部对照](related-work/output-format-and-verification-cost.zh-CN.md)。

工具提交、可见集、票据与缓存账目等研究 instrument 细节见该对照文档。
