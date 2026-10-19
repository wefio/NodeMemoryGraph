# 运行记录的物理归属与唯一写入者

[English](run-record-ownership.md) · [术语](run-record-ownership.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.zh-CN.md).

## 运行记录的物理归属与唯一写入者

目标选定为：不能重建的运行事实位于当前 NMG daemon 所拥有的 SQLite 数据库，与 `task_board_entries` 同库、同连接、同事务；OoO 任务状态则是这些事实的可重算视图，不建立权威的 `ooo_tasks` 状态表。不为生产轮次创建 `<runDir>/store.sqlite`，不建立跨库状态引用或对账流程。数据库位置服从 daemon 已有配置，不增加路径配置。

唯一物理写入者是该 daemon；唯一运行状态转移入口是 daemon 内共享运行协调服务，经注入的 Store 事务操作执行。runner、harness、worker、status/cancel 客户端不打开可写数据库，也不各自构造 `BoardAdmission`。多个协作者可以提交请求，不能各写一份状态。共享协调器不继承 Store 来获得另一条连接；宿主模型循环和检查子进程仍在事务外运行，只回报带票据的事实。

新增持久化只承担两类事实：不可变的运行 manifest（冻结现有计划、配置与版本），以及 board 没有的追加运行事实。可以分别用 manifest 表与事件表实现，但不得增加与 board 竞争的每任务当前状态表。下面固定事实 owner；物理表名以迁移实现为准，同库与权威分工不变：

| 事实 | 权威位置 | 写入与读取规则 |
| --- | --- | --- |
| runId、冻结计划/验证配置、输入及摘要、保留策略 | 不可变运行 manifest | 协调服务经 daemon Store 注册；依赖图从计划派生。新计划产生新版本，不能覆盖旧输入 |
| 逻辑任务与 board entry 的绑定、检查签发与终态、候选字节或内容寻址引用、取消事实 | 同库追加运行事实，键含 runId/sequence，任务事实另带 taskId/attempt | 只保存不能从 manifest 或 board 推导的事实；取消事件与 board 围栏操作原子提交。候选存在不等于接受 |
| claim owner、lease、attempt、deliverable、独立 verdict、resolve | 现有 board 记录 | board 生命周期操作是唯一写入逻辑；受管理条目的通用写请求也必须经过同一协调事务，禁止直接 judge/resolve 绕开运行围栏 |
| 费用、执行尝试观察与恢复证据 | 同一追加运行事实 | 外部结果由宿主报告、协调服务验证后写；worker 不批准自己的产物。重复结果幂等，旧代次拒收；board 转移的历史可在事务内记录，但当前 board 状态仍只读 board |
| ready/blocked/accepted 任务集合、依赖满足、取消后的有效性、融合候选 | 无权威存储；从上述来源计算 | 同一共享派生函数服务 status、next 与依赖解锁；可缓存，不允许独立写入或修复缓存来改事实 |
| 研究 JSONL/JSON 与工作目录日志（含 `run.jsonl`） | 文件产物 | 不具权威状态；退役的 `RoundLog/round.jsonl` 仅属历史；导出失败不回滚已提交判定 |

事务内同时完成版本/租约/取消校验、board deliver/judge/resolve、产物关联与事件追加；失败则全部回滚。外部验证收据先生成，入事务后重核绑定，不能在持有写事务时等待模型或检查进程。断线重试以 run/task/attempt 和事件身份去重；未知检查结果保持无法判定，不从 PID 消失推断成功。

接受查询与依赖解锁必须调用同一谓词：绑定 entry 对当前产物 digest 的有效 board verdict，加当前运行版本与围栏检查。不得一条路径看 board verdict，另一条仅检查 artifact 非空。历史 event 中曾 accepted 不表示当前仍 accepted。

### 事务参与与连接生命周期

完整事务与连接契约见[子文档](run-record-ownership/transactions-and-connections.zh-CN.md)。

### 运行面的形状

另一个进程到达运行事实的唯一入口是 daemon 的 `taskRun`：`register`（注册运行身份，同一计划只能注册一次）、`freeze`（一次转移冻结整份计划，位置取数组顺序，悬空依赖与自依赖在冻结前按名字拒绝）、`bind`（把已存在条目绑到已冻结任务）、`cancel`（取消整个运行，或计划中的某个任务）、`status`（读回运行记录）。`taskBoard` 的 `put` 增加可选 `adopt`，使“创建条目”与“绑定”落在同一转移里：先建后绑是两次调用，中间崩溃会留下一个没有运行管理的条目，正是本围栏要消除的洞。取消事实的唯一写入者是 `cancelRun`：围栏与派发派生都读它，而在这之前 `src/` 里没有任何写入者，即“运行已取消”这个状态只能由测试直接 append——真实客户端不可达。`status` 是纯读：不注册、不追加、不迁移、不发布，也不派生 ready/blocked/accepted——那是共享纯函数在同一批事实上的结果，在这里再算一遍就是设计禁止的第二份真相。

