# 共享展示选项

[English](shared-display-options.md) · [使用的术语](shared-display-options.terms.yaml)

**Related:** [功能注册表](../feature-register.zh-CN.md)

## 已注册选项

| 功能 | Gate／选项 | 默认值 | 含义 | owner | 状态 |
| --- | --- | --- | --- | --- | --- |
| 较长黑板约定 | `TaskBoardSurfaceOptions.includeConventions=true` | off | 库调用方显式请求较长约定；普通工具结果保留身份和协调状态，不重复约定 | `src/integration/agent-surface.ts`、`src/prompts/nmg-prompts.yaml`；[决策](../../../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md) | 已实现，不新增工具或能力 |
| 自动 Recall 显示模式 | `nmg recall display --session-id ID --mode compact\|full` | compact | 会话级 daemon 内存设置；全文模式在共享输出预算内保留正文，与上下文重排独立 | `src/integration/recall-context-policy.ts`；[契约](../../recall-context-and-display.zh-CN.md) | 源码实现，部署另行验证 |
