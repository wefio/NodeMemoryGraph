# 书签功能继续命名为 "anchors"

[English](2026-09-02-keep-bookmarks-named-anchors.md)

**Status:** rejected  
**Date:** 2026-09-02

## Problem

记忆书签功能（记忆指向的文件位置，以内容 snippet 为锚）以 "anchors" 之名发布（`anchors` 表、`anchor_ref` markers、`--anchor` CLI 参数）。在审视长期清晰度时，发现代码库与生态中已存在三个无关的 "anchor" 概念：

- **Surface anchors**（`src/core/store/` 的 `surfaceAnchorCandidates` / `surfaceAnchors`）：检索侧的显式引号短语/路径/ID，为精确匹配搜索建索引——一个无关的、先于本功能存在的产品概念，且位于与书签命中**同一条搜索路径**。
- **Pi task anchors**（Pi 扩展的 `state.anchors`）：跨简洁轮次携带的近期实质性用户任务上下文。
- **Support anchors**（`reasoning-workspace`、`qpp`、`hierarchical-activation`）：Lab 推理中的"稳定证据引用"、QPP 的 top-1 查询锚、LTG 节点向量锚。

一个词，四种含义；其中两种在同一个文件里（`src/core/store/retrieval.ts` 同时承载 `surfaceAnchorCandidates` 与 `searchAnchors`）。

## 提案

保留已发布的 "anchors" 命名，依靠上下文与 `(bookmark)` 括注消歧。

## 考虑过的替代方案

- **限定名，如 `memory-anchor` / `file-anchor`。** 拒绝：每个 CLI 参数更长，且仍重载共享词；grep 与搜索结果必须带限定词才有意义。
- **代码里保留 "anchor"，只改用户可见表面。** 拒绝：混淆最严重处正是渲染边界（`anchor=` 行），部分改名把撞名留在读者实际看到的位置。
- **改为改其他概念。** 拒绝：`surfaceAnchor` 是更早、被广泛引用的检索术语（设计文档、benchmark 笔记），Pi 的 task-anchor 位于我们无权修改的另一个仓库；改书签名是我们完全掌控内的唯一改动。

## 为什么拒绝

- **同一条搜索路径，两种含义。** 书签命中与 surface-anchor 命中都流经检索上下文；读者或 agent 看到 `anchor=` 渲染行，不读代码无法分辨是哪一种概念产生的。
- **检索质量讨论需要区分。** 检索 benchmark 与设计笔记区分 surface anchors（显式 token 检索）与普通词重叠；重载 "anchor" 使该讨论含混。
- **改名成本此时最低。** 功能几天前才合入、无外部消费者、真实库存量行全是测试数据——改名是机械、低风险操作（见改名 PR）。命名债务只随年龄增长。
- 替代名选定为 **tessera**（复数 _tesserae_），源自拉丁语 _tessera hospitalis_——一分为二、相合证身份的凭证牌——契合 snippet 重定位模型（书签的 snippet 半必须与文件内容半相合）。该词在代码库零先例，不可能撞名。

## Consequences

- 功能现以 `tesserae` 全链路命名：表、FTS、markers（`tessera_ref`）、CLI（`--tessera`）、检索渲染（`tessera=`）、类型（`TesseraRecord/Input/Hit`）与设计文档（`docs/design/memory-tesserae-design.md`）。
- 前向迁移将改名前的 `anchors` 表原位 RENAME 并把 `anchor_ref` markers 重写为 `tessera_ref`，存量库无数据丢失升级。
- "Anchor" 仅在指代其余三种概念（surface / task / support）时留在代码库中，各自不再含混。
