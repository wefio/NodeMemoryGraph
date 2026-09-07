# 把在线反馈的发问点附着到每一次召回(而非一次性的 auto-only 提示)

**Status:** implemented
Date: 2026-09-07
Branch: pr/feedback-affordance

治理元规则: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) —— 这是对既有反馈/暂存约定的改动,故按治理决策记录。

English: [2026-09-07-recall-feedback-affordance.md](2026-09-07-recall-feedback-affordance.md)

## 问题

在线上下文使用反馈闭环(RSCB 式、daemon 拥有的 `ContextRouter` 学习器)几乎产生不出可信训练信号,而仅有的那点也是**误归属**的:

1. **发问是一次性的、脆弱的 nudge。** `online_feedback_nudge` 只在*自动预注入*召回真的注入记忆后才武装,下一条用户轮弹一次、收到反馈或会话结束即清。它**从不为模型自己显式 `nmg_search` 触发**——而在“模型决定要不要召回”的设计下,显式搜索才是模型真正检索的主路径——所以主召回路径根本没有发问点。
2. **只有 `autoRecall` 搜索会 stage。** 显式搜索浮出内容、被使用、收到反馈,但其图从不被暂存;反馈于是落到会话级回退。
3. **回退就是误归属机器。** `recordFeedback` 不带显式 `activeGraphId` 时绑定到 `latestStagedGraph(session)`——会话最近暂存的那张,通常与所评的召回无关。实测:一条天气召回的正向评分,训到了更早一条设计文档轮的决策上,静默发生。这是系统性的、不是一次:每条关于显式搜索的反馈,不是错绑就是落空。

## 决策

1. **发问点是召回输出的属性,允许出现在每一次召回。** 每条召回表面——自动预注入、模型自己的 `nmg_search` 结果(pi),以及每条召回快照首次展示(dsh)——都携带一个紧凑评分口,指明被评的 `activeGraphId`,邀请 `nmg_remember action=feedback`。不再有下一次性调度、不再有会话级状态机。
2. **任何产生 disclosure 图的搜索都 stage。** daemon 对浮出内容的搜索(自动/显式一视同仁)都暂存;`persistTrace:false` 的内部 probe 选择退出。
3. **反馈只按它点名的图绑定。** `recordFeedback` 只训练显式给出的 `activeGraphId`。会话最近暂存回退被删除;没有显式图就跳过,而不是错绑。

## 后果

- 天气式失败在“展示轴”上被处理:显式搜索浮出的内容现在可被评分,并训练到正确那张图。
- 旧的 auto-only 门槛与 `latestStagedGraph` 回退被删除(`src/lab/context-router-online.ts`, `src/cli/service.ts`)。
- “要不要召回”仍由模型决定(见触发体制设计);廉价词法检测器只负责举手、从不拍板。神经 `ContextRouter` 刻意不是检索前触发——它站得住脚的角色是检索后的内容/升级控制,而这需要先有正确绑定的每用数据才值得训练。
- 各适配器的队列态(pi `onlineFeedbackPending`、dsh `onlineNudgeQueue`)被删除;评分口文案只存一处 `src/prompts/nmg-prompts.yaml`(`recall_feedback_affordance`)。

## 考虑过的替代方案

- **保留一次性 auto-only nudge、扩展到显式搜索。** 拒绝:它保留了调度状态机,(a) 会漏掉从没武装过它的召回,(b) 仍依赖“下一条轮”的提醒,而不是让召回在被展示当下就可评。
- **只用 controller-shadow 归属轨迹绑定。** 对在线训练器拒绝:归属是从“答案用了哪些记忆”反推的,属于不同的(shadow/覆盖)数据集,不是在线 router 训练用的每决策特征。
- **会话最近暂存回退,并加“仅在无歧义时”护栏。** 拒绝:歧义恰恰是故障形态;评分口上总有显式图 id,回退只添风险、无收益。
- **机械回合末标注(option B)直接当发问。** 缓办、未拒绝:从答案-overlap 推导标签无需发问,是不错的冷启动补充,但测不出质量维度(噪音/误导)。保留为文档化后续,若评分口响应不足再上。

## 证据

- `tests/cli/context-online-rpc.test.ts` —— 任意 disclosure 搜索都 stage,`persistTrace:false` 的 probe 不 stage,无显式图的反馈不训练。
- `tests/extensions/nmg/context-router-online.test.ts` —— `consumeFeedback` 按精确图 id 绑定,无会话级回退。
- 实况 shadow-events 审计(2026-09-07):当天三条都评显式搜索图;旧回退下三条中两条错绑或落空。
