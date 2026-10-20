# 记忆循环：未闭合结构与复用

[English](memory-loop-design.md) | [简体中文](memory-loop-design.zh-CN.md) · [术语](memory-loop-design.terms.yaml)

已按源码审阅的设计摘要。实现已覆盖未闭合记忆生命周期中的若干环节；本文不声称每种记忆循环效果都已在产品使用中测量。

循环是 **Retain → Retrieve → Reuse → Revise**。其核心设计问题是保留尚未解决的结构，使后续工作能够触达并重新审视它们。“Open”表示尚未解决，不表示质量低或置信度低；记录变为 resolved 也不等于已证明为真。

## 未闭合与已解决

API 字段为 `resolution`，可取值仅有 `open`、`resolved`、`reopened`。文中的“closed”只是对 `resolved` 的解释性称呼，不是独立枚举。`resolution` 与 `MemoryRecord.status`（`active`、`disputed`、`inactive`、`superseded`、`deleted`）及 storage state（`indexed`、`dormant`、`quarantine`、`archived`）相互独立。

Open 或 reopened 记录必须至少有一个 `relatedMemoryId`，指向同一 store 中已经存在的记录。Store 会在需要时提供 `openedAt`，并记录 resolution 转换的前后值、时间、相关 ID 和可选原因。调用方可以将尚未解决的矛盾、未回答问题、失败方案、暂定抽象或被新证据重新打开的结论保留为 open；这些是撰写示例，不是系统自动推断的类别。

## Retain

Open 记录走普通记忆写入路径，但必须有现存的相关记忆锚点。LTG 留存候选只选择 `resolution='resolved'`；记录尚未解决时，存储状态 API 会拒绝将其从 `indexed` 转移到 dormant、archived 或 quarantine。STG 到期清理也只选择 resolved 记录，因此 `open` 或 `reopened` 记录在仍未解决时不会因 `expiresAt` 而到期。

这是一个资格边界，不表示 open 记录永不消失：删除、显式状态变更、session/store 所有权或其他生命周期操作仍然独立存在。进入 LTG 归档或 quarantine 层之前，必须先 resolve。

## Retrieve

在上下文检索路径中，NMG 使用直接检索到的 memory ID 作为锚点，并附加最多两条 `open`／`reopened` 的 indexed 记录；其 `relatedMemoryIds` 必须包含至少一个锚点。候选记录必须为 active 或 disputed，并满足 source actor／session 可见性规则。候选按 importance、再按 `openedAt` 排序，放在正常结果窗口靠后的位置，并仍受普通证据预算约束；不会启动独立搜索级联。

信息 surface 会将 open 或 reopened 记录标为 `[open]`。系统让相关的未解决事项可达，但不会判断它对当前回答是否重要，也不会决定现在就应解决它。

## Reuse 与 revise

Open 记录被复用时只是上下文；是否调查、继续保持未解决或采取其他处理，由 Agent 或用户决定。显式 `resolve` 和 `reopen` 操作会改变 `resolution`；状态实际转换时会追加可审计事件。非 resolved 记录必须继续关联至少一个现存记忆锚点。若 reopen 的记录不在 indexed 存储中，系统会先将其恢复为 `indexed`，之后它才能重新进入检索邻域。

Resolved 记录会获得参与普通留存检查的资格，但仍须满足 residence、类型、重要性、访问情况、evidence role 和年龄等条件。Supersession 是独立的同 scope 值替换关系，详见[取代设计](supersession-design.md)。反馈与 claim evidence 由[反馈循环设计](feedback-loop-design.md)定义。

## 源码审阅中的实现状态

仓库源码目前实现了此生命周期的以下部分：

1. `remember()` 与 `setMemoryResolution()` 会校验相关记忆 ID，并要求 `open`／`reopened` 必须有关联锚点。
2. LTG 留存与 STG 到期清理只选择 resolved 记录；归档与 quarantine 操作拒绝未解决的记录。
3. 上下文检索会在常规结果窗口和证据预算内附加最多两条相关 open 结构。
4. CLI、daemon 和 Pi memory surface 都提供 `resolve`／`reopen`；状态实际转换事件会保留前后 resolution 与调用方提供的原因。

这些是源码观察，不表示本轮文档审阅执行了测试，也不表示记忆循环提升了回答质量。见[理论类比](memory-loop-design/theoretical-analogies.zh-CN.md)，了解本文引用的概念比较及其证据边界。

## 源码参考

参见 [`MemoryResolution`](../../src/core/types.ts)、[写入校验](../../src/core/store/writes.ts)、[留存与 resolution 转换](../../src/core/store/maintenance.ts)、[上下文检索附件](../../src/core/store/retrieval.ts)、[CLI commands](../../src/cli/commands.ts)、[daemon service](../../src/cli/service.ts) 和 [Pi information rendering](../../src/integration/agent-surface.ts)。相关测试文件包括 [`retention.test.ts`](../../tests/core/store/retention.test.ts)、[`retrieval.test.ts`](../../tests/core/store/retrieval.test.ts) 与 [`stg-v2.test.ts`](../../tests/core/stg-v2.test.ts)。