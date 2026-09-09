# 仓库术语索引

[English](2026-09-08-repository-terminology-index.md)

**Status:** implemented
**Date:** 2026-09-08
**Branch:** feat/rcp-lightweight-verification

## 问题

Agent 在本仓库里搜索、什么都没找到，于是断定该能力不存在，然后**再建一遍**。这个失败模式——**搜不到 → 当作没有 → 新增**——正是本仓库元规则要禁止的重复造物：一处一规则。三个发现说明它是活的。

**已有的两张术语表都没接在检索上。** 仓库有一份概念地图（`docs/guides/concept-map.md`，双语），给每个产品概念一个操作含义并链接到其 contract owner；`agent-context.yaml` 也带机器可读的 `capabilities[].aliases`（例如 `memory-runtime` → `memory-daemon, durable-memory`），重复别名会被 `tools/repo-context.ts` 拒绝。但概念地图只有人读，而 aliases 只在**一条路径**上被消费——显式的 `agent:context --capabilities <名字>` 查询——不在搜索上。**不存在"描述一个概念 → 找到它的家"这条路径。**

**概念地图不覆盖撞名真正发生的那批词。** 它列的是产品概念（HistoryRecord、STG、LTG、AG、QPP），不列仓库的流程词汇：contract、assertion、check、stage、kind、evidence、context、route、receipt、narrow、gate。2026-09-08 观察到的每一处撞名都在这批词里：三处各自声明"跑什么"（`agent-context.yaml` 的 route `verify.blocking`、`NARROW_SHARED_CHECKS`、`contract.verification.checks`）；`invariants` 被写进 `WorkOrder` 却无人读取；`assertions` 是在 `invariants` 还存在时被引入的。这个代价仓库已经付过一次：书签功能因为一个词背了四种含义（其中两种在同一个文件里），从 "anchors" 改名为 "tesserae"（`rejected/2026-09-02-keep-bookmarks-named-anchors`）。

**没有任何东西强制"先搜索"。** `docs/decisions/README.md` 写着"创建记录前先搜索已有的 owner"——这是重复提醒，不是机械检查。而仓库的元规则偏好机械检查。

## 决策

一张机器可读的**术语索引**、一个校验器、一个创建时的守卫。**不建第三张手工维护的表。**

1. 一张统一的术语表（`docs/glossary.yaml`，或把 `agent-context.yaml` 的 capability 列表扩展成术语表）映射 `term → canonical → aliases (en/zh) → owner (doc#anchor) → status`。概念地图由它渲染（或就是同一个文件），两者不会漂移。
2. 表只**指向**，不**定义**。每条都解析到拥有完整契约的文档，从而把概念地图已有的规则——"地图与 owner 冲突时，owner 说了算"——变成机械的。
3. 索引**被检索消费**，不只被人读：aliases 进入搜索路径，于是 `轻量验证`、`narrow`、`lightweight verification` 解析到同一个 owner。最小版本就是把 `capabilities[].aliases` 从"显式选择"扩展到"查询解析"。
4. 校验器在以下情况**失败关闭**：某条的 `owner` 解析不到存在的文件与标题；两条声明了同一个 canonical 术语；`deprecated` 术语没有 `successor`。它以阻塞检查（`glossary:check`）在窄化与 full 两条路径上运行，规则摘要钉在 `.rcp/trusted-policy.json`——与 `testOutputPassed`、`rtm:check` 同形。
5. 创建时守卫负责校验器抓不到的那部分：**重复检测，而不是搜索日志**。新增的概念、契约或决策，若其名字或别名已解析到某个 owner，则失败——除非该记录声明它 refine 或 supersede 了哪个已有的家。记录"我搜过"可以刷；检出"这已经有家了"刷不了。
6. 索引同时覆盖流程词汇与产品词汇，让 `assertion`、`check`、`stage`、`kind`、`evidence`、`context`、`route`、`receipt`、`narrow`、`gate` 在追溯矩阵开始使用它们之前，各自只有一个 owner。

2026-09-08 已落地：`docs/glossary.yaml` 承载流程词汇，`npm run glossary:check` 校验 owner 解析、重复术语与别名、deprecated 的 successor，负例在 `tests/tools/glossary-check.test.ts`。该检查在 `verify:static`、窄化共享检查、`documentation` route 的 blocking 集合与两份 authored contract 中阻塞运行。`npm run glossary:check -- --resolve <名字>` 把术语或别名映射到其 owner，这就是检索路径。

## 考虑过的替代方案

- **写一份新的术语表文档。** 否决：仓库已有两张表，第三张正是本决策要防止的重复。扩展已有的。
- **继续依赖 `docs/decisions/README.md` 的"先搜索"提醒。** 否决：提醒正是元规则要用机械检查替换掉的东西；而且搜索会因为词汇不同而落空，概念却存在。
- **全量扫描文档找未登记术语。** 作为不可靠方案否决：自然语言没有机械的词边界，全量扫描只会产生噪声并成为 Goodhart 目标。守卫改为在创建时触发。
- **把索引放进 NMG memory 而不是仓库。** 作为主家否决：memory 是历史的、会话范围的，而仓库词汇必须能在 PR 里被评审、离线可用。memory 仍可承载别名作为 recall trigger。
- **采用形式化本体或 SKOS。** 否决：对单人维护太重；需要的属性只有 canonical 名、别名、唯一 owner、状态。

## 验收标准

截至 2026-09-08 已满足：

- 存在一张机器可读术语表，每条都解析到存在的 owner 文件与标题。
- `glossary:check` 对不可解析的 owner、重复 canonical 术语、被两次认领或与另一术语同名的别名、无 successor 的 deprecated 术语失败关闭。
- `glossary:check` 在窄化与 full 两条路径上都是阻塞项。
- 检索能把术语或别名解析到其 owner（`glossary:check --resolve`）。

仍未满足：

- 术语表覆盖流程词汇；产品概念仍留在概念地图里，由术语表引用，因此尚未进入同一张表。
- 概念地图不由该表生成，两者仍可能漂移。
- 规则摘要未钉在 `.rcp/trusted-policy.json`：`trusted-verify` 从**已安装基线**读策略，只写进工作树的 obligation 在下一次 `trust-install` 之前是没有效果的声明。
- 对新增概念/契约/决策的**创建时重复检测**未实现；今天只拒绝表内部的重复。

## 后果

- 表是维护成本，会腐烂；让它活着的是校验器，不是纪律。
- 索引**不能**证明没有遗漏，只能证明每条已登记的术语只有一个家。“没找到”绝不能被读成“不存在”。上面的“仍未满足”正是这个边界的一部分：产品术语与新建概念目前还不在守卫范围内。
- 别名提高检索召回，但不保证命中；落空仍然可能，所以守卫必须是创建时的重复检测。
- 把每个名词都登记进来会让索引变成噪声；条目应当是**有 owner、有契约的概念**，不是通用词汇。
- 阻塞式术语检查可能被"改名"而不是"解决撞名"绕过；`status` 字段必须记录 successor。
