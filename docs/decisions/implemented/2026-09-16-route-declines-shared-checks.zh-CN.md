# 路由可以声明“常驻共享检查不适用”

**Status:** implemented  
**Approved:** explicit
Date: 2026-09-16
Branch: feat/ooo-run-namespace

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本规则变更本身也是一次受治理的决策（决策 + 归属 + 替代方案）。

English: [2026-09-16-route-declines-shared-checks.md](2026-09-16-route-declines-shared-checks.md)

## 问题

narrow gate（`agent:verify`，见 [CI/RCP §7.14](../../design/ci-cd-and-quality.md#714-轻量验证默认narrow-gate)）
对**任何** narrow 改动都会运行常驻共享检查（`NARROW_SHARED_CHECKS`：`check`、`docs:check`、
`format:check`、`glossary:check`、`lint`、`package:check`、`rtm:check`），不管改的是什么表面。
对一次被单一路由干净拥有、且不含代码的改动——例如给 `.gitignore` 加一行——这些检查**都不可能因它而失败**：
它们读的是 `tsconfig`、ESLint 配置、`.prettierignore`、docs、术语索引、contract 与打包闭包，
没有任何一个读 `.gitignore`。这次运行因此不是证据，而是开销，并且把“本来不可能有别的结果”的检查
报成 `passed`。

在本次决策之前，想表达“这个表面不需要这些检查”只有两条路：声明一条 blocking 为空的路由（实测
并不能去掉共享检查——计划里七条照样出现），或者把该路径排除在路由之外（`agent:verify` 会失败关闭，
而不是猜）。两者都没有说出事实。

## 决策

**路由可以声明常驻共享检查不适用于它自己拥有的表面**，写法是 `agent-context.yaml` 里的
`verify.sharedChecks: "always" | "none"`（默认 `"always"`，即所有未声明路由的现状）。

声明只在有意义处生效，且每条限制都是机械的：

- **仅 narrow 路径。** 它只在构建 narrow 计划时被读取；共享 / 横切 scope（`src/`、`tests/`、
  `scripts/`、`tools/`、`.github/`、`package.json`、`package-lock.json`、`tsconfig.json`、
  `tsconfig.build.json`、`agent-context.yaml`、`AGENTS.md`）仍然升级为路由声明的 blocking 集，
  声明无法让代码表面变成“无地板”。
- **仅独占拥有。** 只有当每个改动 scope 恰好有一个属主路由时计划才 narrow；跨路由或有歧义的
  改动无论有无声明都升级并运行完整集合。
- **绝不等于“什么都不跑”。** `sharedChecks: "none"` 且 `tests:` 为空的路由在配置加载期被拒绝，
  否则计划会执行零个检查。验证工具绝不能把“什么都没跑”报成通过，而这是本声明唯一可能造成的坏结局。
- **未知取值失败关闭。** 除 `"always"`/`"none"` 之外的任何值在配置加载期被拒绝，而不是被读成其中之一。
- **记录而非推断。** receipt 的 `gate.reason` 写明这条声明，读者不必靠数计划里的检查条数才能发现
  地板被略过。
- **检查清单只有一个家。** `agent-verify` 从计划（`narrowPlan.shared`）构建检查清单，而不是
  再从常量推导一遍地板。

第一个声明它的路由是 `repository-tooling`，其唯一非共享路径是 `.gitignore`；它自己的测试
（`tests/tools/**`）仍然运行，而唯一读 ignore 规则的断言就在那里
（`tests/tools/complexity-gate-base.test.ts`：complexity gate 的探针目录必须对 `git status` 不可见，
否则该 gate 会把自己的残留当成改动文件来测）。

## 考虑过的替代方案

1. **到处都继续跑共享检查**（现状）。否决：它以“计划统一”换来了对本次改动不可能失败的检查的执行，
   而这正是侵蚀“绿门”可信度的仪式；它还把真正的问题——“这次改动什么能失败？”——藏在一个固定清单后面。
2. **让每条检查声明自己的输入，按依赖裁剪计划**（依赖映射）。原理上更正确，也大得多：它改变每条路由的
   含义，需要“改动类型 → 消费者”的映射，其证据本身就是一个研究项目。作为“按路由声明太粗”时的方向保留。
3. **把空 blocking 集当作“无检查”**（`blocking: []` 时去掉地板）。否决：它会让路由因疏忽而无人检查
   （空列表很容易写成，含义是“没有要跑的”而不是“共享检查不适用”），而且实测根本不起作用——地板是
   独立于 `blocking` 注入的。
4. **让 `.gitignore` 无路由。** 否决：`agent:verify` 对无法命中的 scope 是失败关闭而不是猜，
   于是每一次无害的 ignore 修改都会让门变红，而绕过手段（`-- <owned-path>`）会把它静默排除出计划。
5. **按路径声明**（声明里写明适用的路径）。当前否决为过早：今天只会有一条记录，而路由级写法让声明与
   该路由的测试、归属文档待在同一处。若某路由确实需要对多个表面中的一个声明，再重新审视。

## 后果

- 这个能力是一份**声明**而不是推断：没有任何东西会因为疏忽而变窄，而变窄后的“绿”含义更少，
  这一点由 `gate.mode`/`fullGateRun`/`gate.reason` 记录。
- **残余风险，写出来而不是藏起来：** 声明是路由级的，因此给 `repository-tooling` 再加一条非共享路径
  会静默地把声明扩展到那条路径。机械防线只防住了最坏结局（零检查）；新路径的覆盖没有被检查。
  如果第二个路由需要这条声明，应当在那时重新审视判定标准。
- `.gitignore` 保留一条有意义的检查——路由自己测试里的消费者断言——而 ignore 语义仍然是 git 的职责，
  任何门都不该去重复它。
