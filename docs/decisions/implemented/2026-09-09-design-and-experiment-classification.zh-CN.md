# 按各自的轴分类 design 与 experiment

[English](2026-09-09-design-and-experiment-classification.md)

**Status:** implemented

## 问题

`docs/design/` 完全没有状态纪律。40 个文档里有 19 个带 `**Status:**` 行，而这 19 行
用了 **21 个不同的取值**：`诚实评估 / honest assessment`、`requirement ledger`、
`documentation convention and curated recovery index`、
`the actuator exists behind an explicit, default-off policy…`。机器无法从中读出生命
周期；而一个标着 `superseded` 的设计和现行设计并排放着，后继链接也不强制。

`docs/experiments/` 是相反的问题。40 份报告里 38 份都已结题，所以生命周期轴在那里
不携带任何信息；而四条相关的运行线——`retrieval-quality-*` 6 个、`context-*` 6 个、
`topology-*` 3 个、`qpp-*` 3 个——没有任何分组。

## 决策

**当状态分布均衡、转移频繁时，目录才是状态的好家。** decisions 满足这个条件
（3 proposed / 16 implemented / 3 rejected / 0 archived），保留生命周期目录。design
和 experiments 不满足，因此把状态放在一行里——与决策头部块已经强制的是同一条规则。

**design。** 头部块是第一个 `##` 之前的行，携带封闭字段集：`Status`、`Created`、
`Updated`、`Authority`、`Related`、`Supersedes`、`Superseded by`。`Status` 是枚举
——`draft`、`current`、`superseded`——令牌之后可选 ` — 限定语`。缺省即 `current`：
这个 tier 的定义就是「现行设计」，所以只有例外才需要写出来。`superseded` 必须带
`Superseded by` 链接，且文档必须位于 `docs/design/archived/`；该目录里的任何文档也
必须是 `superseded`。

**experiments。** 同一条线上三个以上运行放进主题子目录（`retrieval-quality/`、
`context/`、`topology/`、`qpp/`），文件名去掉冗余的主题前缀。运行报告仍命名为
`<slug>-<YYYY-MM-DD>.md`。

规则住在 `skills/doc-maintenance/SKILL.md`；门禁是
`scripts/verify-docs.mts` 里的 `checkDesignHeader`，测试在
`tests/docs/verify-docs.test.ts`。

## 考虑过的替代方案

**给 design 做完整的生命周期目录**（`docs/design/{draft,current,archived}/`）。保证
最强——路径**就是**状态——也是本决策否决的方案。它要付出 40 次 `git mv` 和约 278 处
入链，换来的东西与一条被校验的状态行差不多，而且会把约 37 个文档留在同一个目录里。
当一个状态压倒多数时，目录是容器，不是分类器。

**给 experiments 做生命周期轴。** 38 份已结题 / 2 份未结题；一个状态目录会装下几乎
所有文件。

**给 design 用 YAML front matter。** 决策头部块已经否决过它；同样的理由适用，而且
design 的散文会为它已经陈述的事实多出一种语法。

**按「与 git 重复」删掉 `Created:` 和 `Updated:`。** 它们重述 git 的首次与末次提交
日期，按「一事一家」应当从 20 个文档里删除。暂时保留：它们不是本决策要修的漂移，
churn 目前也不划算。记入 Deferred。

**连头部块里的裸 `Word:` 行也拒绝。** 与决策头部块同一个延后缺口，理由相同：有一条
未提交的决策仍带着它们。

## Deferred

`Created:` 和 `Updated:` 仍然重述 git 的首次与末次提交日期。若它们开始漂移再议；目前
它们稳定且便宜。

头部块里的裸 `Word:` 行在 decisions 和 design 中仍被当作散文处理。

## 后果

`docs/design/` 现在有一个归档文档（`archived/file-content-source-design.md`），没有
自由文本状态值。18 条状态句变成枚举令牌，其警示信息保留为限定语，因此没有丢失信息。
封闭集之外的六个字段（`Date`、`Owner`、`Commits`、`Purpose`、`Normative source`、
`Implementation recovery`）变成 `Updated:` 或散文。`docs/experiments/` 有四个主题
子目录，其文件名门禁现在检查 basename，因此主题子目录内的报告仍会被检查日期。
