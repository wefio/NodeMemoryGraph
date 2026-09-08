# RCP 轻量化验证默认为窄(提案)

[English](2026-09-07-rcp-lightweight-verification-default.md)

**Status:** proposed
**Date:** 2026-09-07
**Relates to:** [repository-control-plane](../implemented/2026-08-29-repository-control-plane.md),
[narrow-route-verification](../implemented/2026-09-07-narrow-route-verification.md),
[repo-development](../../../skills/repo-development/SKILL.md)

## 问题

RCP 门守仓库,绝不能挡正常开发。如今命中核心/适配器路由的改动都付整包声明的阻塞集——多数路由声明
`[check, test:product, build]`,而 `test:product` 无论改什么都会跑全部产品测试目录;同类 `dsh-adapter`
却只声明 `[check]`。声明内部不一致,也没有路由表达自己的**有界**验证。#31 把窄路径做成了 opt-in
(`agent:verify --narrow`),但默认权威门没变,日常开发仍付整包,适配器叶子路由仍多跑 `test:product`。

## 提案

验证是**同一套词汇上轻量件的组合**;对一个改动跑全量门,就是把那次改动需要的窄件全跑满。把窄设为**默认**:

1. **默认窄,拿不准就升全量。** 改动被恰好一个非共享路由干净拥有 → 只跑该路由自己的测试
   (`node --test <route.tests>`)+ 必跑共享不变量(`check`/tsc、`docs:check`、`format:check`、`lint`、
   `package:check`)。任何共享/横切/歧义/无主路径 → 升级到声明的整包阻塞集。"拿不准就跑全量"即全部安全规则。
2. **共享根列表**(`src/ tests/ scripts/ tools/ .github/ package.json tsconfig*.json agent-context.yaml AGENTS.md`)
   恒为全量——改这里爆炸半径无界,绝不为它猜窄。
3. **对齐适配器叶子路由。** `pi-adapter`/`claude-adapter`/`workbuddy-adapter` 今天多跑 `test:product`;
   把它们对齐到各自有界测试(都已有 `tests:`),与 `dsh-adapter` 一致。核心/共享路由保持整包。
4. **不新增执行器、不建 primitive 注册表。** 底层工具本就吃窄 globs(`node --test <route.tests>`);
   收窄只需路由粒度 + 一条覆盖规则,不加机器。

默认翻转进 `agent:verify`(及任何 RCP 路由验证),`--full` 强制整包、`--narrow` 强制窄。覆盖规则是已测的纯函数
(`tools/narrow-verify.ts`,来自 #31)。

## 考虑过的替代方案

- **primitive 注册表**(把粗脚本拆成带 `scopeable`/`fix` 元数据的原子检查)。拒绝:冗余——每个脚本包的
  工具都可在文件子集上跑;真正的缺口是路由粒度 + 一条覆盖规则,不是新执行器。
- **每路由 npm 测试脚本。** 拒绝:一堆要维护同步的脚本;从路由声明直接 `node --test <route.tests>`
  才是单一真相源。
- **窄/中/全三档。** 拒绝:中档只加判断、无安全增益;两级更好推理。
- **只保留 opt-in。** 对默认而言拒绝:它让日常开发仍付整包,也没修适配器叶子不一致。

## 验收标准

- 一行改动若只落在某个叶子适配器自身有界域 → 默认路径只跑该路由测试 + 共享检查(不跑 `test:product`)。
- 改动触碰任何共享/横切路径 → 跑完整阻塞集。
- 覆盖规则的分类(单干净 owner → 窄;否则全量)由 `tests/tools/narrow-verify.test.ts` 覆盖。
- 对无主/歧义改动的权威门,绝不弱于今日的整包集。
- 路由声明保持每域验证的唯一来源。

## 风险

- **静默覆盖丢失**:若某路由的 `tests:` glob 不再覆盖它拥有的代码。由安全规则缓解:任何不恰属一路由、
  或属共享根的路径都升全量——窄只作用于无歧义单 owner 的非共享文件。
- **归属漂移**:文件在路由间移动。由歧义/升级默认(0 或 >1 owner → 全量)缓解,而非猜测。
- **采纳阻力**:默认翻转改变每次路由验证行为。由显式 `--full`/`--narrow` + 共享根升级不变缓解。
