# 记忆取代设计

[English](supersession-design.md) | [简体中文](supersession-design.zh-CN.md) · [术语](supersession-design.terms.yaml)

**状态：**当前契约摘要；已对照 `src/core/store/writes.ts`、检索投影、Pi remember surface 与 OmniMemEval bridge 检查。旧稿中的 persona 分数与“96 个单测”没有关联运行产物，本次不将其作为证据。

当同一作用域内某项属性的新值取代旧值时，supersession 会记录这一关系。旧记录变为 `superseded`；新记录通过 `supersedes_id` 指回旧记录。当查询命中旧措辞时，检索可以带出当前后继值。Supersession 不等同于相似、矛盾或相关。

## 责任与判断边界

| 步骤 | 责任方 | 契约 |
| --- | --- | --- |
| 发现可能过时的候选值 | NMG core | 只使用文本、转换结构与 polarity 启发式，不做语义裁定。 |
| 判断某个候选是否真的被取代 | 调用方或评测 judge | 相似度不代表同一身份。当前 Pi surface 展示有界候选并让 Agent 判断；OmniMemEval bridge 有单独的评测 judge 路径。 |
| 应用已声明的关系 | NMG core | 校验 scope 和链约束，再以事务记录关系。 |
| 投影检索结果 | NMG core | 默认将命中旧值的查询解析为当前后继（或 as-of 时刻有效值）；`includeHistorical` 会跳过后继替换。 |

普通 duplicate merge 回调与 supersession 是两条路径。`RememberInput.judgeDuplicates` 用于 near-duplicate 路径；`supersedeCandidates` 会单独返回，不会由 `remember()` 自动裁定或应用。

## 候选发现

`RememberResult.supersedeCandidates` 是启发式候选列表，不是裁定结果。`supersedeScan` 默认开启；如果批量 ingest 没有任何消费者处理候选，可以关闭。该扫描的成本为 O(scope size)，因此不打算展示或裁定候选的调用方应传 `supersedeScan: false`。

当前扫描：

- 检查同一 scope 下 `active` 或 `disputed` 记录，不将候选限制为最近 N 条；
- 使用 token 预过滤与归一化重叠，但排除 near-duplicates（它们应进入 merge review）；
- 将明确的 `from X to Y` 转换匹配和调用方提供的 polarity 翻转置于纯 token 候选之前；转换／polarity 候选之间再按相似度排序；
- 返回列表上限为 `SUPERSEDE_CANDIDATE_MAX`（`10`）。

转换与 polarity 信号可以改善候选排序，但不能证明单值属性已发生变化。调用方仍须判断新旧陈述是否指向同一作用域内的同一属性。NMG 现有的 `src/core/simhash.ts` 工具目前用于 tessera 文件漂移恢复，并未用于召回 memory supersession 候选。单独的 [SimHash 词法补充提案](simhash-lexical-complement-design.md)仍是草稿。

## 应用 supersession

Core 有两种确定性入口：

1. **写入时显式指针：**`RememberInput.supersedesId` 声明旧记录。要求 scope 相同、前驱未删除且尚无后继；同一写入事务会将前驱标为 superseded，并写入新记录的 `supersedes_id` 指针。
2. **写入后应用：**`applySupersession({ newMemoryId, supersededMemoryId, validUntil? })` 应用独立选定的关系。它会拒绝缺失 ID、自我取代、已删除记录、scope 不同、覆盖已有前驱、产生后继分叉或形成环的操作。旧值变为 `status='superseded'`；新值通过 `supersedes_id` 指回旧值，并获得 `evidence_role='update'`。

重复应用同一对 ID 是幂等的。仅当 `valid_until` 尚未设置时才写入，因此重试不会改写第一次确定的时间边界。Schema 表达的是单前驱／单后继版本链，不是可分叉的版本图。

另有一条显式 state-key 规则：写入包含 `memoryType: "state"` 与已解析 `stateKey` 时，同一 `stateKey`、相同 scope 下当前 active 的记录会在事务中被取代。这是按属性地址进行的替换，不是对任意记忆做语义推断。

## 调用方与反馈路径

- Pi remember surface 会展示最多三个可能的旧值，并明确说明相似度不足以作出判断。Agent 确认是同 scope 的真实取代后，再以 `action=supersede`、`newMemoryId` 和 `supersededMemoryId` 调用 `nmg_remember`。
- `NmgStore.recordFeedback({ supersede })` 是写路径维护方法。两个 ID 都提供时执行完整 supersession；只提供旧 ID 时将其标为 `disputed`，因为新值尚未写入。之后写入新值时，旧记录可作为候选返回。
- daemon/MCP 的 `recordFeedback` 是另一个 API：它消费自动召回的带标签反馈以供在线 learner 使用，并要求指定 graph。不要将它与 `NmgStore.recordFeedback` 或 `recordClaimOutcomes` 混为一谈。
- `evals/omnimemeval/bridge.ts` 有评测专用的外部 judge 路径。对于已知时间，若候选并非严格早于新事件则会剔除；候选时间或新事件时间未知时仍保留。它只保留 `transition`／`polarity` 强信号，最多给 judge 三条，再应用接受结果。这种 harness 行为不表示 core store 会调用 LLM，也不能证明产品调用方使用相同 judge。

## 检索投影

Superseded 结果可以作为其版本链的 lexical/vector anchor。除非 `includeHistorical` 为 true，最终投影会将链解析到 active 后继；对于设置了 `eventTimeTo` 的查询，则解析到当时有效的值。即使目标措辞没有进入原始候选池，也可以通过稳定 ID 物化目标。多个旧 anchor 若解析到同一目标会去重；目标的 combined score 至少为最佳 anchor 的 combined score 加上 `SUPERSEDE_SUCCESSOR_BOOST`（`0.3`），但不会低于目标自身的分数。

没有后继的孤立旧记录不会被当作当前答案。历史／as-of 查询仍可返回该时刻有效的值；若后继发生在查询窗口之外，旧值可以保留。显式设置 `includeHistorical` 会跳过后继替换。

## 源码参考

参见 [`types.ts`](../../src/core/types.ts)、[`writes.ts`](../../src/core/store/writes.ts)、[`retrieval.ts`](../../src/core/store/retrieval.ts)、[`graph-policy.ts`](../../src/core/store/graph-policy.ts)、[Pi remember surface](../../src/integration/agent-surface.ts)、[daemon supersede handler](../../src/cli/service.ts) 与 [OmniMemEval judge bridge](../../evals/omnimemeval/bridge.ts)。更广泛的反馈和 evidence source 语义由[反馈循环设计](feedback-loop-design.md)负责。