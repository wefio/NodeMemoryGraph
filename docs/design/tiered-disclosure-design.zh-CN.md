# 层级披露设计

[English](tiered-disclosure-design.md) | [简体中文](tiered-disclosure-design.zh-CN.md) · [术语](tiered-disclosure-design.terms.yaml)

顺序开放 tier 的路径已经实现；通用搜索中为 opt-in，Pi automatic recall 会启用。校准后的 SPRT 仍是未来工作。下方 2026-08-25 rollout 表是历史报告，不是当前验证回执。

**更新日期：**2026-10-16

**相关文档：**[Progressive recall](fibonacci-progressive-recall.md)、[progressive retrieval](design/progressive-retrieval.md)、[实现沿革](implementation-lineage.md)和[检索设计](design.md)。

## 当前源码契约

未启用 `tieredDisclosure` 时，direct retrieval 会在一次处理中搜索到调用方／预算允许的 tier 上限。设置 `tieredDisclosure: true` 后，检索从 tier 0 开始；当确定性的 QPP 判定当前 direct evidence 不足时，才按顺序开放更深 tier，并在达到 tier 上限时停止。`tiersOpened` 记录开放路径。这里不声称使用了 SPRT 或经过校准的概率。

- 通用调用方通过 `SearchOptions.tieredDisclosure` opt in；CLI flag 为 `nmg search --tiered-disclosure`。省略该 flag 不会启用顺序开放 tier。
- Pi automatic recall 会设置 `tieredDisclosure: true`；这是调用方特定默认值，不会使每个 `searchContext` 调用都默认启用。
- `maxTier`／active-graph budget 限定可用 tier 上限。此 gate 不会创建新 tier，也不会绕过该上限。
- `progressiveWarmDisclosure` 与 `--full-warm` 控制 warm results 内的独立呈现窗口；它们不是存储 tier 开放机制。
- 是否继续由确定性 QPP trigger 决定；没有使用经过校准的 likelihood ratio。核心选择逻辑与调用方默认值见 [Progressive recall](fibonacci-progressive-recall.md)。

当前实现位于 [`retrieval.ts`](../../src/core/store/retrieval.ts)，选项定义在 [`types.ts`](../../src/core/types.ts)。CLI 映射位于 [`commands.ts`](../../src/cli/commands.ts)；Pi automatic recall 接线位于 [`.pi/extensions/nmg/index.ts`](../../.pi/extensions/nmg/index.ts)。

## 设计理由与拟议的统计扩展

该设计把 tier 视为现有 evidence 与 token budgets 上的顺序 gate，而不是另一个独立预算维度。在 sequential mode 中，先检查 tier 0；只有确定性充分性信号触发时才开放更深 tier，且已开放 tier 会保留在当前查询中。预算耗尽时，相较于无界深层扫描，接受浅层未命中更保守。

校准后的 sequential probability ratio test（SPRT）是未来可选方案。其 likelihood ratio 将比较“已开放 tier 下 evidence 充分”与“仍然不足”；上／下阈值分别决定停止或继续开放 tier。该方案需要经过校准的概率。当前 QPP 组件输出确定性分数，因此 runtime 使用确定性的 QPP 决策。旧稿中的 Wald 引用和 stopping-time 公式是理论动机，不是已实现的 controller，也不是 NMG 性能主张。

该设计还区分 tier opening 与 warm-result presentation。`progressiveWarmDisclosure` 的 two-window 路径可以先呈现 warm prefix，随后按 ID 加载 deferred results；tiered disclosure 决定是否检索更深存储 tier。一个调用方可以同时使用两者，但任一机制都不意味着另一机制已启用。

## 评估边界

Latency、deep-evidence recall、context economy 与 tier dynamics 被列为可证伪的评估目标，不是已建立的结果。2026-08-25 rollout 表记录了当时的实现状态和 targeted test 报告，并标注规模／召回评估仍待完成。这些报告属于历史记录；本次文档审计没有运行测试或 benchmark。新的性能主张必须查阅当前测试／评估产物。

有日期的设计还提出使用 access counts 为 maintenance 提供信号。Tier-open frequency 表示需求，不代表语义有用性；promotion、retention 和回答证据仍是不同决策。

## 历史 rollout 快照（2026-08-25）

原始 rollout 报告记录了 `maxTierBudget`、`tiersOpened` 和 `deepEvidence`；opt-in CLI tiered-disclosure 路径；Pi automatic recall 接线；以及受限 headers 与作为精确解锁操作的 `nmg_get`。报告称当时 targeted unit／adapter tests 通过，同时规模、召回和 Agent utility 评估仍待完成。本段仅保留为有日期的报告，不是新的测试回执，也不能用于暗示当前运行状态。

实现历史和当前 owner 见[实现沿革](implementation-lineage.md)。

## 非目标

- 不增加 memory tier；gate 在现有 tier 与 retention 模型内运行。
- 不为每个 tier 增加独立 learned quota。
- 确定性充分性信号不调用 LLM。
- 仅启用顺序披露不会改变 tier assignment。

## 源码参考

- [`SearchOptions` 与 tier budgets](../../src/core/types.ts)
- [顺序 tier 检索与 QPP continuation](../../src/core/store/retrieval.ts)
- [CLI 选项](../../src/cli/commands.ts)
- [Pi automatic-recall 调用方](../../.pi/extensions/nmg/index.ts)
- [Progressive-recall 设计](fibonacci-progressive-recall.md)
- [Progressive-retrieval 设计](design/progressive-retrieval.md)
- [当前实现沿革](implementation-lineage.md)