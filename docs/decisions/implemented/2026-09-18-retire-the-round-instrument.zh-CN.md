# 退役轮次仪器：有家的分发到各家，其余删掉

[English](2026-09-18-retire-the-round-instrument.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [任务单元语义设计](../../design/task-unit-semantics.md)、
[其义务台账](../../design/task-unit-semantics-obligations.md)、
[实验臂自建驱动器](../implemented/2026-09-17-arms-get-their-own-driver.md)、
[声明的槽位预算](../implemented/2026-09-18-declared-slot-budget.md)

治理 meta-rule：[self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md)。
本记录取代以 `7821c5ed` 提交的处置草案（"留/合/裁"）——那份草案问的是"要不要把轮次的角色层与机制层拆开"。
实测回答了这个问题，随后操作者选择**分发 + 删除**，而不是把模块整体挪走。

## 问题

`src/integration/ooo-cycle.ts`（1 082 行、13 个导出）是 S4 越序仪器。
[2026-09-17 的决策](2026-09-17-arms-get-their-own-driver.md) 故意推迟了它的去向，而地基此后动了：实验臂有了
自己的驱动器，daemon 有了运行面（D13），协调器拥有受协调写入与运行-entry 绑定（D11/D12），普通协作路径
不再需要轮次（G1）。

在 `src/`、`evals/`、`tests/`、`tools/` 上实测（556 个文件；一次性脚本与其 JSON 在未跟踪的 `.temp/`，
因为它们不是维护中的入口）：

- 对轮次固定 A/B/C 名字的引用 **70 处**，分布在 44 个内部符号里的 **17** 个；
- 模块内对存储/看板端口的调用只有 **4 处**，因此"角色层 vs 机制层"这个框子几乎没有机制可拆——该替代
  方案**依据实测被否**；
- `runCycle` 与 `openRoundStore` **各 9 个调用者，全部在 `evals/ooo-execution/` 下**；`tests/` 无调用者；
  `src/` 下的唯一调用者是类型导入；
- 它**不是**已登记的变异目标，而它的兄弟模块都在 17 个目标里；
- 它的候选验证编排在 `evals/ooo-execution/plan-driver.ts` 里基于同一组导入**实现了第二遍**。

决定性的问题是：轮次是否承载着驱动器缺少的能力。对设计所关心的那条性质而言，答案是"没有"。一次性探针
（`.temp/ooo-interleave-probe.ts`）跑了一个双单元计划、两个槽位，其中单元 A 的检查 sleep 约 3 秒：**B 的
worker 窗口 1505 ms 完整地落在 A 的检查窗口 3923 ms 之内**，`slotsUsed=2`，顺序为
`A-start, A-end, B-start, B-end`。因此"A 的检查在飞时 B 在工作"用驱动器的 `plan + 槽 + 每单元检查`
词汇就能表达——**不需要角色**。

## 决策

把有家的部分分发到各自的家，然后删除该模块及只服务于它的一切。

**搬到各自的概念所有者（它原本在 `src/` 里仅有的两个消费者）：**

- `Requirement` → `src/integration/task-semantics.ts`：那里本来就定义了"对依赖产物被接受"的前提，
  而且就是导入该类型的文件；
- `WorkerMetrics` → `evals/ooo-execution/plan-driver.ts`：一旦轮次与 `ooo-round-log.ts` 消失，它是唯一
  剩下的消费者。产品的运行面今天不记录 worker 费用（实测：`src/integration/ooo-execution.ts` 里没有
  `tokens`/`metrics`/`cost`），因此为它保留一个产品之家只会成为无人使用的产品表面。

**证据改钉，因为实现者本是产品、只有夹具是轮次：**

- D9（提交后的通知失败被记录、不被抛出）的实现在 `src/integration/ooo-board.ts`
  （`lastNotificationFailure()`），不在轮次里——那个 evals 套件自己也这么写明：它用真轮次只是因为
  artifact 信封是 board 的事。该性质改钉在 board 上，落在 `tests/`（产品义务该在的地方），并且手动变异
  （去掉提交后通知外围的守卫）必须仍然让它失败。
- S4 的越序性质在 `evals/ooo-execution/plan-driver.test.ts` 里获得自己的用例：两个槽位下，一个单元的
  worker 在另一个单元的检查尚未完成时运行。这是该性质**第一次**钉在实验臂真正使用的机制上；当驱动器的批
  循环不再重叠时它会失败。

**删除（无家，`src/` 里没有调用者）：**

- `src/integration/ooo-cycle.ts` 与 `src/integration/ooo-round-log.ts`；
- `evals/ooo-execution/` 下的：`round-runner.ts`、`round-compare.ts`、`round-spec.ts`、`live-cycle.ts`、
  `probe-check-duration.ts`，以及套件 `cycle.test.ts`、`replay.test.ts`、`notification.test.ts`、
  `round-plan.test.ts`、`round-cli.test.ts`、`cancellation.test.ts`、`early-cancel.test.ts`；
- `DEFAULT_ROUND_PLAN` 与无剩余消费者的类型（`CaseRule`、`CycleWorker`、`CheckRunner`、`CycleOptions`、
  `CycleResult`、`OooRoundOperations`、`WorkerResult`、`CheckOutcomeSummary`）——2026-09-17 记录里说的
  五个共享类型，收敛为搬走的两个。

**保留，且已核实与轮次无关：** `plan-driver.ts` 及其套件、`round-client.ts` 与 `round-host.ts`
（D14 的 daemon 证据，服务的是 store 而不是轮次）、`board-*.ts`、`board-slots.test.ts`、
`narrow-dispatch.test.ts`、`patch-cycle.test.ts`、`cost-model*`、`families.test.ts`、`live-patch.ts`、
`live-continuation.ts`（G7 的可执行检查——实测不导入轮次任何东西）、`pilot.ts`、`rename-probe.ts`、
`report-family.test.ts`。

**台账，同一个改动内：** D10 改写为"无对手可失败"（该行的措辞本就是 `runCycle` 的提前取消分支，而没有轮次
之后就没有谁借用 store 再关闭它——B7 先例）；D9 的证据改指 board 那条测试；G4 的 cancel 半指向已经覆盖它的
产品测试（`tests/integration/ooo-round-query.test.ts`，"the terminal decision outlives the host that made
it"）；台账末尾那段过时的收尾文字一并修正。除此之外没有行引用被退役的套件：约 84 个用例里只有那三处承载
义务。

## 考虑过的替代方案

- **原地保留。** 否决：没有产品调用者、没有路由、没有 mutant、`tests/` 不碰、驱动器编排的第二份实现，
  而且把仪器的主题留在 `src/`。
- **拆开角色层与机制层。** 依据实测否决：4 处存储调用点 vs 70 处角色引用，而角色存在的理由（越序）已经由
  驱动器承载。
- **把模块与套件整体挪到 `evals/`（草案的"裁"）。** 操作者否决：那会造出一个没人拥有的 1 082 行模块，
  并保留下只为轮次服务的机械。
- **保留 `round.jsonl` 的重放与比对作为研究方法。** 操作者否决：`plan-driver` 已取代
  `round-runner`/`round-compare`，而设计本就把 `round.jsonl` 归为导出（"可导出作研究重放"，文件不决定
  任何状态），所以重放服务的是仪器，不是产品。
- **不重新安置、直接删。** 否决：D9 的证据与越序性质会一起消失，而这两者都能被便宜地钉在留下来的机制上。

## 后果

- `src/` 不再包含实验文件；轮次的 1 082 行离开产品树，驱动器成为唯一的研究侧运行器。
- 轮次携带的重试机械——pushback、被重开的依赖、未满足前提、`handlePushback`/`reopenDependency`/
  `handleUnmetPrecondition`——一并消失。没有任何台账行钉它，也没有产品路径使用它，但设计 E 臂（有预算
  推测）将来可能需要"作废重做"；若需要，那是 E 臂自己的需求、实现在驱动器上，而不是保留这个文件的理由。
- 从 `round.jsonl` 重放真实运行的能力随之消失。归档的运行
  （`docs/experiments/execution/*`）仍作为"实验确实发生过"的证据存在；要重跑它们，得为驱动器重建一条导出
  通路。
- `evals/` 的套件数减少十二个文件，而幸存的驱动器套件承载了此前唯有轮次端到端承载的那条性质。

## 本次改动据以验证的内容

1. `rg "ooo-cycle" src evals tests tools` 返回空（该名字只留在实验记录与决策里描述历史）。
2. board 的提交后通知测试在移除守卫后失败，且 D9 的证据指向它。
3. 驱动器的越序用例在批循环不再重叠单元时失败。
4. `DEFAULT_ROUND_PLAN` 与那八个无引用类型在任何地方都不再被引用。
5. `npm run check`、`npm run docs:check`、`npm run test:product`、幸存的 `evals/ooo-execution/` 套件、
   `npm run mutation:teeth` 与覆盖改动路径的 `npm run agent:verify` 全部通过。

## 风险

- **仪器自有的契约网消失**（约 62 例）。它们钉的是轮次的行为，不是设计义务，而 `tests/` 从未覆盖过该模块；
  替代物是驱动器自己的套件加那两处改钉。若将来的实验臂需要轮次的语义，那就明确重建。
- **两类历史此后缺少活的对手**：`early-cancel` 的分支与重放格式。两者都在此记录为"已退役"，而不是留下一行
  指向已删文件的过时引文。
- **测量时浮出一个独立的预存缺口**：`agent-context.yaml` 里没有任何路由匹配 `src/integration/**`，
  `ooo-board.ts` 与 `task-coordinator.ts` 也一样。那有它自己的决策；记在这里只是为了让本记录的测量不被读成
  "轮次很特别"。
