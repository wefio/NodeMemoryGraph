# 检索相关度门限:两个松门限 AND 成一个严门限

[English](2026-09-09-retrieval-relevance-gate.md)

**Status:** implemented
**Approved:** unrecorded

## Problem

披露路径在注入召回记忆时**没有任何绝对相关度门限**。候选只需
`combinedScore > 0`(`src/core/store/retrieval.ts`),而
`selectWithinActiveGraphBudget`(`src/core/store/active-graph.ts`)按名次从上往下
取 top N,直到满足 evidence target / 预算为止,**从不拿分数和某个下限比较**。QPP
(`src/core/qpp.ts`)只决定"要不要再加深一轮",不决定"什么进上下文"。

在 19 条真实召回(auto + explicit,经 recall-instance 语料标注)上实测:precision
0.211——on_target 0、partial 4、noise 15。**宿主自动召回最糟:15 条里 13 条 noise。**

相关度分数**分不开两类**,所以单靠分数的门限修不了:

- 候选 top1——noise 0.54–0.87,partial 0.51–9.0(完全重叠);
- 单条召回内候选分数几乎相同(如 `[0.77, 0.77, 0.77, 0.76]`)——**recall 内无区分度**;
- `combinedScore` **路径不一致**(`fts5` 退化路径是原始 BM25,向量路径是有界 hybrid
  分)——这正是 `qpp.ts` 已注明、并因此让 QPP 改用有界 `hybridScore` 的同一性质。

这些是一阶段分数**未校准**的教科书式特征(各向异性、hubness、跨查询不可比)。该问题的
文献与标准缓解手法——**先重排再阈值化**、**逐查询归一化**、**选择性分类 / 保形拒答**——
记在 `docs/experiments/retrieval-quality/relevance-gate-calibration-2026-09-09.md`。

## Decision

**两个松门限,AND 起来**。每个门限都刻意松——只剔除它擅长剔除的东西——候选**同时过两道**
才进上下文。一个松门限仍然会拒掉一部分噪声;于是噪声必须**同时躲过两次独立拒绝**,而真正
相关的候选(每个松门限都会接受)两道都过。合成门限因此是严的,却不需要任何单独一道变紧
——这点很关键,因为**一个紧的单门限(或一个激进的评估器)正是误杀有用上下文的失败模式**。

**程序门限(确定性、便宜;擅长结构 / 分数 / 精确性):**

- 跑在**确定性信号**上——词法匹配、embedding 相似度、结构/分数特征——比较前归一化成
  **一个**有界、路径一致的分数。
- k 视为**上限而非目标**:返回更少、甚至 0 条。
- 只剔除**明显坏**的结果(松门限),保留现有 strong-hit / 落差早停;无候选过松门限时 abstain。

**模型门限(NMG 自己的神经网络;擅长反馈塑形的相关性):**

- NMG 自己的神经网络——可微控制器(`src/lab/differentiable-controller.ts`,基于
  `autodiff.ts`),从召回反馈与 recall-instance 标签训练——以**松的**标准逐条判定候选
  “大致相关/不相关”。它**不是** LLM judge,也**不是** embedding 模型;embedding 与词法
  相似度属于上面的程序门限。

**合成:**

- 注入两道的**交集**;交集为空则 **abstain(什么都不注入)**。
- 每个门限在它擅长的地方工作并保持松,所以任何一道都不单独过度过滤;**严完全在 AND 里**。
- 学到的门限只对已过程序门限的候选运行,使每次召回的成本有界。尽力而为:出错时召回降级为
  仅程序门限,**永不阻塞**;无可用训练模型时路径完全确定性。

**不对称**:自动(未经请求)的注入可以抬高任一门的松度标准,因为注入的噪声是每一个回合
都在消耗消费方模型,而不只是它开口问的那一次。

### Model-gate enablement bar

