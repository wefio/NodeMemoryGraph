# 召回实例:一个自包含、来源无关的检索 benchmark

**Status:** implemented
Date: 2026-09-07
Branch: pr/recall-instance-benchmark

受 self-governance 元规则与 hidden-features 规则治理
(`docs/decisions/implemented/2026-09-07-register-hidden-features.md`):本改动新增一个
默认开启的 env-gated 特性(`NMG_RECALL_INSTANCES`),故在同一改动内注册进 hidden-features 注册表。

English: [2026-09-07-recall-instance-benchmark.md](2026-09-07-recall-instance-benchmark.md)

## 问题

在线反馈闭环一直饿死:feedback 只在"召回被取用"时合法,而"取用→作答有用"是回合级的——
相对代码活稀有,且脆弱(我常忘评)。根因是问错了监督单元:**"这条召回对下游回答有没有用"**是
稀疏、依赖回答的;而检索**质量**不是。

## 决策

把**每一条 disclosure 召回**当作一个**自包含实例**:

```
实例 = { trigger(触发召回的内容),
         检索到的候选(含文本),
         activeGraphId }
```

检索对 trigger 的相关性**独立判定**——(trigger, 检索)配对不需要下游回答,故完整、独立;
代码多的会话无法饿死它(密度 = 召回事件数,不是回答回合数)。这是**检索层**监督信号:正是
online router 优化的那一层,也不做任何因果 claim("这条帮了我的回答")。

- **每条 disclosure 召回都是实例**——auto 预注入与显式搜索一视同仁,二者都有 trigger。
  内部探测(`persistTrace:false`)没暴露内容,排除,与在线 staging 的处理一致。
- daemon 在 disclosure 唯一咽喉点(`#search`)把无标签实例追加到
  `<dataDir>/recall-instances.jsonl`,来源无关。
- **capture 不可变;标签在独立追加式 ledger**(`recall-instance-labels.jsonl`),
  没有生产方会重写语料。相关性由两个生产方标注:
  - **remember 还债(常开)**:写路径 supersede 一条记忆时,任何候选含那条记忆的
    未判实例被就地标 `on_target`——store 可验证、可归因的证据,是真正不依赖会话
    或 judge 运行的数据源。
  - **离线 judge**(`tools/recall-instance-judge.ts`,按需):取
    `on_target | partial | noise | misleading | gap`。`gap` 描述缺失情形——该召回的
    记忆没被召回——这是检索层也必须核算的充分性失败。
- 语料即 benchmark 基底:被还债/judge 的实例累积成回归/分析集并提供真实检索级标签。

## 后果

- 监督密度不再取决于回答回合;每条 disclosure 召回贡献一个实例。
- 标签停在检索层(不做端到端过度 claim)。召回切题但作答可能执行失败,反之亦然;此
  benchmark 只测路由调的那一层。
- `gap` 轴让"该召回却没召回"与"召回错了"并列可见,故召回充分性可测,不只测 precision。
- 捕获有界(top-N 候选、截断文本)且 best-effort(永不打断召回)。默认开但与在线学习独立;
  `NMG_RECALL_INSTANCES=0` 关。
- 这些标签喂检索质量基准与 online router 的真实目标(该不该暴露这条召回)。它们是检索层监督,
  与显式 `recordFeedback`(只训它点名的那个图)分开,绝不当作用户效用 claim。

## 数据生产(标签何时真出现)

被动捕获日志本身不产标签。两个生产方让标签在**不依赖有机记忆回合或有人想起跑 judge** 时出现:

1. **remember 还债** —— 每次 supersession 触发;store 可验证;常开的生产者。
2. **离线 judge** —— 按需对捕获日志跑。

**后续(不在本改动):** 对记忆快照跑受控检索探针(`collectionOrigin=controlled`,复用既有
rank-aware 检索评测),按需产出 gold 标签实例并喂同一 router 目标——实时数据稀薄时的确定性生产者。

## 考虑过的替代方案

- **仍只在内联问回合级有用性。** 拒绝:那是稀疏、依赖回答、饿死闭环的信号。
- **从下游行为推断"有用"。** 拒绝作为独立标签:重蹈先前移除的因果越权(mis-attribution)。
  行为推断只作独立弱兜底,不作语料标签。

## 证据

- `tests/lab/recall-instance.test.ts` —— 追加/读取往返、坏行容忍、候选有界、标签聚合
  (precision + gapRate)、标签解析。
- `NMG_RECALL_INSTANCES` 的 hidden-features 注册表行。
