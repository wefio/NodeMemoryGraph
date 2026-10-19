# 记忆维护反馈与证据边界

[English](feedback-loop-design.md) | [简体中文](feedback-loop-design.zh-CN.md) · [术语](feedback-loop-design.terms.yaml)

**状态：**当前契约摘要，已对照 core store、daemon service、Pi remember surface 与 controller-shadow 集成检查。

NMG 会记录可观察到的检索和写入事件，但这些观察不能与语义判断或“回答依赖了某条记忆”的证据互换。本设计区分三种 API 和一种诊断轨迹，避免把记忆写入、控制器训练标签和已验证的声明结果混为一谈。

## 四种不同信号

| 信号 | 责任方／来源 | 可以支持什么 | 不能证明什么 |
| --- | --- | --- | --- |
| Disclosure | NMG 检索／渲染路径 | 记录的 recall surface 实际暴露了哪些 memory ID。 | 回答使用了它们，或回答正确。 |
| `answer_overlap` | NMG 诊断器 | 回答文本与已展示记忆文本的表面重叠。 | 因果使用、真实性或训练标签。 |
| Claim outcome | 显式调用方提供 `source`、`sourceLineage`、`semanticTaskId` 和 supported/contradicted 结果 | 可归因的结果事件与逐声明 shadow posterior。 | 不能仅因检索、复用、任务完成或沉默就自动成立。 |
| Supersession | 调用方或单独配置的 judge | 已声明的同 scope 旧值替换关系。 | 不能仅从相似度推断。 |

诊断重叠分数绝不能升级为 `claim outcome`。写入与证据契约的归属文档是 [`skills/nmg-memory/references/writes.md`](../../skills/nmg-memory/references/writes.md) 和 [`skills/nmg-memory/references/natural-evidence.md`](../../skills/nmg-memory/references/natural-evidence.md)。

## 不要混淆反馈 API

### `NmgStore.recordFeedback(RecordFeedbackInput)`——写路径维护

这个 core-store 方法接收：

```ts
interface RecordFeedbackInput {
  sessionId?: string;
  attributedMemoryIds?: string[];
  supersede?: {
    supersededMemoryId: string;
    newMemoryId?: string;
    reason?: string;
  };
  retrieveHints?: Array<{ memoryId: string; hints: string[] }>;
}
```

- `attributedMemoryIds` 是调用方明确提供的访问信号，会更新使用统计；它不是模型因果依赖记忆的证据。
- `supersede` 是调用方的语义判断：同时提供两个 ID 时执行完整 supersession；只提供旧 ID 时，将该记录标为 `disputed`，直到替代值存在。参见[取代设计](supersession-design.md)。
- `retrieveHints` 将给定提示附加到指定记忆，保存为规范的 `recall_trigger` markers，并刷新其搜索投影。未知 memory ID 会被软忽略。Hints 是检索元数据，不是新声明。

Pi `nmg_remember` 工具以 `action=supersede` 暴露取代操作；remember surface 会展示候选，但明确将语义选择留给 Agent。通用 core store 不会调用 LLM 来决定是否取代。

### daemon/MCP `recordFeedback`——在线 learner 输入

daemon 中同名的方法不是 `NmgStore.recordFeedback`。它消费自动召回的带标签反馈，供在线 learner 使用。它要求显式指定 `activeGraphId`，只将反馈绑定到该 graph，不会回退到最新的 staged decision。如果 learner 不可用、没有 graph，或 learner 没有可用的 staged decision，则不会报告训练。该 API 不应用记忆 supersession，也不保存 claim outcome。

### `recordClaimOutcomes`——可归因的声明证据

这是显式记录 `supported` 或 `contradicted` 结果的独立路径。调用方必须提供非空 `semanticTaskId`、`sourceLineage` 和有效的声明选择。若提供 `activeGraphId`，投票范围会限制为该 trace 实际暴露的记忆。Task key 用于避免多个回合对同一声明重复投票。

可选的 `evidenceSource` 携带 user/tool 来源消息。提供时，其 actor 必须与 `source` 一致，`sourceMessageId` 必须与 `sourceLineage` 一致，且必须提供来源内容与 session ID。这些结构校验建立的是归因元数据，不是自动语义蕴含校验；结果仍由调用方负责。`collectionOrigin` 区分 `natural`、`controlled` 和 `legacy` 记录；benchmark 来源的投票默认归为 `controlled`。

生成的 claim posterior 在经校准的检索策略显式消费之前都只是 shadow metadata。记录结果本身不会更改记忆陈述、取代其他记录或激活控制器。

## Controller-shadow 轨迹

Pi controller-shadow bridge 区分精确的 recall disclosure、诊断性的回答重叠以及可归因的已验证声明支持。只有已接受的 claim-outcome 证据才会写入 `verified_claim_support` 轨迹；不能从 overlap 或“记忆曾出现在上下文中”伪造该轨迹。Shadow scoring 记录待检查的建议决策，不会实际驱动检索行为。

在线反馈还要求 daemon learner 收到展示给消费者的 graph ID。Graph 上下文缺失或不匹配时会跳过，而不是重新绑定到无关决策。

## 评测边界

`evals/omnimemeval/bridge.ts` 可以使用单独配置的外部 judge，检查受限的高优先级 supersession 候选。这属于 benchmark harness 行为，不是 core store 保证，也不能证明常规产品集成采用相同路径。Benchmark 结果与 `controlled` collection 记录必须和自然产品维护证据区分开。

## 源码参考

参见 [`RecordFeedbackInput`](../../src/core/types.ts)、[`NmgStore` 写路径](../../src/core/store/writes.ts)、[claim outcome 存储](../../src/core/store/maintenance.ts)、[daemon service](../../src/cli/service.ts)、[Pi memory surface](../../src/integration/agent-surface.ts)、[controller-shadow bridge](../../.pi/extensions/nmg/controller-shadow.ts) 与 [OmniMemEval bridge](../../evals/omnimemeval/bridge.ts)。