- 在已标注语料上,auto 注入 precision 明显提升且**不丢 on_target**(噪声带不再进上下文)
  ——且提升必须来自 **AND**,不是靠把某一道拧紧。
- 任何一道都**不单独过度过滤**:各自保持松,相关候选仍能两道都过。
- **abstain 可表达**:交集为空时不注入任何东西。
- 未配置/无可用训练模型时,召回路径**完全确定性**,仅由程序门限把关。
- **召回永不被阻塞**:学到的门限失败降级为程序门限。

## Alternatives considered

- **只用程序侧分数门限。** 拒绝:两类重叠、recall 内分数无信号(见 Problem),任何
  门限不是留噪声就是误杀 partial。分数也无法充当那道严门限——正因如此,严落在了两个松门限
  的 AND 上。
- **松程序门限 + 严模型门限。** 让位于“两个都松”:一个**严的单门限(或严评估器)正是
  误杀有用上下文的已知失败模式**;两个松门限 AND,既对噪声严,又让每一道都便宜、宽容。
- **LLM 相关度 critic(Self-RAG `IsRel` / CRAG evaluator)。** 考虑过但不采用:模型门限是
  NMG 自己从反馈学到的神经网络,不是被提示的 LLM。Self-RAG / CRAG 文献仍然支撑“松 + AND”
  这个形状,但实现是**学到的分类器**,推理期确定性,且随反馈循环改进。
- **每次召回都上模型门限。** 拒绝:每回合延迟与成本,且丢掉检索设计赖以成立的
  确定性单次搜索路径。
- **维持现状(只按名次注入)。** 拒绝:实测 precision 0.211;库里由同质项目状态记忆主导,
  必然持续产生噪声。

## Consequences

程序门限上线后,召回的默认行为变了:一次召回**按构造**就可能返回更少——甚至零——结果。
以下都是要盯的后果,不是阻塞项。

- **门限相关。** 如果两道都基于同一信号(例如学到的门限只是重读程序门限用过的 embedding
  分),AND 毫无增益。两道必须保持**正交**——确定性的词法/embedding/结构信号 vs 反馈学到的
  模型。
- 门限标定需要数据量;19 条标签只能给一个保守初值,必须随标签累积滚动。
- **学到的门限需要训练数据。** 在 recall-instance 标签足够多之前它欠训练;一个松却欠训练的
  模型仍可能误杀有用上下文。**松**是缓解,不是保证。
- 学到的门限在每次“候选过程序门限”的召回上都有推理成本。
- 库的同质性是被门限**压制**而非**解决**的数据问题。

## Implementation status

**程序门限 —— 默认开,无 env 开关。** `src/core/relevance-gate.ts` +
`src/core/store/retrieval.ts`;代码常量 `DEFAULT_RELEVANCE_FLOOR = 0.05`(词法路径上
≈ BM25 0.53 —— 这才是真的松;0.4 意味着 BM25 ≈ 6.7,测试一跑就看出那是硬过滤)、
`DEFAULT_RELEVANCE_MAX_CV = 0.002`(平坦即弃,且仅在候选数 ≥ `MIN_CV_COUNT = 4` 时
生效:低于这个量散布估不出来,而该规则是在 k≈20 的完整列表上校准的)。它是确定性的,且只会**删除**候选、不会新增,
所以不可能引入新错误;LoCoMo 回归(`tools/relevance-gate-calibration.ts`)显示平坦
列表规则保留 **81%(217/268)** 命中题,同时把 kept precision 从 5.9% 抬到 13.1%、
候选只留下 36.8%。**需要被
打开的闸门就是永远不会跑的闸门**——这就是没有 `NMG_RELEVANCE_GATE` 的原因。

