# 自动召回等待预算

[English](automatic-recall-budget.md) · [术语](automatic-recall-budget.terms.yaml)

**Status:** current

**权威范围：**[总等待期限决策](../../decisions/implemented/2026-10-02-automatic-recall-has-a-deadline.zh-CN.md)与[共享预算实现](../../../src/integration/recall-budget.ts)。

## 预算与已完成结果

Pi 运行自动 pre-turn 上下文准备时，整个 `before_agent_start` 共用五秒绝对期限，不是每个 RPC 五秒。已完成搜索的候选是检查点；后续可选工作、重排或遥测超时不能清空及时返回的候选。期限后返回的搜索数据不注入。

已完成的类型化信息项仍通过同一信息视图准入协议呈现；超时不恢复原始 header 回退，也不写入披露历史。归因只采用最终输出实际准入的记忆 ID。

宿主向 daemon 传入剩余时间，预留 100 毫秒完成响应。两条本地检索路径对传入的预算均封顶为 4.5 秒。
统一引擎兼容未传预算的客户端，默认等待 850 毫秒。项目与共享库的查询嵌入共用期限，到期保留词法结果。
显式 `nmg_search` 使用供应商的超时配置。

## 取消与诊断

查询嵌入超出自动召回预算时，自动上下文在该批结果的诊断区显示一次
`automatic_recall_embedding_deadline`。

支持取消的 HTTP 请求连同响应体读取一起中止。异步期限不能抢占同步 JavaScript/SQLite，已经发出的 provider 请求也不保证远端取消。

阶段名、耗时和完成／超时状态保留在消息的 `details.recallTiming`，不进入候选 DTO。Pi 的 `/nmg recall timing` 查看最近一轮，不记录原始提示或凭据。

WorkBuddy 召回的 hello、轮次准入与搜索使用同一个预算原语；其身份登记和 wake 轮询不属于该函数预算。OpenCode 和 DSH 使用相同原语，但采用更紧的 1.5 秒自动准备上限；拒绝晚到的准备结果，不能在超时竞争结束后继续发布。Pi 的取消、替换和会话切换会抑制及时完成的部分上下文，只有单纯期限到期才保留它。首次输出观测仍是独立的 opt-in 功能，等待期限不是首个可见输出测量。
