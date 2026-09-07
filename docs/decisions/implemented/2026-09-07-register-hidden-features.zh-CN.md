# 登记所有隐藏(环境变量门控 / 非默认)功能

**Status:** implemented
Date: 2026-09-07
Branch: feat/meta-rule-governance

Governing meta-rule: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) — 本规则变更本身按它记为受治理决策(decision + 注册表 + 备选)。

English: [2026-09-07-register-hidden-features.md](2026-09-07-register-hidden-features.md)

## 问题

NMG 有许多默认不激活、靠环境变量或模式开关启动的能力:controller shadow 评估、
可学习折叠(QPP1/QPP2)、controller rerank、搜索建议、lab 工具、在线 context-use 学习。
没有任何一个地方说明:这些功能是什么、哪个开关打开、默认值多少、归属谁、
是生效/影子/试验/休眠/还是只是计划中。

这种不透明性造成了真实缺陷(2026-09-07):在线 context-use 反馈回路**存在**
(daemon 每次 auto-recall 都 stage 图),生产环境却**从没产生过一条真实 feedback**。
唯一存在的反馈提示(`shadow_feedback_nudge`)挂在旧的 controller-shadow 功能上、
受 `NMG_CONTROLLER_SHADOW` 门控;在线路径没有自己的提示。因为隐藏功能散落在
各适配器/源码、又没有登记,这个断点要用户手工追代码才看得见。

失效模式是普遍的:一个 Agent 无法枚举就无法审计/启用/交接一个功能;一个没人
能枚举的功能会漂移直到静默坏掉。

## 决策

**所有隐藏功能必须登记。** 隐藏功能 = 运行系统里默认不激活的任何能力,
尤其是任何由环境变量或模式开关(`off`/`shadow`/`active`、opt-in `=1`、opt-out `!=0`)
控制的功能。

规则:

1. **集中注册表。** 全部此类功能登记在 `docs/design/hidden-features-registry.md`,
   即唯一的事实清单。无论归属谁、无论状态如何(默认开 / opt-in / shadow /
   试验 / 休眠-被取代 / 进行中 / 计划未建),都要登记。
2. **登记无条件。** 无论功能属于核心团队、某适配器(pi / DSH / 其他)、之前的
   某个 Agent,还是正在构建中,都必须登记。"不是我做的"和"还没做完"都不是
   跳过登记的理由。
3. **创建即登记。** 任何新增 env 门控或模式开关的改动,必须在同一改动里新增
   (或更新)注册表条目。不允许出现没有清单行的隐藏功能。
4. **变更即更新。** 门控名、默认值、归属、状态变化时更新条目;功能在默认开与
   opt-in 间切换时更新状态。
5. **缺口也登记。** 只以断点或缺失接线形式存在的计划能力,登记为计划/开放条目,
   以免再次静默消失(缺失的在线反馈提示就是这样被跟踪的)。
6. **注册表是 seam。** `docs/design/hidden-features-registry.md` 是活的 ledger,
   不是带日期的决策。本记录立规则;ledger 记事实。

## 考虑过的替代方案

- **功能只写在自己的模块里。** 拒绝:模块内注释正是藏住反馈断点的那种分散状态;
  审计需要单一枚举点。
- **自动扫描 env 代替手工注册表。** 部分有用但不充分:env 扫描无法表达状态、
  归属、意图,且会漏掉拼接式门控名(如经 `environment` 参数读取的模式开关,
  不是字面 `process.env.X`)。注册表为准;日后可用自动扫描做交叉校验。
- **把规则挂到 agent:verify。** 推迟:把强制接入验证管线是另一件更大的改动。
  现阶段常驻规则 = 注册表契约 + AGENTS.md 指针。

## 后果

- 一个地方回答"有哪些隐藏功能、各自怎么开、归谁、什么状态"。
- 新增 env 门控的工作把注册表行作为正常改动的一部分带上。
- 在线反馈断点现在是一条可见的已登记计划条目,不再是隐形假设。
- 未来自动扫描可拿注册表对代码做校验,把手动规则变成机器检查。

关联:[hidden-features-registry](../../design/hidden-features-registry.md)。