这些加法在兼容 epoch 内，不推进 epoch：旧同 epoch daemon 缺 `taskRun` 时由客户端报“能力不可用”，而它会静默忽略 `put` 的 `adopt`（该字段与 `taskRun` 同一次变更引入，描述符目录在 daemon 生命周期内冻结）——所以客户端只在 `hello.methods` 含 `taskRun` 时才发这个字段，epoch 规则因此无需变动（见 [design.md](../design.md) 的兼容性段落）。CLI 只暴露操作者需要的一半（`nmg run status`、`nmg run cancel`）；运行自己的转移由 runner 用 daemon 客户端调用，不为它们另设人类入口。

客户端的边界按“服务者可能被堵住”来设计，而不是按“它总会回应”：同一进程既服务端点又同步等待子进程时，它永远回不了那个请求，这不是事务或锁能修的问题（写入者、`BEGIN IMMEDIATE`、围栏都已经是最悲观的），而是回复机制本身被占用。因此 `taskRun`/`taskBoard` 的调用都有上界，超时按名字报出上界、端点与持有该端点的 pid，而不是把传输层自己的超时抛给调用者；并且**客户端不调用自己服务的端点**：租约记录里的 pid 就是服务者的 pid，所以这是可判定的，宿主自己的调用走进程内的 round 入口（`round-host.ts` 的 `host.call(...)`），需要走线的客户端则由独立进程的宿主服务。

### status 借用视图的形态

当前 CLI `taskRunStatus` 以 typed Store 查询返回 manifest/tasks/facts/bindings，不派生 ready/blocked/accepted，也不向 wire 暴露 Store。下述窄查询端口是新 status 投影的 owner 边界；研究侧另有 `RoundQueryPort/openRoundQuery`，不是 daemon taskRun 路径。共享 daemon status 应复用现有连接和派生函数。端口只有类型化查询方法，不暴露写方法、连接、任意 SQL、事务控制或 close；构造不创建连接。只读是调用方的能力范围，不能在共享连接上设置 `query_only` 影响写请求。

查询不得调用带迁移、懒清理、租约晋升或 handoff 发布副作用的 Store 方法。到期状态在查询视图中计算，必要的持久清理由独立写入口负责。status 与调度读取同一套事实和判定规则，但 status 不因发现待处理事项而执行它们。

离线宿主查看已有私有轮次库时，允许由该宿主通过 Store owner 的只读打开路径创建独立连接，并负责释放。该路径使用真正的只读数据库句柄；跳过迁移、初始化、写型 PRAGMA 和关闭时的 checkpoint。独立连接可额外设置 `query_only`，但它不能代替真正的只读打开。共享层可提供这个 owner 工厂，`src/integration` 的 status 消费者不能自行按路径创建句柄。两条路径复用查询实现，不复制状态逻辑。

不以 `BoardAdmissionOptions.view` 将初始化/执行类改成多模式查询类；采用 owner 提供查询端口、外层宿主拥有连接的组合。`NmgStoreOptions.readOnly` 若用于实现独立只读打开，属于 owner 工厂配置，不进入 round 票据，也不成为每个调用方切换连接的开关。cancel 走正常可写操作端口；它不能通过重新构造 BoardAdmission 顺带初始化不存在的 run。

库不存在、schema 缺失或不支持、指定 run 不存在均明确拒绝，并区分错误原因；不得创建库、迁移旧库或返回“空运行”。只有存在有效 manifest 且 schema 可识别、run 身份匹配时，才能报告“运行存在但尚无事件”。旧 schema 若已有明确支持的只读解析规则可读取，否则报告不支持；不能通过默认空字段掩盖未知格式。

接入验证分开覆盖两种形态：共享端口构造/查询不写入且不暴露写入或关闭能力，释放视图后 owner 仍能读写；离线只读打开不创建缺失文件、不迁移旧 schema、不执行写入或 checkpoint，且宿主关闭自己创建的句柄。两者在相同事实快照与求值时间下给出一致结果。独立只读连接的变异检查需单独把只读打开退回可写，证明测试能抓住它，即使 `query_only` 仍在；只测试最终写入被拒绝不足以区分这两种保护。

### 重算的范围与代价

视图可写为 `derive(manifest, boardSnapshot, runFactsThroughSequence, now)`。一次求值使用一致的数据库读快照与固定的 `now`，否则可能把旧 claim 和新判定拼在一起。租约是否到期依赖时间，不能只按事件序号缓存；缓存至少绑定事实版本，并在相关租约边界失效。缓存丢失只影响性能。

两个调用者可以同时算出同一个 ready 任务，但只有 daemon 的原子 claim/围栏校验能授予执行权；重算不代替并发控制。提交时再次验证，不能拿较早算出的 ready/accepted 视图当写入许可。

