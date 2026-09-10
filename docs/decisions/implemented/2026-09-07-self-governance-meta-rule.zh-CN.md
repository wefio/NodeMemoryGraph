# 自治理元规则：NMG 自身的规则也受治理

[English](2026-09-07-self-governance-meta-rule.md)

**Status:** implemented  
**Approved:** unrecorded

## 问题

NMG 的 standing rules、Skill 与决策约定本身也是 NMG 的制品，但没有任何机制治理它们如何变化。一条规则可能在代码编辑、commit body 或 prose 旁注里被静默增改、削弱或移动，导致规则系统不经深思便漂移。同一规则在多处复述会失步；需要在多处执行的规则被到处复述而非一次强制。借自 dsh harness，含金量最高的元规则正是这条能自我繁殖的：它让未来每一次规则变化都深思熟虑而非静默。

## 决策

采纳自治理元规则，在文档 owner 处声明一次，并以 standing order 呈现：

- 规则变化是非平凡变化。增改、削弱或移动任何 standing rule、Skill 约定或决策约定本身即一次决策：在同一改动里写明改了什么、替代或胜过什么（alternatives）、为什么。绝不静默改动规则。
- 每条规则只有一个 home。只在 owner 处声明一次，别处用相对 Markdown 链接；删除重复副本。
- 偏好门禁而非提醒。需多处遵守或防漂移的规则，在 owner 处做成一个机械检查，而非到处复述。
- 让新规则可逆且有所依据。优先文档约定而非固化机器；记录代价与所胜。

owner home 为 `skills/doc-maintenance/SKILL.md`；standing order 位于 `AGENTS.md`。其余 dsh 元规则（one-home 分层、词数预算、slop 清单、冻结归档、把 rules-as-gates 编进 RCP reconcile）分别评估，仅当 NMG 规模证明其必要才采纳。

## 考虑过的替代方案

- 仅保留非正式约定。documentation-lifecycle 决策已覆盖文档所有权；补充"规则如何变化"的规则可封上规则变更无人治理的缺口。
- 立即加机器门禁（如规则改动缺决策即 reconcile fail）。这是最终 rules-as-gates 的方向，但比当前改动更重，先暂缓至约定被实践检验。
- 照搬 dsh 完整 Agent Note 体系（封闭 class + archived 冻结强制）。NMG 决策量尚不足以支撑分类法与归档机制。

## 后果

今后每次对 standing rule、Skill 或决策约定的改动，都在同一次改动内自带 rationale 与 alternatives，规则系统得以深思熟虑地生长且可查询。规则不再被静默变更，重复在源头被纠正。强制仍偏文档与轻量：该元规则是一项约定，直到后续决策把其某条子则变成机械检查。
