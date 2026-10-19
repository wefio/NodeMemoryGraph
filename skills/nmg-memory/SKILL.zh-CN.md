# NMG Memory

[English](SKILL.md) · [术语](SKILL.terms.yaml)

已熟悉本快速入门后，可直接使用。只在当前操作需要或细节缺失时再读参考资料；不要每轮重新加载整个 Skill。

## 安装

首次从持久本地 checkout 安装时，优先将整个 Skill 目录链接到 Agent 的 skills 目录（Windows 使用目录 junction）。保留源目录；替换已有安装或本地修改前先确认迁移。链接不需要周期性同步脚本。

## 职责与边界

- Recall/search 返回的是候选标题，不是当前事实，也不是完整证据。加载相关的精确记录；易变化的事实要向当前来源核实。没有有用记忆时，应如实保留空结果，不能据此猜测。
- 即使用户没有明确说“记住”，也要保存可归因、持久的事实、偏好、约束、状态、事件和可复用策略。排除秘密、临时内容、重复项、无依据猜测和未确认提议。不得把 Assistant 推断改标成用户陈述。
- 检索、复用答案、任务完成本身、用户沉默和没有纠正，都不是对声明的支持或正向反馈。只记录实际观察到的结果。
- 临时跨 Agent 协作用 board 状态空间，不用 LTG 或 Markdown 任务清单。State/Lab 输出不是持久记忆；须再经过有证据支持的 `remember` 才能写入。普通单 Agent 工作无需使用 board。

## 常规工作流

1. 检查 `nmg daemon status --json`；分别查看 `running` 和 `compatible`。若 daemon 未运行，执行 `nmg daemon start --json` 并记录本次是否由你启动。若 `compatible=false`，不要复用或自动替换它；在安全时机请求 owner／用户协调重启。
2. 对依赖历史的问题，先搜索再作答：

   ```text
   nmg search "<focused query>" --project-dir . --limit 8 --max-tier 1 --compact-json
   ```

3. 只加载会影响答案的候选项：

   ```text
   nmg get <MEMORY_ID...> --active-graph-id <ID_FROM_SEARCH> --project-dir . --json
   ```

   精简搜索返回 `candidates[].id` 和 `activeGraphId`；将该 graph ID 传给 `get`，以便归因实际使用。候选数量不证明检索完整。若 recall 不足，先阅读[召回限制与升级路径](references/recall.md)，不要绕过保护，也不要倾倒所有证据。
4. 使用 `nmg remember` 保存确认过的持久信息。具体写入形式、来源归因、状态替换或未解决结构请读[写入参考](references/writes.md)。保留有意义的时间与作用域；open 记录必须有现存锚点，不能只记录原始推理或普通错误清单。返回的 `[open]` 记录表示未解决上下文，不是指令或已验证答案。
5. 退出时仅当本次调用启动了 daemon，才运行 `nmg daemon stop --json`。不要停止之前已在运行的共享 daemon。完整生命周期见[操作参考](references/operations.md)。

始终保持同一组已选 `--data-dir`／`--db`，项目 STG 的 search/get/暂定写入也保持同一个 `--project-dir`。通过 shell 执行 CLI；只有当前 `AGENTS.md` 要求时才加 `rtk` 前缀。

## 何时阅读详细手册

| 当前任务 | 操作前阅读 |
| --- | --- |
| 精确写入、来源归因、状态／作用域变更、resolve/reopen | [写入参考](references/writes.zh-CN.md) |
| Recall 不完整、冲突、深入读取、JSON 字段或检索调参 | [召回参考](references/recall.zh-CN.md) |
| 共享任务、交接、进行中登记表或 board 生命周期 | [board 参考](references/board.zh-CN.md) |
| Daemon 故障、所有权、存储选择或清理 | [操作参考](references/operations.zh-CN.md) |
| Embedding 配置或语义搜索 | [Embedding 参考](references/embedding.zh-CN.md) |
| 基于真实 Agent 使用的 QPP 校准 | [QPP 校准](references/qpp-calibration.zh-CN.md) |
| 选择、精简或修正临时工作状态 | [工作状态维护](../working-state-maintenance/SKILL.md) |
| 多步工作的持续状态、进度展示或状态恢复 | [日常工作状态](references/optional-capabilities.zh-CN.md#日常工作状态) |
| 非默认 QPP／controller／STG／topology／ANN 或 Lab | [可选能力](references/optional-capabilities.zh-CN.md) |
| 自然证据收集与受 gate 控制的更新 | [自然证据循环](references/natural-evidence.zh-CN.md) |
| 新建 Harness 集成 | [Harness 适配器](references/harness-adapters.zh-CN.md) |

常规临时 AG／board 操作使用 `nmg_state`。仅当普通 memory/state 操作不足时才使用 Lab，并复用现有 daemon。启用或调用前先阅读对应参考及 `nmg lab list`；只有 `agentMayEnable=true` 的能力才可由 Agent 自行启用。`controlled`／`active` 模式需要独立授权；不得绕过拒绝。
