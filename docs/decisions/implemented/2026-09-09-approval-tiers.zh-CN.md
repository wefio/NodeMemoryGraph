# 批准分层：绝大多数文档不需要批准

[English](2026-09-09-approval-tiers.md)

**Status:** implemented  
**Approved:** explicit

## 问题

`docs/decisions/README.md` 说 `implemented/` 记录是「accepted and implemented」。它没说谁接受、什么算接受、有没有东西在检查它。实际做法是 Agent 对每条记录都索取一次明确的「接受」，于是用户成了自己仓库的吞吐上限——而且那个请求往往是**同一份内容的第二次**，因为记录在代码写出来之前就先放进了 `proposed/`。

同一个洞也罩着记录周边的文档。没有任何地方说过一份指南、一份设计说明、一个 README 要不要批准，所以看起来安全的做法就是全都问。

## 决策

批准挂在**没有检查能判定的规范性内容**上——不是挂在文件类型上，也不是挂在「文档」这个类别上。判据只有一个问题：

> 这个文件写错了，什么会失败？

| 内容 | 谁批 | 例子 |
| --- | --- | --- |
| 描述性——写错只是浪费一次编辑 | **没人批** | `docs/experiments/**`、`docs/guides/**`、README、`**Status:** draft` 的设计、笔记 |
| 有检查盯着——写错会让门禁变红 | **检查批** | 零件货架、`docs/glossary.yaml`、`.rcp/contracts/**`、`.rcp/counterexamples.yaml`、收据 |
| 规范性、且没有检查能判定 | **`explicit` 或 `auto`** | `AGENTS.md`、`skills/*/SKILL.md` 里的常设规则、`**Status:** current` 的设计、`docs/decisions/implemented/**` |

### 缺检查就写检查，而不是继续问人

一份必须靠人读来批准的文档，就是一份检查还没写出来的文档。零件货架在 2026-09-09 只是**多了一条检查**（`docs:check` 在它提到已不存在的零件时失败）就不再是批准问题了。只要文档有可检查的性质，这个办法就适用。

### `implemented/` 记录上的 `**Approved:**`

每条 `implemented/` 记录在头部块里带一行：

- `explicit`——用户批准过这份内容。内容已商量好的记录**直接写进 `implemented/`**，不再停在 `proposed/` 等第二次询问。
- `auto`——Agent 按下面四条批准。
- `unrecorded`——在本规则之前被接受，没有留下行为记录。和 `documented-only` 同一种意义的欠账：下次触碰该记录时改成 `explicit`。

### `auto` 成立的四个条件

四条同时成立，没有例外：

1. **不碰验证装置。** 改动不触及任何 `.rcp/contracts/**`、任何 `*check*.ts`、`scripts/verify-docs.mts`、`agent-context.yaml`，也不触及 `docs/decisions/` 里的生命周期规则。
2. **同一次改动里已实现且门禁全绿**，`agent:verify -- <owned paths>` 覆盖该改动落到的每条路由。
3. **带 repeal condition**，写在 `## Risks` 或 `## Consequences` 下。
4. **一次 commit 可逆**——没有数据迁移、没有外部契约、没有不可撤销的副作用。

第 4 条既是准入测试也是安全性质：能自动升的，必须能自动降。`implemented/ → proposed/` 只需一个 commit、不需要新决策。做不到这一点的记录，就不许 `auto`。

### 自我指涉守卫

改**批准、生命周期或证据**这三件事本身的记录，永远不许 `auto`。本记录就是其中一条，所以它是 `explicit`。

### 本规则不改变什么

- `proposed/` 依旧存在，留给真正还没定的选择。
- 合并 PR 依旧是一个明确动作。
- `auto` 说的是记录可以移动，它没说内容是对的。

## 考虑过的替代方案

- **全都 explicit，忍受打断。** 否：那等于把用户放在自己仓库的关键路径上，而且会对同一份内容问两次。
- **让 Agent 批准任何它自己实现的东西。** 否：那正是本仓库已经否掉的自我认证形状（`harness-cannot-self-certify`）——写、实现、验证、批准全由同一个角色完成。
- **按 diff 大小或文件数批准。** 否：常设规则上的一行改动，分量大于五百行指南，轴选错了。
- **按文件类型批准**（`docs/**` 要批，`src/**` 不要）。否：`docs/design/**` 在 `current` 时是规范性的，`docs/experiments/**` 则被刻意定为非规范性，类型决定不了；「什么会失败」那个问题才能决定。
- **不要 `**Approved:**` 字段，只靠约定。** 否：那就没有任何东西能把「用户选的规则」和「Agent 选的规则」分开，而这个区分正是该字段的全部意义。

## 后果

- `docs/decisions/README.md` 增加第四个头部字段 `approved`，`docs:check` 要求每条 `implemented/` 记录都带它。
- 已在 `implemented/` 的记录中，有留存接受行为的标 `explicit`，其余标 `unrecorded`。欠账是可见的，不是被默认掉的。
- 指南、实验、README、draft 设计不再是批准问题。
- 代价：`unrecorded` 会腐烂；一条不诚实标成 `auto` 的记录没有任何东西能发现。反制手段是**便宜的可逆性**——以及下面的撤销条件。
- **撤销条件：若 30 天内出现两条 `auto` 记录被移回 `proposed/`，本规则作废**，所有记录恢复显式批准。

## 待办

- `docs/design/**` 有同一个洞：`draft → current` 没有归属。提议的判据——`current` 意味着有规范性的东西指向该文件——不在本记录实现。
