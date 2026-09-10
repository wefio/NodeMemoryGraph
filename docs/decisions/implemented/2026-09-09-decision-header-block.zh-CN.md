# 决策记录的固定头部字段块

[English](2026-09-09-decision-header-block.md)

**Status:** implemented  
**Approved:** explicit

## 问题

决策记录的元数据既没有稳定的位置，也没有规则。`docs:check` 在文件的**任何位置**
读取 `**Status:**`、只取第一个匹配，其余一概不校验。2026-09-09 的三个探针确认了
这个缺口：第二条冲突的 `**Status:**` 被忽略、`**Date:** 1900-13-99` 被接受、放在
第一个章节之后的 `**Status:**` 也能通过。

字段词汇**已经在漂移**——这正是「头部无规则」的产物：

| 在用字段 | 数量 | 问题 |
|---|---|---|
| `**Status:**` | 21 | 唯一被校验的字段 |
| `**Date:**` | 13 | 与文件名日期重复；另外 8 条决策干脆没有它 |
| `**Branch:**` | 3 | 在耐久散文里写分支位置，正是 slop 清单禁止的 |
| `**Implementation status:**`、`**Partial implementation (…):**`、`**Also implemented:**`、`**也已实现:**` | 4 | 同一个意思的四种写法，全是披着字段外衣的散文段落 |

`**Date:**` 是最清楚的一例：每个带它的决策，其日期都等于文件名日期，而另外 8 条
决策完全没有它——这个字段既冗余又不一致。

## 决策

决策在第一个章节之前携带一个固定字段块，由 `docs:check` 强制：

```markdown
# <标题>

[<对照语言>](<slug>.<lang>.md)

**Status:** <proposed|implemented|rejected|archived>
[**Supersedes:** [..](..)]
[**Superseded by:** [..](..)]
[**Relates to:** [..](..)]
[**Archived:** YYYY-MM-DD]
```

该块是封闭的：只有 `**Status:**`、`**Supersedes:**`、`**Superseded by:**`、
`**Relates to:**`、`**Archived:**` 五个字段。第一个章节之前的任何其它
`**字段：**` 行都会让检查失败，散文式说明因此移到块下方。每个字段最多出现一次。
`**Status:**` 必填且必须等于生命周期目录名；`**Archived:**` 只在 `archived/`
下有效。

`**Date:**` 被删除。文件名已经携带 `YYYY-MM-DD`，这个字段是同一事实的第二份副本；
那 8 条没有它的决策并没有缺失任何信息。`**Branch:**` 作为改历史叙述被删除。四个
散文式伪字段变成块下方的普通段落。

规则住在 `docs/decisions/README.md`；门禁与其测试在 `scripts/verify-docs.mts` 与
`tests/docs/verify-docs.test.ts`。

## 考虑过的替代方案

**YAML front matter。** 它让元数据可被轻松解析，但 `Status` 与生命周期已经住在
路径和 `**Status:**` 行里，日期住在文件名里；front matter 会成为第四份副本。MADR
选择 front matter 是因为 ADR 的文件名不携带日期、ADR 目录树不携带生命周期目录；
NMG 两者都有。

**每条决策一个 sidecar 元数据文件**（Kubernetes KEP 用 `kep.yaml`）。它把元数据与
散文干净地分开，并让生成器无需解析 Markdown 就能读取。在 21 条决策的规模上，它为
每条决策多出一个文件，外加两者之间的一致性问题。

**连块内的裸 `Word:` 行也拒绝。** 那能堵住最后一个缺口，但有一条未提交的决策仍然
带着没有粗体标记的 `Date:` 与 `Branch:` 行，拒绝它会让并发 agent 的在途文件失败。
记入 Deferred。

**保留 `**Date:**` 并要求它。** 渲染后的文档能看到日期，代价是给一个文件名已拥有
的事实再添一个家，并要编辑 8 条决策补上它。

**同时强制字段顺序。** 现有语料里字段顺序已经一致；顺序不是这条规则需要解决的问题。

## Deferred

头部块里的裸 `Word:` 行目前仍被当作散文接受，因为有一条未提交的决策带着没有粗体
标记的 `Date:` 与 `Branch:`；拒绝它会让该 agent 的在途文件失败。等它落地后再议。

## 验证

截至 2026-09-09 已验证：
- 重复字段、块内未知字段、缺少 `**Status:**`、以及在 `archived/` 之外使用
  `**Archived:**` 时 `docs:check` 失败，每种在 `tests/docs/verify-docs.test.ts`
  中都有测试。
- 没有任何决策携带 `**Date:**` 或 `**Branch:**`。
- `docs/decisions/README.md` 写明该块及其规则。
- `npm run docs:check` 报 0 错误、且不新增警告。

## 后果

**裸 `Word:` 行仍被接受。** 没有粗体标记的字段会被当作散文，因此门禁只覆盖文档化
的语法。

**散文压力。** 想在文件顶部写说明的作者必须把它放到块下方。这正是意图：块保持
机器可读。
