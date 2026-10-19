# 记忆循环的理论类比

[English](theoretical-analogies.md) | [简体中文](theoretical-analogies.zh-CN.md) · [术语](theoretical-analogies.terms.yaml) · 上级：[记忆循环](../memory-loop-design.md)

## 状态与范围

以下比较是设计类比：它们可以帮助提出问题，但不能证明 NMG 实现了所引理论、具有相同保证或产生相同效果。以下引用保留自旧版中文草稿，本次审阅未独立核验或复现。本文不使用外部研究结论作为 NMG 运行时行为的证据。

| 记忆循环关注点 | 引用的类比 | 对 NMG 的边界 |
| --- | --- | --- |
| 保留未解决经验供后续复用 | 案例推理（Aamodt & Plaza, 1994），包括 near-miss 案例 | NMG 的 open 记录和检索附件不构成完整的 CBR 系统。 |
| 相关工作再次出现时能触达此前失败 | Schank 的 *Dynamic Memory*（1982）；Riesbeck（1981） | 相关记忆锚点是 NMG 中的显式关系，不表示 NMG 实现了所引的例外记忆模型。 |
| 随时间保留未解决结构 | Zeigarnik（1927）和 Ovsiankina（1930 年代）效应 | NMG 不依赖这些关于人类记忆的假设。旧稿提及的复现性提醒缺少完整出处，因此不作为已核实结论复述。 |
| 跟踪矛盾和可修订结论 | TMS/ATMS（Doyle, 1979；de Kleer, 1986）、非单调推理（Reiter, 1980）与 AGM 信念修正（1985） | NMG 记录显式的 open/resolved/reopened 状态；这不意味着它是定理证明器或信念修正引擎。 |
| 检索后更新已有结论 | 记忆再巩固／预测误差理论（Nader et al., 2000；旧稿引用 2014/2015 年综述） | 与 NMG 学习信号的任何对应都只是比喻；不主张神经科学等价性或因果效果。 |
| 从相关概念检索 | 激活扩散（Quillian, 1967；Collins & Loftus, 1975；ACT-R） | NMG 已记录的 open-record 路径通过显式 `relatedMemoryIds` 附加记录；这不能证明系统实现了激活扩散算法。 |
| 对照基于时新度的遗忘 | Ebbinghaus（1885）和 ACT-R 时间衰减 | NMG 的留存谓词是软件策略，不是人类遗忘模型。 |

实现边界和当前检索／留存行为由[上级设计](../memory-loop-design.md)负责。独立的[取代设计](../supersession-design.md)负责替换链；[反馈循环设计](../feedback-loop-design.md)负责证据与反馈信号。