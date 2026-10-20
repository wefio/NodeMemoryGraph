# 共享召回入口诊断：中文回忆问句

[English](shared-recall-entry-diagnosis-2026-10-14.md) | [简体中文](shared-recall-entry-diagnosis-2026-10-14.zh-CN.md) · [术语](shared-recall-entry-diagnosis-2026-10-14.terms.yaml)


## 范围与基线

用户批准先定位、仅修一个可复现断点。基线提交为
`bad23e60e25082b7f36379e10a822067fc7c8822`；Windows / Node 24.19.0。
本轮没有外部 embedding、live LLM、judge、全量 benchmark 或 daemon 换代，
也没有修改排序、检索预算、输出瘦身或状态维护规则。

2026-10-14T10:39:05.373Z 从现存 daemon 的 exact get 与显式 FTS5 搜索取得
10 条记录：5 条已知目标及 5 条异主题干扰记录。搜索设置 `persistTrace:false`；
没有提交反馈。随后只在隔离实例回放，不把生产 router 的持续变化当稳定基线。

五条目标均经当前 daemon 凭据 exact get 成功：`status=active`、
`scope.project=NodeMemoryGraph`、tier 为 0 或 1，`validFrom` 已生效，
`validUntil=null`、`expiresAt=null`。这证明本次读取与目标有效性，不是内容真实性、
全库完整性或其他访问身份的证明。

| 目标 | source memory ID |
| --- | --- |
| AG 模型可见内容瘦身偏好 | `4190957c-0228-4393-a4fb-3bdd6c0f4d68` |
| InformationView 实现事件 | `3972ae51-ecca-492d-aab0-cc24c6f38693` |
| 统一 state 实现事件 | `122d3a03-840c-43b1-a77e-8b9720f9de14` |
| 维护 Skill 安装事件 | `6e0e5d31-be9f-4f5a-a249-7949704bd4e8` |
| AG / board 布局约束 | `4a2aac84-3300-4957-b668-eb298f2f7e77` |

完整 A–D 提案仍以 Git 文件为 owner；第一项 gold 只是已保存的偏好，
不要求从它召回未存入 NMG 的完整计划。历史实现事件也不能独自证明当前部署状态。

## 固定回放条件与边界

- 语料 SHA-256：`9823a93da1dc2238f94a6c0cf17d5c2596c779b1c780d85dcb99c19db0cecc2b`。
- 八例问题集 SHA-256：`4ee001f0b40f753fa049118a1c8ac59caf4b8558a45ee6506afe9f42fb2636b3`。
- 两臂统一使用 `retrievalMode:fts5`、`maxTier:1`、`limit:12`、`graphHops:0`、
  `secondPass:false`、`tieredDisclosure:false`、`persistTrace:false`；不提供 embedding client。
- auto 从实际 `SessionTaskWindow.prepare()` 取得 gate 与 query；explicit 使用题面原文。
  只有接续案例预先输入一个任务锚点。query 不同的两臂不冒充同 query 排序对比。
- 使用 `searchMemoryContext()`、现有 active-graph selections、扩大至 50 的
  `store.search()`候选对照，以及 `searchInformationViews()` / `prepareInformationOutput()`。
  auto 用 context 外壳，explicit 用 flat 外壳，均为 16,000 UTF-16 code units；
  零预算对照例另设 0。外壳不同，不能直接把字符差归因于排序。

回放复制正文、node、type、scope、tier、importance、stateKey 和 eventTime。
夹具写入采用 `assistant/unverified`，不复制生产图、证据、访问计数、原始时效、
embedding 或线上学习状态；实例使用隔离默认状态，写入时间也不是原记录时间。
因此这是入口与小语料词法控制对照，不是完整生产数据库 snapshot、线上精确率或
normal hybrid 评测，也没有覆盖 provider 故障时的降级提示。共享 gate 的独立红测试
无需语料即可复现断点，避免把回放元数据简化当成根因。

## 问题—目标—丢失层—原因—修复

下表数字为目标 rank；“—”表示没有返回目标，不意味着记录不存在。

