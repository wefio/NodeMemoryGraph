# 查询决策记录的派生态

[English](2026-09-09-doc-lifecycle-state-query.md)

**Status:** rejected

## 问题

决策记录的**声明**状态就是它所在的目录——`proposed/`、`implemented/`、
`rejected/`、`archived/`——而 `docs:check` 保证这个声明不撒谎：`**Status:**` 必须
等于目录名、头部字段集封闭、本地链接必须可解析。但没有任何东西回答**观察**层面的
问题：一条 `proposed/` 记录的验收标准其实已经全部满足，或一条 `implemented/` 记录的
标准已经不再成立。曾有 19 个设计文档带着自由文本状态，而这种漂移直到有人把它们全读
一遍才被发现。

## 提案

在读取时派生决策状态，并把它暴露为一个命令：

```text
$ npm run docs:state
  declared      observed              record
  proposed      ready-to-accept       2026-09-06-board-governance-addressing
  implemented   drifted (1/7)         2026-08-08-…
```

派生态是「标准 + 收据」的函数：决策的 `## Verification` 携带一个机器可读块
（`id`，以及 `check` | `grep` | `documented-only`），`docs:check` 校验该块的形状，
命令读取该块与 `.rcp` 收据，报告 declared 与 observed 的差。配套的
`nmg docs promote <slug>` 执行已接受转移中的机械部分（`git mv` + 改写
`**Status:**`），默认 dry-run。

## 考虑过的替代方案

**用一句提示词代替命令。** 一句 Skill 文案——读 `docs/decisions/**`，报告 declared
与 observed——不需要代码、测试或 CLI 表面。否决理由与命令相同：没有消费者。

**标准通过时自动提升。** 直接否决。接受是判断，不是计算；一个「等于测试通过」的目录
与 CI 重复；一棵会改写自己的树无法从某个 commit 复现。dsh 校验 note 的分类而从不移动
note；PEP、KEP、MADR 的晋升都是人的决定。

**什么都不做——文件夹已经是状态。** 采纳。

## 为什么被否决

这个查询没有消费者。`docs:check` 已经让**声明**状态可信，所以读文件夹本身就能回答
「它现在是什么状态」，不需要派生层；而能跑这个命令的 Agent 大概率不会去跑它。命令
本会暴露的唯一缺口——一条标准已满足的 `proposed/` 记录——从来没有人问过；真有人问的
时候，打开文件读一眼即可。

**建一个没人读的读取器，和写一份没人读的数据是同一种失败。**
`WorkOrder.expectedArtifacts` 从第一版就声明了，无人读取，2026-09-09 被删除；自由文本
的 `**Status:**` 写在 19 个文档里，机器一个也读不出来。机器可读的数据靠**恰好一个
读者**活着：0 个读者是死数据，1 个读者是活的（`docs/glossary.yaml` 与
`glossary-check`），多个读者则是值得配门禁的集成。

## 后果

`docs/decisions/` 只保留一套机制：生命周期目录加上 `docs:check` 的不变量。没有
`docs:state`，没有 `nmg docs promote`，决策记录里没有 `verification:` 块，也没有为它
准备形状门禁。决策的标准仍然是 `## Verification` 下的散文——那是人读它的地方。
