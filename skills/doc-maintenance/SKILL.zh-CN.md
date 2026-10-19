---
name: doc-maintenance
description: 维护本仓库的设计、决策、实验、事故复盘、双语、TODO 与操作文档。新增或修改行为、架构、流程、评估证据、公开指令、逃逸失败及其防护，以及文档重组、翻译、归档、去重或审计时使用。
---

# 文档维护

[English](SKILL.md) · [使用的术语](SKILL.terms.yaml)

让 NMG 文档成为用户、Agent、设计与实现之间可用的接口。归属不清时查
[文档索引](../../docs/README.zh-CN.md#所有权与权威顺序)；修改检查时读 CI 契约，修改配对内容时
读双语规则。

起草、重组、压缩或发布面向读者的文字前，先应用
[读者导向写作与审稿规范](references/reader-review.zh-CN.md)。读者任务结构、借鉴受控语言的表达
与语义验收由该规范拥有，结构检查不替代审稿。

## 可以局部阅读的内容

章节边界、必需与背景链接、源码引用和清单重复，遵循写作规范的
[局部阅读准则](references/reader-review.zh-CN.md#局部阅读与内容归属)。迁移后的入链和目标含义，
按其[审稿流程](references/reader-review.zh-CN.md#审稿与验收)检查。

根 [bootstrap](../../AGENTS.md) 拥有稳定发现协议。变化的命令与设置归其操作 owner；
[文档索引](../../docs/README.zh-CN.md#所有权与权威顺序)负责判定事实归属。本 Skill 路由这些工作，
不再维护一份写作清单。

## 元规则：NMG 的规则也受治理

关于 NMG 的规则和决策也是 NMG 产物，与代码遵守同一纪律，避免其他规则静默变化。

- **规则变化是非平凡变化。** 新增、削弱或移动常驻规则、Skill 约定或决策约定，本身就是决策。
  在同次变更的 owning record 说明变化、替代方案及理由；不把规则变化藏在代码编辑、提交说明
  或正文插话里。
- **一条规则一个家。** 在 owning `AGENTS.md`、Skill 或 decision 写一次，其他地方用仓库相对
  Markdown 路径链接。相同规则出现两处时删掉副本，链接 owner。
- **优先 gate 而非提醒。** 规则在多处适用或需要防漂移时，在 owner 建立机械检查，而不是多处
  重述。到处重述的规则不等于已执行。
- **新规则保持可逆、有依据。** 优先文档约定，不先固化复杂机器。新空间或替代规则要记录成本
  和被否决的选择。
- **多数文档不需审批。** 审批归机器检查无法裁定的规范内容，不归 `docs/**` 路径。判断“文件
  错了会有什么失败”：有检查则由检查裁定，无检查则编辑自由。可检查但缺检查时先写检查，
  不改为询问。见[审批分层](../../docs/decisions/implemented/2026-09-09-approval-tiers.zh-CN.md)。
  用户已同意实质内容的记录直接进入 `implemented/`，标记 `**Approved:** explicit`，不放在
  `proposed/` 等待。

## 一处事实与清理清单

持久正文的每项事实只有一个 owner（见工作流第 3 步），其他地方链接。两处重复时保留一处，
其余改为链接。Agent 会反复阅读这些入口，因此规则与正文保持精练。

写作或修改时检查：

- 同一规则或事实有多个家。
- 持久正文叙述“以前/现在/不再/改名/迁移”，或 PR/commit 位置。正文陈述现状，变化过程进入
  commit、decision 或 experiment，不放进设计。
- “已实现！”、“未来：……”等实现状态批注；代码与 package manifest 拥有实现状态。
- 能从源码或生成器恢复的手写 catalog、JSDoc 或测试/package 清单。
- 推理过程稿：逐步实现叙述、显而易见分支的证明、反复描述被否决的局部方案。保留合同和理由，
  删除形成结论的过程。
- implemented 记录仍使用“应该/提案/计划/验收标准”口气；已实施记录用现在时陈述事实。
- 滥用加粗、全大写或“至关重要”；强调留给真正改变行为的条款。

**头部字段是封闭词表。** 首个 `##` 前的 record header 只能使用该角色允许的字段，
`docs:check` 拒绝其他字段。决策字段见 [decisions/README.md](../../docs/decisions/README.zh-CN.md)。
设计允许 `**Status:** draft | current | superseded`（缺省 current），以及 `Created`、`Updated`、
`Authority`、`Related`、`Supersedes`、`Superseded by`；superseded 设计位于 `docs/design/archived/`
并指明后继，不使用自由格式状态句替代元数据。

## 工作流

1. **先分类。** 判断变化属于规范行为、理由、证据、完成状态、未决工作还是用户指令。
2. **找到现有 owner。** 搜索标题和术语；名称可能是别名或有多义时，在相关范围使用现有
   [术语查询](../../docs/design/documentation-governance.zh-CN.md#yaml-文件与查询合同)，未命中再扩大，
   不宣称不存在。更新 owner，不另建摘要。Git 保存编辑历史；只留在 Git、但难以重定位的必要
   细节，在相关审计或决策留下 commit/decision 链接。
3. **更新对应角色。**
   - 行为与架构：`docs/design/design.md`，必要时加 owning 专题。
   - 理由和替代方案：`docs/decisions/`。
   - 测量：`docs/experiments/`，没有明确设计/决策接纳就不提升为规范。
   - 失败经过：触发[事故分流](../../docs/postmortem/README.zh-CN.md#什么时候写一篇)时写编号记录及索引；
     可提升的失败类别由[消费规则](../../docs/postmortem/README.zh-CN.md#消费端从记录到规则)决定落在哪个 owner。
   - 当前实现证据：`docs/design/completion-audit.md`。
   - 仅未决动作：`docs/design/temporary-todo.md`，完成后删除。
   - 用户/Agent 操作：拥有该指令的 README、Skill 或操作指南。
4. **显式处理替代。** 优先细化已有 owner；新旧 decision 双向链接。完全替代的记录归档，部分
   替代则说明剩余范围。
5. **维护完整文档组。** 遵循文档索引的[双语范围与三件套合同](../../docs/README.zh-CN.md#双语规则)。
   英文、中文与共用术语一起审查；语言版本和术语使用文件都不是另一份规范。
6. **诚实区分状态。** 分开 implemented、validated、enabled、default、deferred 和 out-of-scope。
   受控测试通过不是自然产品证据，实验结果不是默认策略决策。
7. **验证。** 应用 [CI 契约](../../docs/README.zh-CN.md#ci-契约)，运行 `npm run docs:check` 和底层变化
   需要的代码/评估检查；审查告警，不隐藏。自动化政策需改变时，先改合同再改 verifier。

## 提交沿革

Git 仍是完整 changelog。只有帮助后续 Agent 找到架构来源、加固修复、验证证据或避免重复
已否决设计时，才把 commit 信息写回已有 owner。

- owning 主题用简短 `Implementation lineage` 节。
- 按相关提交分组，不叙述所有中间 patch。
- 用 **Introduced**、**Hardened**、**Validated**、**Superseded** 标明作用。
- validation commit 只证明实际测量，不表示默认启用。
- 替代关系同时指明旧提交和替代 commit/decision。
- 格式、生成物、依赖刷新、普通测试、合并和易于重查的实现细节留在 Git。
- [精选沿革索引](../../docs/design/implementation-lineage.md)用于寻找 owner，不复制提交数据库。

## 边界

- 不把项目事实复制进 Skill，链接 canonical owner。
- 不把 `temporary-todo.md` 作为 changelog 或完成档案。
- 不让每个普通代码修改都成为 decision；未来会用到理由、替代方案、兼容性或后果时才写。
- 不让每个修复都成为事故复盘；由[分流规则](../../docs/postmortem/README.zh-CN.md#什么时候写一篇)
  判断哪些失败值得记录。
- 文档组缺项按双语 owner 记录为未完成，结构绿灯不能消除这项工作。
- 文档重组时，不顺带改写无关实验报告。
