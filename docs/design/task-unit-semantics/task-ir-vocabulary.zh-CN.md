# Task IR 与现有语汇的映射

[English](task-ir-vocabulary.md) · [术语](task-ir-vocabulary.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.zh-CN.md).

## Task IR 与现有语汇的映射

Task IR 是从现有声明与记录计算出的只读视图；不接收另一份 `inputs/outputs/effects/accept` JSON，也不落一份可独立修改的 IR。下表中的概念名用于解释分析结果，输入与校验仍使用现有字段。需要新语义时扩展对应 owner，不增加同义字段。

| 分析概念 | 当前字段与唯一类型 owner | 编译与边界 |
| --- | --- | --- |
| identity / intent | [BoardTicket、PatchTaskSpec](../../../src/integration/ooo-board.ts)：`runId/taskId/revision/attempt/inputDigest`、`instruction`；[PatchWork](../../../src/integration/ooo-patch.ts) | 复用现有身份与 `instruction`，不增加 `id/contractRevision/intent` 别名。board entry ID 与逻辑 taskId 不等同，绑定键包含 runId |
| inputs | `PatchTaskSpec.files` → `FrozenPatchTask.files`；`ProbePlan` 依赖列表 → `BoardTicket.dependencies` | 文件内容冻结；依赖产物由宿主在认领时绑定。编译视图只派生引用与摘要；当前没有多端口输入语言 |
| outputs | [PatchSubmission、ConclusionKind](../../../src/integration/ooo-patch.ts)；`PatchTaskSpec.admittedConclusions`；board `deliverableDigest/Ref` | 沿用 patch/conclusion 和单次交付。`cannot-complete` 不因结构合法而成为成功。多输出端口与任意 artifact kind 尚不支持，不能偷偷序列化进说明文字 |
| effects | `ProbePlan` 的 effect / [DispatchTask.effect](../../../src/integration/ooo-execution.ts)；`PatchTaskSpec.visible/editable` | 现有 effect 是粗类别 `read-only/isolated-artifact`；worker 读范围来自 `visible`，提案写范围来自 `editable`，宿主验证还消费完整 `files`。它们不是完整的语义读写集；不透明工具效果按冲突处理 |
| accept | `PatchTaskSpec.verify`；[Requirement](../../../src/integration/task-semantics.ts)（原与 `CycleOptions.checks`、`CaseRule` 同处 `ooo-cycle.ts`，随轮次退役后留在语义模块）；board 独立 `verdict/judgedDigest` | 沿用宿主验证和 board 判定，不新增第二个 accepted。当前 `verify` 是进程内函数，不能持久化；恢复所需的可序列化验证描述必须从既有 checks/cases/mutations 等配置冻结，并由共享宿主重建，不存函数或任意 checker 字符串 |
| budget | [PatchBudget](../../../src/integration/ooo-patch.ts)：`perFile/output` | 限制输出字节，不是 tokens；取消独立的 `outputs.maxBytes` 别名。模型 token 预算若要成为可强制限制，应先扩展其 owner 与执行协议，当前视图不得假称支持 |
| limits | `PatchLimits.turns/reads/timeoutMs` → `FrozenPatchTask.limits` | 保留原单位与执行时限，不另设 `deadlineMs`；不等于 board claim 的租约时限，也不等于轮次总预算 |
| placement | 无现有等价字段 | 仅由共享调度策略产生临时融合/分配建议，不进入当前票据，不影响验收；`visible/editable` 不承担 placement 语义。持久化执行关联用记录中的任务/attempt/执行者引用，不复制任务声明 |
| deps / requires | `ProbePlan` 依赖列表；`CycleOptions.requires: Requirement[]` | deps 是派发与产物依赖；requires 是 cycle 对已记录产物的 `verified/mutant-killed/test-title` 条件。两者不等同，当前 requires 不是通用授权/分支谓词注册表 |
| external fact / assumptions | `ProbePlan` wait event、[外部检查票据](../../../src/integration/check-ticket.ts)；无通用 assumptions 类型 | 检查事件保留原身份；本文的有限事实推测仍需在共享协议显式扩展，不能把缺失功能伪装成 `requires` 或票据已有字段 |
| refinement | [RefinementSpec](../../../src/integration/task-semantics.ts)：父义务到输出的映射，以及显式具名 `constraints` | 只读模型声明，不是持久化任务正文；`within-parent-writes` 比较规范化的提议写资源集，不读取补丁信封。协议给出名字，出现即启用，未启用也声明空列表；父权限义务不能通过漏约束丢失。 |

board `kind` 的唯一 owner 是 [TaskBoardKind](../../../src/core/types.ts)。它描述协作消息用途：`handoff` 交接、`result` 返回、`decision` 判定；不是 patch/conclusion 类型，也不是 effect。OoO 行内的 patch/snapshot `kind` 又是内部任务类别。三者不得互相转换或新增 `task-ir` kind、工具、频道来承载重复定义。

数据流为：现有 RoundSpec 研究入口 → 共享规范化/校验 → 现有任务契约与计划 → 派生分析视图 → `BoardTicket`。需要产品接入的解析规则必须移到共享 owner，由研究入口和各 harness 调用；不能把研究 A/B/C 输入格式提升为通用语言。默认补丁采用方用 `preparePatchWork` 生成完整冻结声明，不重抄字段子集。票据和共享循环通过带摘要的不透明 `declaration` 携带它，不要求所有采用方的声明都有补丁字段；冻结、解释和验收由采用方负责。[声明边界决策](../../decisions/implemented/2026-09-21-mechanism-not-policy.zh-CN.md#不透明派发声明)说明缺失声明与具名拒绝的区别。

编译必须对无映射能力明确拒绝，不静默丢字段或降为自由文本。第一版只分析现有 patch/snapshot 契约，验证器、预算和访问规则不重实现。新增语义先扩展 owner、身份摘要及对应检查，再进入派生视图。

字段检查能证明计划无环、引用存在、现有产物形状兼容、权限不扩张、预算有界。它不能证明意图完整、读集声明真实或测试足以证明正确。读集真实性依赖实际工具访问限制；普通 shell 不受约束时，任务按 opaque 工作处理。