**模型门限 —— 靠"生产出一个模型"来 opt-in。** `src/core/relevance-features.ts` +
`src/core/learned-gate.ts` + `src/lab/relevance-model.ts`,由
`tools/relevance-model-train.ts` 训练;把经校准的模型放到
`<dataDir>/relevance-model.json` 即启用(无 env),在程序门限之后 AND。
LoCoMo 留出集:AUC ≈0.89、ECE ≤0.012(Platt 校准)。**不默认开**的原因:AND 会被
模型那一半卡住召回(有 gold 的题上 `program 0.729 / learned 0.271 / AND 0.271 /
OR 0.729`),而且现有模型是 LoCoMo 专用(线上即 OOD)。

**验收线是一个流程,不是一个数字。** `tools/relevance-model-train.ts --certify`
把(集合级切点, 模型阈值)当作一个格点格,逐点对目标风险 α 做有限样本检验
(对整个格点做 Bonferroni),再在留出集上报所选阈值对。**只有当某个阈值对通过认证、
且测试集上站得住,才启用它。** 在当前数据上(LoCoMo,校准集 307 题)**α ≤ 0.60 没有任何
阈值对能通过认证**;α = 0.6–0.7 通过的那两个在测试集上风险 41–53%,反而比现在默认开的
程序门限更差。原因是**池子**而不是阈值:只有 15.6% 的题在池子里有 gold,所以 10% 接受率下
可达到的风险就是 ~34%。实测见
`docs/experiments/retrieval-quality/gate-certification-2026-09-09.md`,设计依据见
`docs/experiments/retrieval-quality/gate-cascade-literature-2026-09-09.md`(风险界限下的
双阈值联合标定,BalanceRAG)。

**特征分块,以及为什么绝对分那一块是可选。** 候选特征向量分成 `core`(文本重合、排名/相对位置、QPP、记录元数据)与 `retrieval`(三个**绝对**检索分:`raw_log`、`bounded`、`vector`)。只有 `retrieval` 是尺度绑定的:绝对分尺度**跨 embedder 不可比**,拿在一个尺度上训好的头去喂另一个尺度会**静默失效**(数字看着正常,阈值却不再区分任何东西)。所以头要声明自己读哪些列、属于哪些块、以及分数来自哪个 embedder 身份(`EmbeddingClient.indexId`);加载时身份不匹配就**拒载**,而只读 `core` 的头物理上读不到尺度绑定块,任何地方都能加载。训练尺度绑定块必须显式点名 embedder(`--embeddings --embedder <indexId>`),所以不匹配的头也不会被误造出来。

在当前(词法)库上实测:α = 0.60 时 `core`-only 头认证出**更好**的项级点(校准风险 29.7% vs `core+retrieval` 的 36.7%,同流程),所以把这一块设成可选不只是更安全,也是当前更好的默认。两者在留出集上仍然都会掉。

**模型侧方法已测(召回没有实质提升)。** 交互特征(jaccard / IDF 加权覆盖 / 字符覆盖)、
focal 损失、难负例挖掘 + pairwise RankNet、Platt 校准全试过:AUC 五个变体停在
0.886–0.896,只有校准有变化(ECE ≤0.012)。详见实验记录。

**embedding 路径:可选,词法是一等路径。** embedding 是加分项而不是依赖:core 块永远可用,core-only 头完全不需要 embedder,尺度绑定块只在点名 embedder 时才纳入。部署用 Gemini(有限流),本地 `bge` venv 可以离线灌持久化 embedding 索引,所以线上只需要给 query 打一次。既有对照
(`docs/experiments/retrieval-quality/hybrid-2026-08-16.md`,LoCoMo 全 10 用户)是
lexical any@20 34.3% → hybrid 40.5%(R@20 24.1% → 29.3%)——在 LoCoMo 上真实但有限,
只有 LongMemEval 某些题型增益大(preference 56.7% → 86.7%)。

**更正。** 实验记录里曾把 17.5% 称作池召回上限;那是自建 harness(直接开 store、更严的
gold 匹配)的结果,不是产品路径,且**低估**了它。产品路径的数字是上面的 34.3% / 40.5%。

**Deferred:** 模型门限的验收跑、标注量、第二个 benchmark。
