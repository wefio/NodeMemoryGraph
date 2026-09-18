# `ooo-cycle.ts`：该留的留、该合的合、该裁的裁

[English](2026-09-18-ooo-cycle-keep-cut-merge.md)

**Status:** proposed
**Relates to:** [任务单元语义设计](../../design/task-unit-semantics.md)、
[其义务台账](../../design/task-unit-semantics-obligations.md)、
[实验臂自建驱动器](../implemented/2026-09-17-arms-get-their-own-driver.md)、
[声明的槽位预算](../implemented/2026-09-18-declared-slot-budget.md)、
[长检查异步跑](../implemented/2026-09-18-detached-long-checks.md)

治理 meta-rule：[self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) ——
本变更改动模块结构，也改动一条与 Skill 相邻的约定（实验住在哪里），因此自带决策、替代方案与验收标准。

## 问题

`src/integration/ooo-cycle.ts` 共 1 082 行、13 个导出，是仓库里"主题是一次实验"的文件中最大的一个。
它的去向问题是 [2026-09-17 那个决策](../implemented/2026-09-17-arms-get-their-own-driver.md) 故意留下的——操作者选择
**推迟、而不是忘掉**"角色层 vs 机制层"的拆分——而这之后地基动了：实验臂有了自己的驱动器，daemon 有了运行面
（D13），协调器拥有了受协调写入与运行-entry 绑定（D11/D12），而普通协作路径已经不再需要轮次（G1）。

用一次性脚本在 `src/`、`evals/`、`tests/`、`tools/` 上实测（556 个文件；脚本与其 JSON 放在未跟踪的
`.temp/`，因为它是一次性的）：

| 量到的东西                                   | 结果                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对轮次**固定 A/B/C 名字**的引用              | **70 处**，分布在 44 个内部符号里的 17 个                                                                                                                                       |
| 模块内对**存储/看板端口**的调用              | **4 处**，在 3 个符号里（`trace`、`logContractError`、`runTask`）                                                                                                               |
| 两者都不碰的符号（`pure`）                   | **24 个**——验证、用例解析、前提检查、组合                                                                                                                                       |
| `runCycle` / `openRoundStore` 的运行时调用者 | **各 9 个文件，全部在 `evals/ooo-execution/` 下**                                                                                                                               |
| `src/` 下的调用者                            | **仅类型**：`WorkerMetrics`/`CycleWorker`（来自 `ooo-round-log.ts`）、`Requirement`（来自 `task-semantics.ts`）                                                                 |
| `tests/` 下的调用者                          | **无**                                                                                                                                                                          |
| 研究套件针对本模块钉住的用例                 | 约 84 个，分布在 11 个文件（`cycle` 46、`replay` 10、`patch-cycle` 10、`round-plan` 6、`notification` 4、`round-cli` 4、`cancellation` 3、`early-cancel` 1，外加 3 个驱动脚本） |
| 是否已登记为变异目标                         | **不是**——17 个目标，而它的兄弟模块都在其中（`ooo-board.ts`、`ooo-execution.ts`、`task-semantics*.ts`、`task-coordinator.ts`、`task-advisers.ts`）                              |
| 是否有路由拥有它                             | 没有路由匹配它——但 **`src/integration/**` 整片都不匹配任何路由**（`ooo-board.ts` 也一样），所以这条对轮次本身不构成证据，而是一个独立的预存缺口                                 |

也就是说，这个模块在"用途"上已经是一台住在 `src/` 里的研究仪器：产品不调用它，`tests/` 不调用它，
没有路由拥有它，没有 mutant 守着它，唯一练习它的是 advisory 的研究套件。与此同时它内部的编排——准备冻结工作、
claim、跑 worker、按冻结检查验证候选、组合改过的文件、跑父级检查——在 `evals/ooo-execution/plan-driver.ts`
里被**实现了第二遍**（`unitVerifier`、`runOneUnit`、`runParentCheck`），且基于同一组导入
（`BoardAdmission`、`verifyCandidate`、`preparePatchWork`）。

## 提案

三个去向，各自带上支撑它的那次测量。注意这**不是**"角色留这边、机制留那边"：机制部分只有 4 处调用点，
没有东西可拆。

**留。** 共享基元留在原处——它们是产品的，两边都在用：`ooo-board.ts`（admission、candidates、plan）、
`ooo-candidate.ts`（`verifyCandidate`）、`ooo-patch.ts`（`preparePatchWork`）、`ooo-mutation.ts`、
`ooo-round-log.ts`。产品从轮次模块消费的那两个类型搬到拥有该概念的模块，从而抹掉最后两条
`src/` → 实验 的边：

- `WorkerMetrics` 与 `CycleWorker` → `src/integration/ooo-round-log.ts`（它唯一的 `src/` 消费者）；
- `Requirement` → `src/integration/task-semantics.ts`（它唯一的 `src/` 消费者）。

