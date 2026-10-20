# 时间链与逻辑链：设计历史

[English](temporal-logical-chains-design-2026-08-13.md) | [简体中文](temporal-logical-chains-design-2026-08-13.zh-CN.md) · [术语](temporal-logical-chains-design-2026-08-13.terms.yaml)

2026-08-13 的历史设计记录，不是当前实现契约。当前源码和下方链接的 owner 文档优先。本记录中的 BEAM 数值观察和外部比较没有关联可复现运行产物，不作为当前已复现实证。

本记录回顾了从跨会话时间问题到有类型的 memory chain 结构，以及可选 reasoning workspace 路径的演进。最初认为 `eventTime`、`supersedes_id` 和相关记忆已经足够；后续设计修正了这一判断：它们无法表达显式有序成员、分支，或一条记忆属于多条路径。当前 `MemoryChain` 源码定义 temporal/logical chains、显式成员和 DAG edges；参见 [`MemoryChain` types](../../src/core/types.ts)、[store methods](../../src/core/store/base.ts) 和 [chain retrieval 路径](../../src/core/store/retrieval.ts)。

## 设计决策快照

- Chain membership 和 edges 由写入方显式写入；chain 结构不会推断语义顺序，也不负责推理。当前 store 会在写入 edge 时检查 DAG 边界。
- Chain expansion 是调用方选择的 recall supplement（`expandChains`），不是全局重排，也不是无条件搜索行为。当前选项、预算上限和选择代码由 `src/core/types.ts` 与 `src/core/store/retrieval.ts` 负责；历史设计细节见[设计收敛](temporal-logical-chains-design-2026-08-13/converged-design.md)。
- 跨域结构类比是独立的建议型操作。当前源码将五种结构模式抽象出来，并按 pattern-type Jaccard overlap 排序候选；它不会更改检索排序，也不会写入记忆、关系或链。实现位于 [`analogy.ts`](../../src/core/store/analogy.ts)，[`analogy.test.ts`](../../tests/core/analogy.test.ts) 包含针对性示例。Fixture 分数不是普遍质量结论；详见[跨域类比](temporal-logical-chains-design-2026-08-13/cross-domain-analogies.md)。
- `MemoryGraphReasoner` 仍位于 `src/lab`，并有可选 Lab 调用路径。Pi Lab tools 由 `NMG_ENABLE_LAB_TOOLS=1` 控制；reasoner 不属于默认 `searchContext` 检索管线。不要将旧稿中未加限定的“从未接入 runtime”标签当成当前行为。
- `ReasoningWorkspace` 是独立的、按 session 标识的 scratch workspace，由 daemon 持久化在其 Lab data directory 下；它不是 LTG memory chain。Board channel 不具私有性：共享 channel 边界是 `taskId`。名称如 `scratch:<agentId>` 本身不会增加访问控制；非共享 scratch 使用 session-scoped workspace（它不是 OS 级访问控制边界），只有明确要共享的内容才发布到共享 board。

## 历史证据与研究边界

原始记录报告了特定 BEAM 弱项，并据此提出改进方向；本保留记录没有链接对应的运行产物。应将这些数值视为有日期的报告观察，而非已复现的当前基线，也不是链设计能提升质量的证据。原稿中的文献／平台比较作为设计背景保留在[设计收敛](temporal-logical-chains-design-2026-08-13/converged-design.md)和[跨域类比](temporal-logical-chains-design-2026-08-13/cross-domain-analogies.md)中；它们是引用和类比，不是 NMG 实现证明。

原记录还包含对 reasoning workspace 的历史用户评价，以及如何共享 scratch 内容的建议。这些内容不是当前用户反馈，也不是为 board 增加隐私行为的授权。当前运行时与地址规则由源码和 [Task Board 契约](../../skills/nmg-memory/references/board.md)定义。

## 当前源码入口

- Chain types 和契约：[`src/core/types.ts`](../../src/core/types.ts)。
- 持久化、members、edges 与环检查：[`src/core/store/base.ts`](../../src/core/store/base.ts)。
- 可选 chain expansion 及当前边界：[`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts)。
- Session reasoning workspace：[`src/integration/reasoning-workspaces.ts`](../../src/integration/reasoning-workspaces.ts)、[`src/lab/reasoning-workspace.ts`](../../src/lab/reasoning-workspace.ts) 与 [`src/cli/service.ts`](../../src/cli/service.ts)。
- Reasoner 实现与可选 Lab 调用：[`src/lab/memory-graph-reasoner.ts`](../../src/lab/memory-graph-reasoner.ts)、[`src/cli/service.ts`](../../src/cli/service.ts) 和 [Pi tool gate](../../.pi/extensions/nmg/index.ts)。

另见[实现沿革](implementation-lineage.zh-CN.md)和当前的 [active-graph 设计](design/active-graph-activation-and-consolidation.md)。