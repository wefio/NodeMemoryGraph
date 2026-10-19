# 黑板发现、定向投递与串行交接（2026-08-13）

[English](board-find-serial-a2a-compat-2026-08-13.md) | [简体中文](board-find-serial-a2a-compat-2026-08-13.zh-CN.md) · [术语](board-find-serial-a2a-compat-2026-08-13.terms.yaml)

历史设计记录。本文记录添加本地 Agent 发现与交接时提出的协作边界，不是当前 RPC／schema 参考，也不证明完整 A2A 协议兼容性。行为与接口请以当前 owner 为准。

## 设计区分

2026-08 提案将以下四种操作分开，不应混为一谈：

1. **Discover** 用于识别可用 Agent／capabilities；广播不应被当作让每个 Agent 的 LLM 都立即开工的指令。
2. **定向投递** 使用显式稳定 Agent 名称（`to=<agent>`）；它不同于 session identity，也不同于订阅者可见的广播。
3. **投递／acknowledgement** 记录到达或已读；两者都不表示接收方已承担责任。
4. **Claim、resolve 与 expiry** 表示所有权和生命周期转换。串行交接可以要求后续工作等待这些转换；定向分派是另一种情况。

提案借用了 A2A 的 discovery 词汇，但明确保留本地 Task Board 协作模型。它没有提出用 A2A Task／Message 结构替换黑板，也没有要求每个本地 Agent 启动网络服务端。

## 证据与兼容性边界

本文是有日期的设计摘要，不是当前 schema 或运行时保证的证明。尤其是，原文逐字段映射 Agent Card，以及“未来网关只需格式转换”的说法，不在此视为已确立的契约。本地 `agent_name`、capability registry 或 JSON-RPC transport 本身都不能证明符合 A2A。

## 当前 owner

- [Shared Task Board 边界](memory-graphs/session-runtime-graph-and-projection-revisions/shared-task-board.zh-CN.md)
- [Task-unit 协作与产品入口](task-unit-semantics-obligations/collaboration-product-entry.zh-CN.md)
- [NMG memory Skill：Board 操作](../../skills/nmg-memory/references/board.zh-CN.md)
- 当前 store／integration 源码：[`src/core/store/`](../../src/core/store/) 与 [`src/integration/`](../../src/integration/)

当前 API、持久化状态，以及产品与研究边界请查阅这些 owner。本文不重复其详细状态机。