重算只回放已记录事实，不重新调用模型或重新运行检查来猜历史。执行已发出但进程在记录结果前崩溃时，结果是 unknown；只有外部提供幂等查询或该操作明确可重入时才能恢复/重试，不能因记录缺失断言从未执行。非幂等外部操作不在首版范围内。

首次可直接按计划和事实扫描重算；规模扩大后用有版本键的内存缓存或可删除 checkpoint 优化。只有测出重算瓶颈才增加物化视图，且须证明删掉它能从权威来源恢复。不能为省一次 join 而把 accepted、attempt 或 lease 复制成另一份真相。

board TTL 需要显式的运行保留关系：运行记录引用的交付/判定条目在运行可恢复或证据保留期间不能被普通 TTL prune 删除，即使已 resolve 或轮次终止。未绑定的普通 board 条目维持原 TTL。运行到期且无在途工作/依赖引用后，由 daemon 的显式运行 GC 在同库事务中清理引用及关联记录；不承诺 GC 后仍可恢复。历史若需长期保留，先导出，再删除，不能仅保留失效的跨表指针。

### 当前实现与接入前置条件

当前研究路径仍自有存储：粒度臂 [plan-driver](../../../evals/ooo-execution/plan-driver.ts) 用 `spec.databasePath`（缺省 `:memory:`）构造 [BoardAdmission](../../../src/integration/ooo-board.ts)；[live-continuation](../../../evals/ooo-execution/live-continuation.ts)直接打开 `NmgStoreBase`。`round-runner.ts`/`runCycle` 已于 2026-09-18 退役（[决策](../../decisions/implemented/2026-09-18-retire-the-round-instrument.md)）。现行 `ooo_probe_*` 表按 `run_id` 分区，channel 来自 `roundChannel(runId)`；多轮须指定 run，旧单行 meta 只用于迁移。daemon `taskRun` 已有 `register/freeze/bind/cancel/status`，但两个研究驱动未接入。三个证据驱动（[board-worker](../../../evals/ooo-execution/board-worker.ts)、[board-deliver](../../../evals/ooo-execution/board-deliver.ts)、[board-judge](../../../evals/ooo-execution/board-judge.ts)）经 [round-client](../../../evals/ooo-execution/round-client.ts) 访问 [round-host](../../../evals/ooo-execution/round-host.ts) 服务的 store；无 host 时按名拒绝。

共享 `acceptedFact`/`isAccepted` 按 digest、verdict、revision 和取消统一判定；`BoardAdmission` 的接受查询与依赖释放共用它，并 pin 所引用条目，故此路径无已知 TTL 分离。daemon `taskRunStatus` 只返回 manifest/tasks/facts/bindings；`task-coordinator` 绑定并协调写入，但未自动调用 `retainTaskBoardEntry`。daemon 路径仍需运行保留关系及同一 status/依赖规则。旧 `ooo_probe_tasks` 仅作迁移输入，现行表已拆为 run-scoped manifest/facts/derived view。退役 `RoundLog` 与 `run.jsonl` 是文件，不是原子运行权威。

事务与生命周期静态审查定位到以下接入依据；它们尚未由本次文档修改修复：

- `BoardAdmission.transaction()` 现在委托 `NmgStore.writeTransaction()`；发布时传递活动的 `TransactionPort`，`putTaskBoardEntry()` 通过 `withPort()` 加入同一事务。daemon 的 managed board 写也经 `coordinateRunWrite()` 与同一 port 追加运行事实。当前实现不再支持“两个独立 BEGIN”的说法；未来每个受管理写入仍须传递活动 port，不能猜测事务所有权。
- `runCycle`（已随轮次退役）的早取消路径是历史依据，不代表当前 runner。`plan-driver` 在 `runParentCheck()` 后关闭自建 `BoardAdmission`；`live-continuation` 在 `finally` 中关闭自有 `NmgStoreBase`。daemon 借用模式不得照搬本地 close 路径；外层资源作用域须覆盖初始化，各宿主的异常退出清理按实际 owner 审查。
- `submit()` 在 `commitArtifact()` 后等待 `afterCommit` 并发布：后续异常发生时提交已经生效。接入接口需要明确提交结果与通知失败，不假定一次抛错证明数据库未提交。

这三条依据在本分支上的当前状态与逐项证据见 [task-unit-semantics-obligations.md](../task-unit-semantics-obligations.md) 的 D 组。

迁移顺序中的纯语义视图、daemon `taskRun` manifest/facts、受管理 board 写入和多轮命名空间已有实现；研究 runner 尚未经该 run namespace 接入，且 taskRun 的 board-entry 保留关系仍待落地。旧私有轮次只读保留作研究证据，不与新运行双写；需要重放时以新 runId 显式创建新轮次，不把旧 accepted 导入为新轮次接受。新运行身份与旧日志格式不兼容时明确拒绝，不能默默回放。