**合。** 两处实现合成一处：

- 候选验证编排：轮次的 `verifyPatch`/`patchVerifier`/`composedVerifier`/`compose`/`buildResult` 与
  驱动器的 `unitVerifier`/`runOneUnit`/`runParentCheck` 是同一份职责、同一组基元，因此归一个家，
  轮次与实验臂驱动器都调用它（各自提供自己的 plan、角色与报告）；
- 存储/租约写入：协调器已经拥有它们，因此轮次只保留它需要的端口读取，不再充当第二条写入路径。

**裁。** S4 仪器离开 `src/`：

- A/B/C 角色脚本（那 70 处固定名字引用：`installA`/`installB`/`installC`、`dispatchPhase`、
  `outcome`、`reopenDependency`、`handlePushback`、`handleUnmetPrecondition` 等）与
  `openRoundStore` 移到 `evals/ooo-execution/`，与 `plan-driver.ts` 相邻；钉住它们的 11 个套件
  一起走，让仪器与它的用例保持同一件事；
- 轮次运行的存储按 D14 已经为驱动器做的方式托管（经 daemon 运行面），而不是第二个开启器。

顺序：先类型（它们有产品消费者），再合，再搬——并在同一个改动里更新台账里引用被搬套件的行
（`C2`、`D10`、`D3` 等），因为引用是义务的一部分。

## 考虑过的替代方案

- **原地保留。** 否决：实测它没有产品调用者、没有路由、没有 mutant、没有 `tests/` 调用者，并且与驱动器
  的编排重复。把它留在 `src/` 等于宣称一个没有任何证据支持的产品身份，还让两份实现继续分居。
- **把角色层与机制层拆开。** **依据实测否决**：模块内的机制是 3 个符号里的 4 处存储调用点，而角色硬编码
  有 70 处。拆出来的会是一个很小的机制模块和一个 `src/` 里没人调用的大角色模块——结果与"裁"相同，
  却多维护一条边界。
- **直接把仪器删掉**而不是搬走。否决：它持有若干义务唯一的钉（尤其是 D10 的提前取消分支与 C2 的
  租约边界重放），以及约 84 个需要在普通路径上重新推导的用例。删除是更后面的事，前提是驱动器的用例
  先覆盖那些性质。
- **把 `runCycle` 泛化到任意计划**（2026-09-17 的替代方案乙）。仍然否决：三个固定名字的 42 处引用让它
  变成一次重写，而且驱动器现在已经存在。

## 验收标准

1. `rg "ooo-cycle" src/` 只返回模块自身（类型搬完后没有任何 `src/` 文件导入它），且 `npm run check` 通过。
2. 被搬套件钉住的每一条性质仍然被钉住，且能指名：`early-cancel`（D10）、`cancellation`（3 例）、
   `replay`（10）、`notification`（4）、`round-cli`（4）、`round-plan`（6）、`cycle`（46）、`patch-cycle`（10）。
   evals 套件在同一个改动里跑绿，而且是**第一件事**做，不是最后一件。
3. 台账中证据被搬的行改为指向新路径，且计数仍然自洽。
4. 合完的编排是一份实现：轮次与驱动器都调用它，并且当任一方又长出自己的一份时，有一个具名检查失败
   （是检查，不是注释）。
5. `npm run agent:verify` 覆盖改动路径通过，`npm run mutation:teeth` 保持绿（该模块此前不是目标，
   也不要求它成为目标；若成为，需具名列出它的 mutants）。

## 风险

- **门禁会变弱，不会变强。** `evals/**` 不在任何 `tsconfig` 里（LSP 是唯一的类型门），其套件在 CI 里是
  advisory，所以把一个模块搬过去会降低它的正式覆盖。实测的反驳是：今天它是一个没有变异目标、没有路由、
  `tests/` 不碰的文件，唯一练习它的正是这些套件，因此这次搬动是把真实覆盖写明，而不是继续暗示产品覆盖。
  若轮次的性质值得阻塞覆盖，诚实的修法是在普通路径（它们的 owner）上钉住，而不是把这个文件留在 `src/`。
- **D、E 两臂可能需要角色机制。** 角色正是为它们存在的，而搬动之后它们要伸进 `evals/` —— 而那两臂本来就住在
  `evals/`。这是当前布局唯一站得住的论据，也是搬动选择**保留**角色脚本（而不是删掉）的原因。
- **有两个活事实会改变结论。** 若某条产品路径开始采用 `runCycle`（今天没有），或实验臂驱动器被轮次取代
  （没有这种证据），结论应当重读而不是照搬。
- **测量时浮出一个无关的缺口**：没有任何路由匹配 `src/integration/**`，`ooo-board.ts` 与
  `task-coordinator.ts` 也一样。这是一个有自己决策的路由缺口，不属于本次范围；记在这里只是为了让上面的测量
  不被读成"轮次很特别"。