| 固定问题 | 目标 | auto 修前 → 修后 | explicit 修前 → 修后 | 定位与处理 |
| --- | --- | --- | --- | --- |
| 好像是不是要精简AG内容来着？还有其他几步其他的？ | AG 偏好 | — → 1 | 1 → 1 | gate 返回 none，搜索未发生；补“来着？”问句 |
| 之前AG显示瘦身的偏好是什么？ | AG 偏好 | 1 → 1 | 1 → 1 | 已识别的问法，未改 |
| 你还记得都做了什么、有哪些没做吗？我忘了 | InformationView | 1 → 1 | — → — | auto 带入上一题 nmg-context 锚点；孤立 explicit 缺任务词，候选为空。未作为排序 bug 修复 |
| 先前的统一state入口是不是AG和board都能用？ | 统一 state | 1 → 1 | 1 → 1 | 已修复的“先前”作为回归，未重复修复 |
| 你记得 working-state-maintenance Skill装在哪里吗？ | Skill 事件 | — → 1 | 1 → 1 | gate 返回 none，搜索未发生；补“你／您记得”疑问形式 |
| 之前AG和黑板的显示布局约定是什么？ | 布局约束 | 1 → 1 | 1 → 1 | 原行为不变 |
| 以前提过我最喜欢的火星餐厅吗？ | 应为空 | 空 → 空 | 空 → 空 | 无该已知记录，合理空结果 |
| 之前AG显示瘦身的偏好是什么？（显示预算 0） | AG 偏好 | rank 1，展示 0 → 不变 | rank 1，展示 0 → 不变 | 检索已命中；整项预算遗漏，不是检索断点 |

DAP 停在 `decideMemoryLoad()`，实际 query 为
`你记得 working-state-maintenance Skill装在哪里吗？`；显式和 optional patterns
均为 false。调用栈为 `SessionTaskWindow.prepare → decideMemoryLoad`，没有题面丢字。
独立核心测试的失败输出也为 `none/memory_not_needed`，预期为 `retrieve/explicit_recall`。

只在 [共享 gate](../../../src/core/gate.ts) 增加两条问句规则，没有 Pi 专属修补。
不笼统匹配“记得”或“来着”子串；保存文件／跑测试的提醒与“用来着色”仍为 none。
行为定义见 [渐进召回](../../design/design.md#11-progressive-retrieval)，
理由沿用 [召回意图决策](../../decisions/implemented/2026-10-10-recall-intent-and-diagnostics.md)。

## 匹配对照结果

- 核心回归先红（8/9），修复后绿（9/9）；覆盖五种回忆问句和四种负对照。
- 四个 SessionTaskWindow 合约测试通过，包括新问句原文、mode 与 reason 的转发。
- 两个入口漏项均变成 auto rank 1 并实际进入准备文本。
- 八个 explicit 结果，以及此前已触发的 auto，source-ID 排名、展示选择与字符量不变。
- 预选五条异主题干扰记录的展示次数在全部 16 臂合计为 16 → 18（重复展示也计次）。
  增量 2 来自新触发的 AG 问句：随目标附带两条 video-to-text 桌面记录；Skill 问句没有该增量。
  explicit 及原已触发的 auto 干扰展示不变。这是残留的词法候选混入，不能声称噪声下降，
  也不能从中断言完整生产排序的原因；本轮不擅自修第二层。其余相关 NMG 记录未被标为“无关”，
  不能按不在最小 gold 集就算噪声，也未测一般精确率。
- 两个新触发的 auto 文本分别新增 2,088 / 551 UTF-16 code units。
  这是找回材料的输入增量，不是瘦身或成本收益；没有 billing/cache/延迟结论。

## 证据与复现

诊断收据位于共享 checkout 的 `.nmg/verification/shared-recall-diagnosis/`：
`corpus.json`、`cases.json`、`eligibility.json`、`baseline.json`、`red.json`、
`after.json`、`comparison.json` 及临时 `collect.ts` / `probe.ts` / `compare.ts`。
这些脚本是诊断产物，不是新增平台或产品运行入口。

永久、可独立重跑的最小回归：

```sh
node --experimental-strip-types --test tests/core/gate.test.ts
node --experimental-strip-types --test --test-name-pattern="session task window" tests/extensions/nmg/index.test.ts
```

收口于这一共享 gate 断点。全量语料上的漏项、其他未识别问法、normal hybrid、
自然模型表现、最终 provider-send 及收益均未由本轮证明。
