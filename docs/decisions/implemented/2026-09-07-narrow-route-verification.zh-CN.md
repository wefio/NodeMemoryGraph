# 窄域验证:轻量件组合成完整门

**Status:** implemented
Date: 2026-09-07
Branch: pr/rcp-narrow-verify

治理元规则: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) —— 这是对既有验证约定(RCP/agent-verify 路由语义)的改动,故记治理决策。

English: [2026-09-07-narrow-route-verification.md](2026-09-07-narrow-route-verification.md)

## 问题

RCP 的职责是守门:独立验证改动并把证据绑进不可变收据。门不能**挡住门外的正常开发**。如今几乎所有命中核心/适配器路由的代码改动都会整包跑 `test:product` + `build`,因为路由把验证声明成几个整仓库 npm 脚本:

```yaml
# pi-adapter / claude-adapter / workbuddy-adapter / core-*
verify:
  blocking: [check, test:product, build]
```

`test:product` 无论改了什么都会跑全部产品测试目录——即便只是适配器有界域内的一行改动。而同类的 `dsh-adapter` 路由只声明 `[check]`——路由声明内部不一致,也没有“路由自己的窄验证”这个概念。

窄的原始能力仓库里本来就有:每个路由声明 `tests: [tests/.../**]`,`node --test <globs>` 正好只跑那些。粗脚本就是这些工具调用的组合,所以“轻量”一直就在工具里;缺的是 (a) 路由声明自己的有界验证、而不是整包脚本,(b) 一条判断何时收窄安全的覆盖规则。

## 决策

验证是**同一套词汇上轻量件的组合**:对一次改动跑完整门,就是把那次改动需要的窄件全跑满。只有两级:

- **窄**:改动被一个路由的有界域干净拥有(它的 `tests` globs),且不碰横切文件 → 跑该路由自己的测试(`node --test <route.tests>`)+ 必跑共享不变量。
- **全量**:任一改动文件是共享/横切(无单一干净 owner,或属于 `src/core`/`src/lab`/`src/integration`/`src/rcp`/`tests/`/`package.json`/`.github`/`scripts`/`tools` 等基座)→ 跑声明的整包阻塞集(`test:product` 等)。安全第一——从不为无法界定爆炸半径的文件猜窄范围。

必跑共享不变量(tsc via `check`、`docs:check`、`format:check`、`lint`、`package:check`)对每次改动保持整包。

只两级的原因:中/宽档只加判断、无安全增益。要么一个文件的 owner 无歧义(窄),要么不是(全量)。“拿不准就跑全量”就是全部安全规则。

## 后果

- 路由声明保持每域验证的唯一来源:拥有它的路由自己的 `tests` 即窄集。窄以 opt-in `agent:verify --narrow` 快路径暴露;默认权威门在覆盖规则被信任前不变。适配器叶子路由的默认阻塞(今天比同行 `dsh-adapter` 多跑 `test:product`)对齐是窄被采纳后的后续。
- 开发/agent 快路径(`agent:verify --narrow`/按路径)组合必跑共享项 + 每个命中路由自己的测试;结果正是权威门对一次被完全拥有的改动会跑的那套。这让“轻量组合=完整 RCP”对可本地化的改动成立,而任一共享文件时权威门仍整包。
- 不新增执行器、不建 primitive 注册表:底层工具(`node --test`/`eslint`/`prettier`/`tsc`)本就吃窄参数。我们只加路由粒度 + 一条覆盖规则,不加机器。

## 考虑过的替代方案

- **primitive 注册表**(把粗脚本拆成带 `scopeable`/`fix` 元数据的原子检查)。拒绝:是多余机器——脚本包的每个工具本就可在文件子集上单独跑。真正的缺口是路由粒度 + 覆盖规则,不是新执行器。
- **每路由 npm 测试脚本。** 拒绝:要维护一堆脚本同步;从路由声明直接 `node --test <route.tests>` 才是单一真相源。
- **窄/中/全三档。** 拒绝:中档无安全理由;两级够且更好推理。

## 证据

- `tests/tools/narrow-verify.test.ts` —— 覆盖分类:单一干净 owner → 窄;共享/横切 → 全量;无主/多主 → 全量。
