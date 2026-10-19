# 文献扫描：成本感知、历史敏感的上下文注入路由器是否是稳妥前提？

[English](intervention-literature-2026-09-07.md) | [简体中文](intervention-literature-2026-09-07.zh-CN.md) · [术语](intervention-literature-2026-09-07.terms.yaml)

证据边界（2026-10-17 文档审阅）：本带日期记录属于历史研究材料，不是当前 runtime 契约，也不授权运行 provider 实验。本轮未重跑所引实验，未独立复核原始运行产物。

**Date:** 2026-09-07
**Status:** 外部文献综述（Exa/TinyFish 网络检索）；不是正式综述。
**Purpose:** 在运行之前检验 `docs/experiments/context/live-comparison-preregistration-2026-09-07.md` 背后的前提。
**Scope:** 自适应／选择性检索、上下文成本-质量权衡、为 agent 注入长期记忆、上下文选择／压缩。以英文文献为主。

## 要点

本扫描把选择性检索和逐查询成本／质量控制视为研究动机，用于比较固定回退 F0（always-retrieve）与采用 `utility − λ·cost` 的路由器。这种解释不证明 F0 对 NMG 次优，也不证明该路由器具有新颖性或更优。文献**尚未确立**、且确实开放的问题是：一个*学到的、对结果／历史敏感的*四动作路由器（我们的 H1/H2）能否胜过固定回退；多数 adaptive-RAG 工作是按*查询复杂度或模型不确定性*决策，而不是按实测历史与经验证的结果决策。这正是我们的预注册要检验的新颖主张，它仍未被证明。未观察到附加价值也是有效结果；本扫描没有估计此类结果应当多常见。

## 支持该前提的证据

以下是原扫描对所引来源的解释，保留为研究线索。本轮未独立核实文献匹配、所引效果或领域覆盖；它们不是已复现的 NMG 结果，也不构成系统性新颖性评估。

- **"何时不该检索"是真实且有研究的问题。** Mallen 等（2023）按查询实体频率调整检索；*Retrieval Helps or Hurts?*（NAACL 2024）表明不加区分的检索可能降低答案质量，在热门实体上尤其如此；*When Do LLMs Need Retrieval Augmentation?*（Findings-ACL 2024）按模型过度自信程度门控检索；*Self-RAG*（ICLR 2024）训练按需检索；*Adaptive-RAG* 按问题复杂度路由。
  → F0 在某些查询上次优，有经验依据。
- **成本感知的预算路由正是我们的框架。** *Know-Before-You-Fetch*（闭卷 vs k=1 vs k=5 vs 弃答）、*Cost-Aware RAG query routing*、*Fast-or-Better*（准确率-成本控制）、*SAGE*（SLO 感知）以及 *Adaptive-k*（在最多约 10× 更少 token 的情况下匹配或超过固定 k）都对逐查询的 `quality − cost` 建模。我们的 `Q = E[utility] − λ·cost` 与 λ 扫描与既有文献一致。
- **收益递减与"完整性"下限确实存在。** getzep 的 50 次运行研究报告：更多检索上下文带来的准确率收益递减，且检索不足会导致猜测（准确率跑在完整性之前）。三题 canary 在 `none`／`cue` 下记录了错误日期或拒答。这些观察为质量保护条件提供动机，但不能确立最优策略，也不能证明成本最小化通常会因果性地损害质量。

## 由此为本次运行引出的注意事项与控制（设计层，先于任何结果）

1. **位置／顺序混淆（Lost in the Middle，Liu 等 2023）：** 当选择检索时，相关证据在注入块中的位置（U 形注意力）可能主导 retrieve-vs-none 效应。必须在各策略间固定渲染／排序（整片段、确定性顺序），使被测效应是注入决策而不是证据位置。我们的执行器已保留来源顺序——把它变成显式控制。
2. **本实验在检索固定的前提下隔离注入决策**（回放／渲染上下文）。它补充而非替代检索质量工作。要显式说明这条边界（原文已隐含；应写成明确一行）。
3. **与文献的区分：** 多数 adaptive-RAG 路由器是*当下*按查询复杂度或不确定性决策，往往借助第二个 LLM／反思；我们的设计是通过一个廉价的、离线训练的 132 参数头，基于*带有实测历史与经验证结果的观测动作*决策——一种相对少被探索的 bandit／顺序框架。这才是真正新颖且未验证的部分（H1/H2），因此不应过度主张。

## 文献是否建议运行？

**建议运行——这并不特异。** 问题（always-retrieve 次优、成本-质量权衡真实存在）有支持；方法（廉价、学到的、历史敏感的路由器）是合法且较少被检验的替代方案，值得对照固定回退来测量。应预期并预先注册：未观察到附加价值的结果（路由器不优于 always-retrieve，或退化为它）是可能且有效的结局。

## 选定来源

- Liu 等，*Lost in the Middle*，TACL 2024（aclanthology 2024.tacl-1.9）。
- Asai 等，*Self-RAG*，ICLR 2024（arxiv 2310.11511）。
- *Adaptive-RAG*，NAACL 2024（aclanthology 2024.naacl-long.389）。
- *Retrieval Helps or Hurts?*，NAACL 2024（2024.naacl-long.308）。
- *When Do LLMs Need Retrieval Augmentation?*，Findings-ACL 2024。
- *Know Before You Fetch: Calibrated Retrieval-Budget Allocation*（arxiv 2606.29959）。
- *Cost-Aware Query Routing in RAG*（arxiv 2606.02581）；*Fast or Better?*（2502.12145）。
- *SAGE: SLO-Aware Adaptive Retrieval*（arxiv 2608.08237）。
- *Efficient Context Selection / Adaptive-k*（arxiv 2506.08479）。
- getzep，*The retrieval tradeoff: what 50 experiments taught us about context engineering*。
- *AttnComp*，Findings-EMNLP 2025；*SARA*（ACL 2026）固定 token 预算。
- Agent 记忆：*PGMem*、*PPRO*、*RippleMem*、*MemMachine*（对用户记忆注入而言，瓶颈是检索相关性而非存储）。
