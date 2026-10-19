# 产品调用路径审计（2026-09-20）

[English](product-call-path-audit-2026-09-20.md) · [术语](product-call-path-audit-2026-09-20.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## 产品调用路径审计（2026-09-20）

基于 `e3508a37` 核查，并在 `c01d3fe` 原样重跑；未修改运行时代码，也未支付模型调用。审计问题是产品操作执行了哪些既有规则，而不是是否需要另一种执行器或规则语言。

规则已经存在：[`ooo-execution.ts`](../../../src/integration/ooo-execution.ts) 中的 `acceptedDependency`/`selectableTasks`/`startableTasks` 处理已接受依赖和并发资格；`sharedSessionLegal` 与 [`nextSessionMove`](../../../src/integration/ooo-fusion-plan.ts) 处理 session 延续。普通 Pi 产品路径已通过 [extension](../../../.pi/extensions/nmg/index.ts) 的 `deliverWake` 唤醒既有 Agent session；Agent 使用现有 `nmg_board` 操作来 claim 和 deliver，并由独立 judge 判定。产品路径没有调用 `dispatchPlan`，不能据此断言这些规则或执行路径不存在。

产品生命周期操作与依赖准入之间有一条明确边界：[`task-run-surface.test.ts`](../../../tests/cli/task-run-surface.test.ts) 的 `registerAndFreeze` 冻结 `J.dependencies = ["P"]`。用例 `a managed entry's lifecycle write goes through the run, and the run records it` 随后通过 `NmgService.invoke` 采用 J 并成功 claim，期间既未生成也未接受 P。观察到的事实是 `entry-bound` 与 `board-claim`。因此，该 managed claim 调用会执行注册、绑定和取消检查，但本身不执行依赖接受谓词。测试证明的是这一窄行为；不能据此替换既有谓词，也不能把每次普通 handoff 都当成依赖调度任务。

同样，`claimTaskBoardEntry` 和 `resolveTaskBoardEntry` 会调用 `promoteNextSerialPending`；该晋升表示 claim/closure 后某个 handoff 可用，不表示依赖因接受而满足。`judgeTaskBoardEntry` 则独立地将 verdict 绑定到 artifact digest。不能把这些既有操作描述为缺失，也不能将它们代表的不同转移混为一谈。

抽取出的 loop 有八个测试用 `StubBoard` 检查候选选择、claim 和 verdict；其中一个还用真实 Store 验证按 task/attempt/entry 记录的 session facts。这些测试证明 loop 与事实写入，不证明产品已实现 `DispatchBoard`。相关验证在 worktree 中运行：

```sh
node --experimental-strip-types --test tests/integration/ooo-dispatch.test.ts tests/integration/ooo-fusion-plan.test.ts tests/integration/ooo-session-facts.test.ts tests/cli/task-run-surface.test.ts
```

结果：**41 通过，0 失败**。service 测试在进程内调用产品 service；它们不是对用户正在运行的 daemon 进行网络调用。fusion-plan 测试提供的是纯规则证据。

2026-09-20T11:54Z 单独观察到的 live daemon 对 `nmg daemon status --json` 的回答为 `compatible: true`，但其广告的 `methods` 未包含 `taskRun`；worktree 中的 service 实现了该方法。这是已安装实例的能力观察，不证明源码方法缺失。没有重启共享 daemon。产品部署状态与源码级测试覆盖是两项不同主张。
