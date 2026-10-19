# AG 与黑板共享信息输出的基础切片

**Status:** implemented
**Approved:** explicit
**Relates to:** [持续状态提案](../proposed/2026-10-06-ag-state-transitions.zh-CN.md)

English: [2026-10-07-shared-information-output.md](2026-10-07-shared-information-output.md) · [术语](2026-10-07-shared-information-output.terms.yaml)

## 问题

AG 显示预览会丢失末尾约束，黑板结果反复携带长约定，而各适配器的纯文本格式缺少共用的来源绑定准备边界。需要基础设施，但不能改变私有状态归属或要求宿主专属执行器。

## 决策

从[持续状态提案](../proposed/2026-10-06-ag-state-transitions.zh-CN.md#64-最小实施顺序)开始实施共享视图与纯显示瘦身，暂不实现当前状态写入和宿主输入替换。本文记录已实施的基础，不代表切片 A 已全部完成，也不接受尚未验证的收益声明。

- Core 定义获准的 `InformationView` 与各自领域的来源句柄。AG 与黑板仍保留各自的存储、权威、权限和状态机；信息视图不是原始内部图、新存储或写入授权。
- `prepareInformationOutput` 为获准数据生成独立快照，返回文本、已接纳来源的指纹和省略视图。正文与必要标签不可分割；超限整项省略，不静默裁掉正文。文本预算包含分隔符以及放得下的省略提示；零或极小预算仍在结构化数据中保留省略信息。来源身份采用固定顺序，不受属性插入顺序影响；不同命名空间不合并。
- `confirmInformationOutput` 仅在实际渲染片段完全匹配时产生读取者 session 的确认候选。改写/裁剪或空读取者身份不确认；其他 session 不能确认私有 AG。Receipt 不是认证、验收或披露账本写入；将来提交账本前，可信宿主仍需确认实际可见性与来源访问权限。
- 普通工具文本与程序化库客户端共用准备逻辑，不导入 Pi/codemode、不新增脚本执行器、额外输出工具或必需的编排步骤。既有工具/RPC 操作仍可用；黑板紧凑 DTO 只新增可选交付/裁定元数据，不改变协作操作。
- AG 完整展示已接纳的暂时正文，保留暂时/假设标签，排除语义记忆和其他帧。不能用 500 字符预览删掉正文末尾的必要约束。
- 黑板保留寻址、不同 channel 的作用域、定向目标、pending/claim 状态、ack、完整交付摘要和独立裁定。已有 owner 提供的正文预览仍标为预览；单独的记忆指针沿用现有正文视图规则。长约定仅在明确设置 `includeConventions: true` 时展示，不再默认重复。预算省略了条目时不在文本显示传输游标，因为内部读取不能证明这些条目已经展示。

准备函数沿用 AG 现有的 8,000 字符默认显示上限，以 JavaScript UTF-16 code unit 计数。这只限制准备好的文本，不是包含机器数据、宿主包装和所有 NMG 动态面的统一输入预算。`full`/`preview` 描述这份获准视图，不代表语义记忆的精确证据。调用方必须显式选择模型可见字段，不能按字段名推定可见性。

## 后果

契约归 [`information-view.ts`](../../../src/core/information-view.ts)，纯准备/确认归 [`information-output.ts`](../../../src/integration/information-output.ts)，领域投影和兼容文本接口归 [`agent-surface.ts`](../../../src/integration/agent-surface.ts)，由 `src/index.ts` 导出。黑板预览仍由 `types.ts` 与 `store/base.ts` 投影；提示词仍由 `nmg-prompts.yaml` 和生成器维护。

确定性回归覆盖完整约束、必要标签预算与省略、规范来源去重、来源/状态/预览指纹变化、独立且不可变的准备快照、AG 的读取者隔离、输出改写、普通 JSON/库客户端、完整黑板交付身份、裁定更新后创建游标不变，以及预算省略时隐藏游标。既有 claim/deliver/judge 测试须继续通过；准备本身不写披露账本。

## Deferred

`working_state` replace/clear 与捕获代际 fencing 已在[有边界的当前状态切片](2026-10-08-ag-working-state.zh-CN.md)单独实现，适配器明确采用 session 帧退化。实际宿主输出与账本的接线、权限/版本复核、统一动态面预算、退化以外的语义任务身份、其他宿主的输入选择和匹配成本/质量评估仍未实施。Pi 专用状态选择／恢复另见[输入选择切片](2026-10-08-ag-working-state-input.zh-CN.md)，最终确认仍不支持。本切片未调用 live LLM、embedding 或记忆 benchmark；确定性测试不能证明真实宿主中的上下文增长节约或连续性收益。

## 考虑过的替代方案

- codemode 专属入口或执行器：拒绝；普通工具与库数据已经提供可移植基线。
- 每个适配器各自格式化并提前记披露：拒绝；共享准备防止显示漂移，实际宿主可见性仍是独立边界。
- 固定短头模板或截断状态正文：拒绝；多余包装增加成本，截断可能丢失正在维护的精确条件。
