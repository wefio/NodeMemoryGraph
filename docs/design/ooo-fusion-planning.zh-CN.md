# Fusion 规划：在线 repair-first，离线 ceiling

[English](ooo-fusion-planning.md) · [术语](ooo-fusion-planning.terms.yaml)

共享 dispatch loop 与单步决策函数已存在，并由研究 driver 使用；尚无证据表明产品现有的 `nmg_board` host path 会调用该 loop。产品接入已延期。离线 ceiling 是研究工具，不是运行时策略；目前没有已确立的通用启动、token 或成本模型。

本文讨论如何把计划中的 unit 分配到 Agent sessions：共享 dispatcher 在运行边界可以作何决定，以及哪些内容仅在离线分析中测量。合法性规则不在此重述；其唯一 owner 是 `src/integration/ooo-execution.ts` 中的 `sharedSessionLegal`。

## 本文回答的问题

将多个 unit 放进一个 session 可以节省 session 启动时间，但 bound 本身既不选择 successor，也不能证明 fusion 值得其 token 或 provider 成本。离线工具使用来自 D arm 的显式每 session 1 900 ms 假设；该 arm 的 1 900 ms 中位差小于其 2 228 ms cell 内 spread，因此不是通用启动耗时估计。四单元 fine plan 上，归档中 cap 1 到 cap 2 的中位 wall 差为 8 451 ms，cell 内 spread 分别为 1 783 ms 与 571 ms。这只是对该测量形状的证据，不是普遍节省：cap 第三次重复用了较新的 prompt，报告没有保留 instrument commit。D arm 的单次运行观察到 chain 首个 unit 多约 0.7k tokens，也不能给运行 surface 定价；fusion 的 token/成本部分仍未解决。因此有用的问题是_一个计划最多能压缩到多少个 sessions_，而不是 fusion 是否普遍有益。

## 两种时钟

| | 在线（运行边界） | 离线（分析） |
| --- | --- | --- |
| 决定什么 | 当前 session 的下一步 | 计划理论上最少需要多少 sessions |
| 使用事实 | 当前运行实际持有的事实 | 乐观投影：每个 unit 均已接受、未取消、没有未就绪的外部等待或待定分支 |
| 成本 | 无（纯函数，毫秒级） | 无（不调用模型） |
| 失败方式 | 应继续时关闭了 session | 夸大 fusion 可节省的量 |

离线部分是一个 **ceiling**，不是策略。运行中不得读取它来决定下一步，因为它基于运行当时尚不可知的事实。

## 在线：ready set、repair-first、baseline

Fused session 是不可逆的承诺：已经在一个 session 中运行的两个 unit 不能再拆开。因此在线决策不是重写计划，而是对_当前_ session 作一步决定：

- **admit** 下一个合法 successor；或
- **close** session，并指出关闭条件。

要让这一步安全地重复执行，需要三个性质：

- **Repair-first。** 延续当前 session 是**由 plan 声明**的约束，不是本文设计的默认值：启用 `repair-first` 的 plan 会继续 session；不声明任何约束的 plan 则每个 session 运行一个 unit，并在每个 unit 边界关闭。启用后，重新决策只可在声明的变化下**结束** session：verdict 被拒绝、发生取消、依赖尚未 accepted，或声明的外部等待尚未就绪。相较重新规划，repair 的取舍已有记录：复用计划可省工作，但可能基于过时计划行动；从头规划会产生 churn（`plan repair versus full replanning`）。Repair-first 取中间路线：保留已提交部分，只决定尚未运行的部分。协议允许的名称是封闭列表（`PLAN_CONSTRAINTS`）；未列出的名称会被明确拒绝，而不会被解释成“未请求任何约束”。
- **Baseline。** 事实仍成立时，不重新考虑已经作出的 move。事实在边界到达；边界之间没有需要重决策的变化，因此事实集不变时，move 集也不变。这对应 Oracle SQL Plan Management 的 plan-baseline 思路：将计划限制在已接受的备选项中，避免无关变化悄悄移动计划。
- **Determinism。** 相同 plan 和事实产生相同 move，平局按 plan 顺序打破。这符合 workflow engine 的纪律（Temporal 按记录历史重放 workflow code，因此代码必须是该历史的纯函数；非确定性留在 activities 中）：model call 是 activity，move 是可重放代码。没有这一点，同一 plan 的两次运行就不能比较，而 arms 需要可比性。

`nextSessionMove` 是对 plan 与当前事实的确定性规则，不读取数值成本模型。D arm 的启动耗时值只是离线 ceiling 使用的显式研究假设，不是拟合出的通用模型。将来若引入成本模型，应离线拟合并在一次运行中冻结；不能让未来事实变成在线决策。

### 执行工具集合

