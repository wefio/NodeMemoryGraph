# 契约义务：每行一项

[English](task-unit-semantics-obligations.md) · [术语](task-unit-semantics-obligations.terms.yaml)

**Authority:** `docs/design/task-unit-semantics.md` 及其责任子文档的证据台账；每行对应这些契约的一项义务。进度按状态移至 `proven` 的行数计算，不按编辑次数计算。

下方链接到各责任子文档；原先“下文”的引用也包含这些子文档。[历史验证阅读记录](../experiments/verification/task-unit-semantics-ledger-readings-2026-10-14.zh-CN.md)保留其原始工具与日期，不表示本次整理重新运行了验证。

截至此版本，根据下方行项计数：**A** 6 项已证明；**B** 8 项已证明，B7 不适用；**C** 4 项已证明；**D** 12 项已证明，D7/D10 因其所属 round 已退役而不适用；**E** 9 项离线 seam 证明，但没有接入的 HA/MGR 调用方；**G** 2 项已证明、3 项部分覆盖、1 项尚欠、1 项在研究路径上测量。F 各 arm 的状态与样本边界见[实验 arm 记录](task-unit-semantics-obligations/experiment-arms.zh-CN.md)：付费 D arm 已测量，E arm 没有观察到实际收益。数值及其限制由[试验记录](../experiments/execution/ooo-arms-pilot-2026-09-18.zh-CN.md)和[归档](../experiments/execution/archive/ooo-arms-2026-09-19/README.zh-CN.md)拥有；本台账不声称重新运行了它们。

## 如何阅读本台账

行项遵循设计顺序。`proven` 表示具名测试断言了规则，且规则遭破坏时测试会失败；`partly` 表示预期行为或路径只有部分实现/覆盖；`owed` 标记当前缺口；`measured` 记录有界实验，不是产品证明。所有结论都限于测试实际经过的路径。要区分研究路径和产品路径，请先读[证据边界](task-unit-semantics-obligations/proof-evidence-boundaries.zh-CN.md)。mutation tooth 根据当前源码解析具名规则、操作符和语法选择器；定义及退役标准归[mutant-anchor 决策](../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.zh-CN.md)所有。`npm run mutation:teeth -- --anchors-only` 只检查选择器是否仍适用，不运行测试套件，也不证明行为。

## 证明位于何处：两类证据基底，彼此不能替代

完整责任见[证据边界子文档](task-unit-semantics-obligations/proof-evidence-boundaries.zh-CN.md)。

## 产品调用路径审计（2026-09-20）

完整责任见[产品调用路径审计](task-unit-semantics-obligations/product-call-path-audit-2026-09-20.zh-CN.md)。

## A. 离线语义

完整责任见[A. 离线语义](task-unit-semantics-obligations/offline-semantics.zh-CN.md)。

## B. 持久化

完整责任见[B. 持久化](task-unit-semantics-obligations/persistence.zh-CN.md)。

## C. 重算

| 节点 | 义务 | 状态 | 证据 |
| --- | --- | --- | --- |
| C1 | 删除所有派生缓存后得到相同视图 | 已证明 | `tests/integration/ooo-task-tables.test.ts`；mutant `derived-rebuild-is-a-no-op`。 |
| C2 | lease 越过边界时旧视图失效 | 已证明 | `evals/ooo-execution/recovery.test.ts`；mutant `stale-claim-may-deliver-again`。 |
| C3 | 多个读取者同时看到一个 ready task 时，只能有一个合法 claim | 已证明 | `tests/integration/ooo-managed-fence.test.ts` 现在也直接检查 board：round 自身的 `live()` 首先拒绝，若只破坏 Store，原测试会漏掉；第二个连接上的读取者调用 `claimTaskBoardEntry` 后被拒绝，这才证明“只有一个合法 claim”是 Store 性质，而不只是单一调用方遵守纪律。此处是研究工具证据，不证明 daemon 产品 `taskRun` 路径。tooth `a-live-claim-can-be-taken-by-another-agent` 曾被捕获，后于 2026-09-24 退役；用例 `one reader of the same ready task is given the claim, the second is refused` 断言拒绝，并以 raw row 回读 owner。 |
| C4 | 崩溃窗口中的未知外部结果不得靠猜测填补 | 已证明 | `tests/integration/ooo-external-window.test.ts`。某任务尚有未完成检查时，`externalReady` 会拒绝将事件设为 ready（“managed check requires bound terminal evidence”），因此不能通过宣告事件关闭该窗口。重启后持久化事实仍是 `external_ready = 0` 且无 artifact；虚构的事件名也会被拒绝。 |

## D. 生命周期与接入前置条件

完整责任见[D. 生命周期与接入前置条件](task-unit-semantics-obligations/lifecycle-and-integration-prerequisites.zh-CN.md)。

## E. 可选 HA/MGR 接入

完整责任见[E. 可选 HA/MGR 接入](task-unit-semantics-obligations/optional-ha-mgr-integration.zh-CN.md)。

## F. 后续阶段：实验 arms

完整责任见[F. 实验 arms](task-unit-semantics-obligations/experiment-arms.zh-CN.md)。

## 历史 D7 转换发现

完整责任见[历史 D7 转换发现](task-unit-semantics-obligations/d7-findings.zh-CN.md)。

## B6 发现：受管理写入与 runner 接入缺口

完整责任见[B6 发现：受管理写入与 runner 接入缺口](task-unit-semantics-obligations/b6-findings.zh-CN.md)。

## G. 产品入口：协作与 OoO 证据边界

完整责任见[G. 产品入口：协作与 OoO 证据边界](task-unit-semantics-obligations/collaboration-product-entry.zh-CN.md)。

## 不适用项

- B7 无失败情形可测：此分支没有 board/`taskRun` JSONL 导出。
- D7 与 D10 涉及已退役的 round 工具；见[退役决策](../decisions/implemented/2026-09-18-retire-the-round-instrument.zh-CN.md)。
- D7 转换尝试失败的记录保存在[D7 发现](task-unit-semantics-obligations/d7-findings.zh-CN.md)；它不是当前运行时验证。

## 剩余事项及待决问题

完整责任见[剩余义务与待决事项](task-unit-semantics-obligations/remaining-obligations.zh-CN.md)。
