# 定位仓库改动与解释验证状态

[English](repository-context.md) · [使用的术语](repository-context.terms.yaml)

**Authority:** [所属范围](../ci-cd-and-quality.zh-CN.md).

## Agent 原生仓库上下文

本节回答两个问题：改动应由谁维护、运行哪些检查；已有证据是否适用于当前声明和内容。
`agent:context` 只提供导航和只读协调视图，不执行开发验证，也不裁决架构正确性。

### 定位当前改动的 owner

根 `AGENTS.md` 保存稳定的查找协议。Agent 从任务术语、符号和目标目录定位实现与契约，
按当前动作读取相关章节；根入口不维护模块清单、命令或运行状态。已知目标时可以直接搜索，
不必先调用上下文工具。所有权或检查要求不清楚时，运行：

```powershell
npm run agent:context -- --scope <target-path>
```

将 `<target-path>` 替换为本任务要修改的仓库路径。工具返回的 owner 路径是定位入口，
不要求整篇阅读。文档按需阅读的维护规则由 `skills/doc-maintenance/SKILL.md` 拥有；
修改、测试和提交工作流由 `skills/repo-development/SKILL.md` 拥有。开发验证仍按
[验证流水线](../ci-cd-and-quality.zh-CN.md#ai-开发验证流水线)执行，不能以调用过查找工具作为正确性证据。

共享脏工作树中，优先用精确的 `--scope` 限定本任务路径。只有确实要纳入全部当前改动时，
才使用 `--changed`；它会把当前工作树的全部改动作为 scope，可能包含其他 Agent 的工作。

### 查找已有能力入口

需要判断“仓库已有哪个稳定入口能完成这类工作”时，用无参数的 `npm run agent:context`
查看能力目录；知道名称或别名时，用位置参数 `capability:<id-or-alias>` 映射回既有 route、
owner 和 verification。

`agent-context.yaml` 维护无法可靠自动推导的模块所有权、验证分类和轻量能力目录。
每项能力只声明稳定 ID/别名、简短职责、代码路径、入口命令及支持对象，不复制设计、
完成状态、实验结果或运行中服务状态。`package.json` 拥有 npm 命令；源码、
`completion-audit.md` 和 `temporary-todo.md` 分别拥有实现事实、完成审计和未完成工作。
配置校验只防止声明路径、route 和 npm 入口漂移，不建立第二事实源。

每条 route 必须显式区分 `blocking` 和 `advisory`，其命令精确对应 `package.json` script。
不能用含义过宽的 `test` 代替 `test:product`、`test:research` 或 `test:chaos`。

### 视图从哪里来

`tools/repo-context.ts` 从 Git、`package.json`、`agent-context.yaml`、owner 文档和临时
guardrail manifest 生成当前任务视图。该工具只读，不访问 NMG 数据库，不启动 daemon，
也不调用 LLM 或 embedding。

能力目录是静态导航，不是动态 service catalog、健康检查或另一套仓库状态。

### 声明状态协调

`agent:context` 同时生成只读 reconciliation 视图，区分仓库事实源与自动化收据：

| 输入 | 绑定的内容 | 判断证据时的限制 |
| --- | --- | --- |
| desired revision | 命中 route、验证分类和 package script 的稳定指纹 | 检查声明改变后，旧证据不能直接适用 |
| observed revision | 所选 scope 及其当前内容 | 同一脏文件内容改变也会改变指纹，不能仅凭 HEAD 和文件名复用旧收据 |
| verification evidence | `.nmg/verification/latest.json` | 必须与前两者一致，并覆盖所有 blocking check |

Git HEAD 单独记录用于溯源；一次只改变提交元数据的操作，不应使同一内容失去验证。

先按下表理解协调状态，再决定需要补证据还是检查差异：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `unknown` | 尚无可适用证据，或旧证据没有状态指纹 | 补充当前声明与内容对应的验证证据，不把缺证据解释为已经通过 |
| `converged` | 同一声明、同一观测快照的 blocking checks 全部通过 | 在该 scope 和检查面内解释结果，不外推到未验证行为 |
| `drifted` | route 无法机械解析，声明或内容在验证后改变，证据损坏，或 blocking check 未通过/未执行 | 检查所报差异或失败，处理后重新取得适用证据 |

协调由 `agent:context`、`agent:verify` 和 CI 事件驱动，不是后台 daemon。
`drifted` 只说明声明、观测和证据没有收敛，不等于架构错误。依赖方向、公共协议、
持久化边界和默认能力等架构影响，仍由 owner 文档、decision 和 Agent review 判断。
静态测试可以机械保护已经确定的 architecture fitness functions，但控制面不承载产品或架构智能。
