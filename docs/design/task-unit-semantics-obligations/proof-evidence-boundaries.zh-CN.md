# 证明位于何处：两类证据基底，彼此不能替代

[English](proof-evidence-boundaries.md) · [术语](proof-evidence-boundaries.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.zh-CN.md).

## 证明位于何处：两类证据基底，彼此不能替代

台账使用两类证据基底。它们的存储与调用路径不同；只有当测试实际经过所述路径时，证据才适用于相应主张。

**产品运行时。** 运行表 `task_run_manifest`、`task_run_tasks`、`task_run_facts` 位于 `src/core/store/base.ts`；`src/integration/task-coordinator.ts` 拥有受管理写入围栏与取消规则；`src/integration/ooo-session-facts.ts` 和 `src/integration/ooo-session-mechanism.ts` 提供 session 机制；适配器通过宿主 SDK 调用。产品路径证据包括 `tests/core/store/task-runs.test.ts`、`tests/core/store/schema.test.ts`、经过 daemon 的 `tests/cli/task-run-surface.test.ts`、`tests/integration/ooo-managed-write.test.ts`、`tests/integration/ooo-managed-adopt.test.ts` 与 session-mechanism 测试。不能只看测试名称：要检查它实际调用并断言了什么。

**研究工具。** `src/integration/ooo-board.ts` 中的 `BoardAdmission` 和 `ooo_probe_*` 表，以及 `task-semantics.ts`、`task-semantics-model.ts`、`task-semantics-interleavings.ts`、`task-advisers.ts`，由 `evals/ooo-execution/**` 和直接构造该工具的测试覆盖。这些测试可以证明研究工具的存储语义与离线模型；不能仅因文件名包含“board”或“ordinary”就将其视为产品运行时证明。产品路径不会通过 `src/cli/` 或 `.pi/` 导入这些研究入口。

导入搜索仅用于定位，不构成证明：

```sh
rg -n 'ooo-board|task-semantics|ooo-advisers' src/cli/ .pi/
rg -n 'BoardAdmission' tests/integration/
```

测试可能只触达研究类型或 fixture，却断言产品代码；因此应按其断言分类，而不只看导入。设计不要求合并这两套存储，也不要求让研究工具成为产品行为的权威；任何台账行都不应暗示这种迁移。
