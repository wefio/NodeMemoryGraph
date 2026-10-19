# NMG 决策记录

[English](README.md) · [术语](README.terms.yaml)

决策记录保留无法仅从当前设计或 Git diff 安全重建的理由。它们说明非平凡的架构与流程选择；规范行为仍由 `docs/design/` 拥有。

## 生命周期

- `proposed/` — 开放提案。必需章节：Problem、Proposal、Alternatives considered、Acceptance criteria、Risks。
- `implemented/` — 已接受并实现的决策。必需章节：Problem、Decision、Alternatives considered、Consequences。`docs:check` 会拒绝提案阶段遗留的标题（`## Proposal`、`## Plan`、`## Acceptance criteria`）；未完成或未经验证的事项应放在 `## Deferred` 下。
- `rejected/` — 为后续参考保留的已拒绝提案。保留原提案和备选方案，并说明拒绝原因。
- `archived/` — 不再支配当前系统的既有已实现决策。注明归档日期，并在存在后继决策时链接它。

目录本身表示生命周期。每条记录还须有匹配的 `Status:` 行。状态变化时移动记录，不要复制到另一个目录。决策文件名使用 `YYYY-MM-DD-kebab-case.md`；译文在 `.md` 前加 `.zh-CN`。相同日期 slug 只能存在于一个生命周期目录中。必需章节必须包含正文，不能只有标题。

## 文件头字段

第一节之前，决策记录必须包含 `docs:check` 会检查的固定字段块：

```markdown
# <title>

[<counterpart>](<slug>.<lang>.md)

**Status:** <proposed|implemented|rejected|archived>
[**Approved:** <explicit|auto|unrecorded>]
[**Supersedes:** [..](..)]
[**Superseded by:** [..](..)]
[**Relates to:** [..](..)]
[**Archived:** YYYY-MM-DD]
```

`**Status:**` 为必填，且必须与生命周期目录一致。只有 `archived/` 下的记录才可使用 `**Archived:**`。关系字段必须使用相对链接；每个字段最多出现一次。字段块里的其他 `**Field:**` 行会使检查失败；说明性文字应放到字段块之后。日期在文件名中，不使用 `**Date:**` 字段。

`implemented/` 下必须有 `**Approved:**`，注明谁接受了记录：`explicit` 表示用户，`auto` 表示 Agent 按[批准等级](implemented/2026-09-09-approval-tiers.md)接受，`unrecorded` 表示规则建立前接受的记录。这属于待偿债务；该记录下次被修改时应改为 `explicit`。

新建记录前，先搜索现有 owner。如果新选择细化的是同一项决策，就更新原记录。如果一项决策完全取代另一项，应双向链接两条记录并归档旧记录；如果只部分取代，则保留两条并说明各自剩余的范围。使用元数据时，写本地 Markdown 链接，并让译文和原文双向指向：

```markdown
**Supersedes:** [old decision](../archived/2026-01-01-old-decision.md)
**Superseded by:** [new decision](../implemented/2026-02-01-new-decision.md)
```

`Supersedes` 或 `Superseded by` 字段可以在一行内列出多个相对链接；每个目标均须在头部给出反向链接。首节之后的关系示例是正文，不是记录元数据；此一致性诊断仍沿用 CI 契约的 warning 级别。

决策记录按 [CI 契约](../README.zh-CN.md#ci-契约)提供英文、`.zh-CN.md` 和 `.terms.yaml` 配套。缺件使 `docs:check` 失败；双向链接和标题漂移仍以 warning 交由审阅处理。

## 查找决策

生命周期目录树就是清单：浏览 `docs/decisions/{proposed,implemented,rejected,archived}/` 或搜索仓库。不维护逐条索引，因为这种列表会重复每条记录的标题和未完成事项、产生第二个 owner，并且在没有检查机制时逐渐过期。`npm run docs:check` 会报告已实现决策数量以及含开放事项的记录数量。
