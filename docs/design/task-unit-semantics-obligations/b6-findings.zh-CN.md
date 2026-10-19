# B6 发现：受管理写入与 runner 接入缺口

[English](b6-findings.md) · [术语](b6-findings.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## B6 发现：受管理写入与 runner 接入缺口

B6 要求：对受管理条目的生命周期写入，必须在同一个协调事务中更新 board 并追加对应运行事实。普通未绑定 handoff 也通过通用 board verb 进行 claim、deliver、judge、resolve；若拒绝所有这类 verb，产品正常路径也会被破坏。Store 必须根据已记录的 binding 判定条目是否受管理，而不能相信调用方自报。

当前 daemon 路径通过 `bindRunEntry()` 记录 `entry-bound`；`createBoundEntry()` 在同一事务中创建并采用条目。`coordinatedEntryWrite()` 将已采用条目的生命周期 verb 路由到 coordinator；离开该作用域的直接写入会被拒绝。事务 port 使 board 更新和运行事实原子提交。未绑定条目仍走普通 board 路径。详见[运行记录设计](../task-unit-semantics/run-record-ownership.zh-CN.md)及[生命周期证据](lifecycle-and-integration-prerequisites/host-lifecycle-run-records-and-daemon-clients.zh-CN.md)中的 D11–D13。

证据覆盖两条路径。研究工具测试 `tests/integration/ooo-managed-fence.test.ts` 直接触达 `BoardAdmission`，因为调用方 `live()` 检查可能先行拒绝，从而遮蔽 Store guard 的缺陷；其 commit-window 用例在验证期间撤销 claim，要求 `commitArtifact()` 在验证后重新检查。该测试只证明研究 board 的围栏。产品路径测试 `tests/integration/ooo-managed-adopt.test.ts` 与 `tests/integration/ooo-managed-write.test.ts` 经 daemon coordinator 检查创建/绑定原子性、拒绝情形，以及 board 转移与运行事实同时成功或失败。两类证据都不能证明所有研究 runner 已接入。

## 研究 runner 边界

研究驱动仍使用独立存储路径：`plan-driver.ts` 用研究 `databasePath` 构造 `BoardAdmission`，而 `live-continuation.ts` 直接打开 `NmgStoreBase`。两者都未使用 daemon `taskRun`，其写入尚未经过受管理条目 coordinator。证据驱动的 daemon-client 边界是另一项 D14 结果，不会自动补上 runner 缺口。不得把 daemon managed-write 的证明描述成这些研究 runner 已完成接入。

规则归[运行记录归属](../task-unit-semantics/run-record-ownership.zh-CN.md)所有；当前证明行见[持久化台账](persistence.zh-CN.md)。可选源码 mutant 名称由 [`tools/mutation-teeth.ts`](../../../tools/mutation-teeth.ts) 维护。