[Pi session runner](../../.pi/extensions/nmg/ooo-execution.ts) 区分两种工具集合：plain execution surface 按首个 attempt 所需工具选择；chain execution surface 则为多个 unit 一次注册工具并集。Chain 模式中，当前 unit 不可用的操作仍会被拒绝。Artifact schema 接受字符串形式的 conclusion kind，但 artifact envelope 与 host 仍验证结果。此能力不授权 fusion，也不证明产品 loop 接入；下方成本比较仍未定价。

## 离线：ceiling

合法图依赖状态，因此离线部分计算的是乐观投影，不是实时调度。`optimisticPlan` 将每个 unit 标为 accepted、未取消且 external-ready，同时保留其 declarations；随后仍调用相同的 `sharedSessionLegal`。`fusionGraph` 只保留 plan 顺序中较后的 unit，并排除当前 unit 传递依赖的 successor。这样能维持图无环，并防止 chain 在依赖项之前运行。

由此得到两个数：

- **下界**：结构关系传递时，偏序的最小链覆盖等于最大反链（Dilworth）；两者都可在关系的传递闭包二分图上计算为 `units - maximumMatching`。这是 plan 理论上可能需要的最少 sessions 数。
- **可行上界**：在声明的每 session cap 下贪心列表调度；按 plan 顺序遍历 unit，将每个 unit 追加到合法接收它的开放 session，优先选择当前最满者，否则新开 session。

这两个数的差距表示贪心规则相比结构下界多用了多少 sessions，不是经济价值。将避免的 session 数乘以显式 1 900 ms 假设，只会产生 wall-clock 投影。四单元 fine-plan cap 实验观测到 cap 1 到 cap 2 节省 8 451 ms，而平坦假设预测为 3 800 ms。D arm 数值不是稳定常量，cap 报告也没有保留 instrument commit（第三次重复使用了较新的 prompt）；所以这只是该样本的有限证据，不是经过校准的每-session 价格。

Ceiling 不会给 union tool surface 的额外 turn 或 chain **surface** 开销定价。首个 unit 多约 0.7k tokens 是 D arm 的单次运行观察，不是通用 surface 价格。四单元计划中，B vs cap1 的 wall 差为 3 607 ms（26 186 ms 对 plain cell 的两次重复中位数 22 579 ms），但报告不能证明 instrument commit 匹配；15 412-token 差也无法区分。Cap 报告早于 usage 拆分，因此 fused cell 的 provider 成本仍是**未定价**。[A-D 归档](../experiments/execution/archive/ooo-arms-2026-09-19/README.zh-CN.md)记录了这些边界；不主张普遍的 token 或成本收益。

## 何时可以进入 chain path

进入许可规则由决策记录拥有，而非在此重复：[何时可以进入 chain path](../decisions/implemented/2026-09-19-when-the-chain-path-may-be-entered.zh-CN.md)列出三个条件（语义允许、存在可继续的任务、host 支持 session reuse），说明由共享 runtime 决策、adapter 只提供 capability；fusion 不得放宽单任务 permission、input-version、cancellation 或 acceptance 检查，也不得放宽 parent 的联合 acceptance。该决策**不**声明经济性：本文只报告有限的 wall-clock 证据，并将 fusion 成本标为未定价。许可规则也不能证明产品现有的 `nmg_board` host path 会调用抽取出的程序化 loop；dispatch 决策将该接入延期。

## 当前 ceiling 能说明什么

完整责任边界见：[当前 ceiling 的含义](ooo-fusion-planning/current-evidence-boundary.zh-CN.md)。

## 为什么采用这种形状，以及它不是什么

有来源的借鉴：阶段屏障处重新规划（Spark adaptive execution 在 stage boundary 用运行时统计重新优化剩余 query）、ready-set scheduling（各类 workflow engine）、plan baseline（Oracle）、deterministic replay（Temporal）、通过 dwell time 和 hysteresis 抑制抖动（switched-system receding-horizon control），以及 Dilworth。

不借鉴，因为类比不成立：plan competition、eddies 和 speculative execution。它们假设重跑计划几乎免费且可重放；unit 是有副作用、不可重放的付费 model call，因此错误执行花掉的是钱，而不是可以收回的 CPU 时间。这也是不构建 speculative fusion 的理由：错误下注会毁掉下注所依赖的 session。

也不构建：plan cache、编译后的 plan artifact 或 chain-cover compiler。对几十个 unit 的 move 进行重新计算，只是少量输入上的纯函数；tensor graph 需要的 compile/interpret 区别——编译 artifact 代价高但会重复使用——在这里并不存在。再次决策比正确失效缓存更便宜。

## 义务

- 若真实 plan 上的结构关系并不传递，则不适用 Dilworth 下界；列表调度上界仍适用，测量必须报告这一点，不能假设传递性。
- 在线 move 必须与它使用的事实一起记录，否则“baseline”不可证伪。
- Ceiling 的毫秒投影取决于 startup 假设；后续运行若测得不同启动耗时，变化的是常数，不是方法。
- 此处任何内容都不得扩大 `sharedSessionLegal`。排序 candidate set 是对固定规则的策略。
