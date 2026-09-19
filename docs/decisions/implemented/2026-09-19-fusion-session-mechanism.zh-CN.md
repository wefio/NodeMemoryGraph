# 融合机制：一个 run 一个会话

[English](2026-09-19-fusion-session-mechanism.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [pilot 与其上限](2026-09-18-fusion-and-speculation-pilot.zh-CN.md)、[融合合法性与其记账](../implemented/2026-09-18-fusion-legality-and-accounting.zh-CN.md)

实现证据：`.pi/extensions/nmg/ooo-execution.ts` 的 `createPiSessionRunner` 与 `patchSessionInput` 通过 `UnitState` 盒子让每次运行持有一个会话，`executePiInputWith` 委托给它，扩展因此只保留一套 tool surface，`evals/ooo-execution/plan-driver.ts` 的 `piSessionWorker` 每个 session id 持有一个 runner。冒烟结果显示两个单元同处一个会话（`sessions: [["alpha","summary"]]`，21k tokens）。仍未完成的不再是机制：产品侧还没有调用方去决定复用会话。

## Problem

F4 落了融合的**策略半**（`PlanDriverSpec.fusion`、`PlanSession`/`PlanRun.sessions`、`piWorker` 按名拒绝续接），
**机制半**仍是空的：活体 worker 每次调用新建会话，于是融合的活体臂没有东西可复用。pilot 提案把这件事报成了
**阻塞**——那等于把一个缺失的机制说成了设计的属性，并且让已批准的预算躺在那里没花。它是缺失的机制，而设计
已经写明它该是什么。

## Decision

`.pi/extensions/nmg/ooo-execution.ts` 每次调用创建 `ModelRuntime`、一个内存会话、一套工具、一个 prompt，
然后销毁会话。三个事实让它无需新的 SDK 能力就能复用：

- `session.prompt(...)` 可以在活着的会话上再次调用；会话的消息列表**正是**融合要复用的共享上下文。
- 四个工具本来读的就是宿主持有的**可变**状态（`{ artifact: string | null; abort }`、`{ report, abort }`、
  `{ value: number }`），所以工具可以持有一个**盒子**、在调用时读当前单元的取值，而不是闭包捕获。
- 工具面在会话创建时固定，因此一条链注册"其单元可能用到的并集"，每个工具在当前单元没有该能力时**按名拒绝**。

于是：把四个工具工厂捕获的逐单元取值换成一个 `UnitState` 盒子，把会话/prompt 循环放进
`createPiSessionRunner({ provider, modelId, limits, surface })`，对外暴露 `runUnit(input): Promise<PiRun>` 与
`dispose()`。`executePiInput` 变成"只有一个单元的 runner"——**一条代码路径，工具面不复制**。runner 逐单元重指
盒子、重置 `reads`/`runs`/`turns`/`artifact`/`report`、保留会话，并报告**逐单元 token 增量**（会话总量减去单元
开始时的量），与会话总量并列——因为融合的主张就是"后一个单元的增量小于新建会话"。

随后在 `evals/ooo-execution/plan-driver.ts` 里加 `piSessionWorker`：每个 session id 持有一个 runner，并报告
`metrics.sessionId`——正是 driver 已落地的融合路径所读的东西。

两个后果在这里定下，而不是留到以后发现：

- artifact 工具的 `conclusion` schema 是**冻结的**准入种类的字面量联合，逐单元不同；而链只在创建时注册一次
  工具面，因此链上使用 `Type.String()`，依靠 `artifactEnvelope`（它本来就拒绝臆造的种类）与
  `constrainedSampling: prefer`。紧字面量只留在单单元路径上。
- 今天一个 `ModelRuntime` 的 signal 覆盖整次调用。链需要**逐单元**中止（单元定时器里 `session.abort()`）与
  链级预算，因此 runtime 创建时不带逐调用超时，由单元定时器负责取消。

## Alternatives considered

- **把设计自己的降级方案（新会话 + 已接受字节种子）当作融合臂。** 拒绝：它在启动时什么都省不下来，而启动正
  是融合要消除的成本。它继续作为降级方案存在，设计本身也已写明那是顺序交接而非融合。
- **另写一个链式 runner，自带一套工具副本。** 拒绝：一个安全形状的工具面（一次有界读、一个固定检查、一条
  artifact 通道）出现两份必然漂移，而漂移的那一份是没人 review 的。
- **在 driver 里把采纳或融合变成强制。** 拒绝：策略半已经落地且诚实；缺的是执行，不是调度。

## Consequences

机制落地时三条验收标准均已满足：扩展只保留一套 tool surface 并委托给 runner；冒烟里两个单元同处一个会话；随后各付费臂按记录跑完。

1. `executePiInput` 委托给 runner，且 extension 里只有**一套**工具面；`npm run lint` 与 `npm run check` 通过，
   并且所有既有活体路径（适配器、F3 的 pilot）仍走同一条路。
2. 用 `deepseek/deepseek-v4-flash` 做一次"同会话两单元"的活体冒烟：两个单元报同一个 `sessionId`，且第二个单元的
   token 增量低于新建会话做同样工作的量——融合假设的缩微版。花费控制在 ~10–30k token 内。
3. 随后按[提案](2026-09-18-fusion-and-speculation-pilot.zh-CN.md)记录的付费 pilot 执行：D 臂 `{unfused, fused}`、
   以及 F5 之后的 E 臂 `{无推测, 一个事实推测}`，各 3 次重复，分别报告时延、额外成本、token 与质量；在已记录的
   1000k 上限内，**一旦测度可决断即停**。
4. 融合臂若连自己的检查都达不到，记为**机制**结果（"not ready"），绝不记为成本结果。

## Risks

- extension 随产品发布，在这里重构是风险最高的地方。缓解：让单单元路径与链式路径**是同一段代码**（每次活体运行
  都在跑这个 runner），加上 lint、check 与冒烟三道门。
- 链上放宽 artifact schema 会失去采样期的字面量约束。缓解：`artifactEnvelope` 校验种类，宿主仍校验结果，
  且放宽只限链上。
- 长链会把上下文并成一个，这既是节省也是风险；compaction 保持禁用，pilot 的逐臂 envelope 限制让链有界。
- 若不在可决断时停下，花费会漂移。缓解：已记录的上限，以及"成本结果不决断就停臂、而不是买更多重复"的既有规则。
