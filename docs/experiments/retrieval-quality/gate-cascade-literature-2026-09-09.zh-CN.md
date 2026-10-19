# 文献扫描：两个闸门可以级联吗，闸门何时"可以安全打开"？

[English](gate-cascade-literature-2026-09-09.md) | [简体中文](gate-cascade-literature-2026-09-09.zh-CN.md) · [术语](gate-cascade-literature-2026-09-09.terms.yaml)

**Date:** 2026-09-09
**Status:** 外部文献综述（网络检索）；不是正式综述。
**Purpose:** 检验在实现检索相关性闸门时提出的三个前提（`docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md`）：(a) 把两个闸门**级联**是否比把它们 AND 起来增加能力；(b) 一个逐查询／集合级的"这次召回大多是噪声"信号能否被学习；(c) 是否存在一种表述，使得**启用**学习型闸门被保证无害。
**Scope:** 级联排序、查询性能预测、选择性预测与风险控制、自适应检索门控。以英文文献为主。

## 要点

所选扫描及其 2026-09-12 跟进属于历史，不是穷尽综述或新来源核验。下述外部声称是原
记录对所选作者的记述，不是普适文献结果。[当前训练协议](../../design/relevance-training.zh-CN.md)
拥有标签准入及部署边界，本文不启用任何能力。

1. 同一冻结池上的固定逐项谓词满足 B(A(S)) = A(S) ∩ B(S)。仅“纯过滤器”不足以
   保证：集合相对归一化、top-K、自适应阈值及共享预算可使顺序改变成员；在假设成立时，
   分阶段仍能改变成本。
2. QPP 是相关信号族，cv 与 NQC 是相关离散度量，不自动是相同公式／归一化。学习型
   QPP 需要标签，推理时可不看 gold；经典基线不等于零 CPU 成本。
3. 有条件风险控制不是“打开总有益”；BalanceRAG 是联合标定的一个所选动机，不是
   唯一方法、无条件保证或上线权限。

## 前提 (a)：级联 vs AND

- 级联是按成本递增排列的一串过滤器+排序器阶段：第 1 阶段偏召回，最后阶段偏精确。经典机制是**按排名比例的截断，在每一阶段移除固定比例的输入**（Wang, Lin & Metzler, SIGIR 2011）——级联是按_比例_剪枝，而不是按分数阈值。
- **级联的联合（端到端）训练优于逐阶段/贪心训练**，而对级联真正重要的目标是**级联召回**（Gallagher 等；_Learning Cascade Ranking as One Network_, ICML 2025 使用召回感知的替代损失）。特征成本应计入级联内部（Chen 等, SIGIR 2017）。
- 历史 `applyRelevanceGates` 记述为程序 → 学习型；AND 等价需要固定谓词，不只是纯函数。扩展、改写、更大 k、阈值串联或集合依赖过滤都可改变结果，不证明任意实现顺序无关。
- 纯移除阶段排序的一个性质是：**较早阶段的错误不可恢复**——较晚阶段永远看不到较早阶段丢掉的东西。所报 51 个程序误丢中的 2 个属于单独模型的反事实比较，不是实际找回先前已移除候选，也是为什么删除权限应放在单一的最后阶段。
- 同样标准的是：**每一个 top-K 截断都会造成召回天花板**（候选生成指引），而重排实践说明明确指出：只重排保留完整池成员，不必保留 R@K 或预算截断前缀；重排可改变消费者截断处的召回。
- 所引覆盖值使用不同 k、领域及单位，不是彼此的定量佐证：在一项 LLM 重排研究中，现实检索在三个领域上于 K=100 只覆盖相关项的 **2–19%**；我们产品路径的词法 any@20 是 34.3%（混合 40.5%）。

## 前提 (b)："这次召回大多是噪声吗？"——QPP 与集合级闸门

- **经典无监督检索后 QPP** 从检索列表分数分布估计质量，不需要相关性标签。经典预测器包括 **NQC**（top 分数离散度，与 `cv` 相关但不必相同）、score-gap 与 top-score/clarity 类统计量。基础见 ECIR 2024 QPP 教程、QPP++ 2025 研讨会。
- 标准的下游用途正是我们识别出的两个：**自适应截断**（保留多少）与**"重检索／改写"**。近期工作把检索后 QPP 用在 agentic RAG 中，发现对生成查询的 QPP 估计与最终答案质量正相关（Tian 等, 2025）——也就是一个_集合级_信号而非逐候选信号，且它用于决定一个_过程_动作。
- 互补的"到底该不该检索"闸门是另一个家族——**Self-RAG**、**Adaptive-RAG**、**SKR**、免训练的 **TARG**——每个成员都在**查询**级决策，而"这次召回大多是噪声吗"真正所在的层级正是查询级。
- ⇒ 对我们的集合级问题，正确的形状是**用 QPP 式预测器驱动截断**，而不是第二个候选过滤器。关键是：任何学习版本都必须与经典预测器（NQC/`cv`、score-gap）比较，它们不额外调用模型 API，但不是零计算成本或保证胜者。

## 前提 (c)：是否存在"打开它就好"的表述？

- **没有。** 在选择性预测（Chow 1970）与 learning-to-defer（Mozannar & Sontag 2023；Narasimhan 等 2022）中，保证是**在选定 α 下的风险**，而不是"总是更好"；而且在固定预算下，任何改变集合的决定都可能丢掉 gold。实践文献画出与我们相同的界线：**重排器**保留完整池成员，不必保留 top-K／预算截断后的召回；**过滤器**则能在该截断前移除成员。
- 文献确实提供了、我们也应照搬的是：
  - **带有限样本保证的风险控制**（Angelopoulos 等；conformal prediction）。与我们目标匹配的变体是**带受限假阳性的 conformal 集合**（Fisch 等, ICML 2022）——控制所定义的假阳性损失；与 FPR、FDR 或聚合保留噪声等同前须核对其准确分母。
  - **Conformal 事后过滤**：CiteGuard 对引用忠实度控制假发现率。这恰恰是"过滤，但带承诺的噪声水平"。
  - **级联风险控制——与我们两个闸门最接近的已发表形状。** **BalanceRAG: Joint Risk Calibration for Cascaded Retrieval-Augmented Generation**（2026）以一个**两阈值**双分支级联（仅 LLM → RAG → 弃答）为准，两个阈值**联合而非逐阶段**标定：每个阈值对是二维格点上的一个工作点，每个都对"系统风险 > α"的原假设做检验，通过认证的阈值对获得 **FWER 控制在水平 δ**（因此在所检验候选族及论文假设内后续选择有效），而上线的阈值对是**接受率最高的已认证者**。它可推广到**多风险**（同时约束检索使用量与以选择为条件的错误）。其明确发现是：**逐阶段标定有效但保守**——联合标定在同一风险下保留更多被接受的样本。
  - 便宜→昂贵的**路由**并用 Hoeffding 上置信上线规则（UR-RAG，片段级来源）——同族。

## 这对 NMG 意味着什么（历史提案，不改默认）

1. 固定谓词下仅分阶段不增加过滤能力；扩展、联合标定及更好信号是所提杠杆，不是穷尽清单。
2. 单一最终移除点指启发式候选抑制，不是擦除持久记忆。权限／隐私／当前有效性过滤
   仍强制执行，不能被分数融合或学习特征替代。
3. 对有效候选族、有效抽样假设及指定 alpha／delta 比较。最大接受率认证点仍须部署
   批准；无点通过支持暂缓提案，不证明所有闸门都无效。FPR、期望 FDR、聚合保留噪声
   的损失／分母不同，保证不能互换。
4. 动机数字仍为精确率 5.9% → 13.1%、命中召回 81%；保留噪声 ≤25% 是拟定目标，
   不是验证的运行时保证。
5. 绝对下限 0.05 被怀疑尺度耦合；排名／比例截断、z-score／NQC 及分数分布模型是
   替代提案，不是已证实安全替换，原始离散度本身也不自动尺度不变。
6. 固定池移除找不回池外证据。K=100 的 2–19% 与词法／混合 any@20 的 34.3%／40.5%
   是不同测量。

## 本扫描未解决的开放问题

- 在同等命中召回下，**学习型**集合级 QPP 预测器是否优于经典者（NQC/`cv`、score-gap）。在缓存的 LoCoMo 组上测试很便宜；文献提示经典预测器是强基线。**已于 2026-09-09 回答：** 在 LoCoMo 上，产品的 QPP 分数与原始尺度 `cv` 产生_相同_的等接受率前沿，且在认证之下没有任何点能以 α ≤ 0.5 通过——见 `docs/experiments/retrieval-quality/gate-certification-2026-09-09.md`。
- 我们的标注量能否在有用的 α 处**认证**任何模型阈值（缓存 LoCoMo 池中约 270 个 gold 候选——除非常宽松的 α 之外大概太薄）。**已回答：** 低于 α = 0.60 没有任何东西通过认证，而在 0.6/0.7 通过认证的两个阈值对无法在检验切分上保持。
- 第二个_增加_阶段（查询改写／先扩后收）能否在实时语料上赚回其延迟。

## 选定来源

- Wang, Lin, Metzler, _A cascade ranking model for efficient ranked retrieval_, SIGIR 2011——按排名比例的截断；偏召回的第 1 阶段。
- Gallagher 等, _Joint Optimization of Cascade Ranking Models_, WSDM 2019；Wang 等, _Learning Cascade Ranking as One Network_, ICML 2025——召回感知的替代损失。
- Chen 等, _Efficient Cost-Aware Cascade Ranking in Multi-Stage Retrieval_, SIGIR 2017——级联内部的特征成本。
- Google ML, _Candidate Generation in Search_——"每一个 top-K 截断都会造成召回天花板"。
- _Why LLM Recommendation Reranking Fails in Practice_——在 K=100 时检索只覆盖相关项的 2–19%。
- Tian 等, _Am I on the Right Track? What Can Predicted Query Performance Tell Us about the Search Behaviour of Agentic RAG_, 2025（arXiv 2507.10411）——QPP 与答案质量。
- QPP 基础：ECIR 2024 教程（Arabzadeh 等）；QPP++ 2025 研讨会；RAG-QPP（2025）。
- Asai 等, _Self-RAG_, ICLR 2024；_Adaptive-RAG_, NAACL 2024；TARG, _Retrieval as a Decision_（OpenReview，免训练门控）。
- Chow 1970；Mozannar & Sontag, _Who Should Predict?_, AISTATS 2023；Narasimhan 等, _Post-hoc estimators for learning to defer_, NeurIPS 2022。
- Fisch 等, _Conformal Prediction Sets with Limited False Positives_, ICML 2022。
- _Controlling Risk of RAG_（RC-RAG, arXiv 2409.16146）——弃权指标 risk/carefulness/alignment/coverage。
- _C-RAG: Certified Generation Risks for RAG_；_CiteGuard: Conformal False-Discovery Control_；_AdaCP_（Findings-EMNLP 2024）。
- **BalanceRAG: Joint Risk Calibration for Cascaded Retrieval-Augmented Generation**（arXiv 2605.20084）——两阈值级联、在格点上联合标定、FWER 控制、接受率最高的已认证对、多风险。
- UR-RAG, _Unified Risk Calibration for RAG_——在便宜→昂贵级联上使用 Hoeffding 上置信上线规则（片段级来源）。
- 分数分布/归一化：Arampatzis 等, _Modeling score distributions in IR_（2011）；Manmatha 等, _A formal approach to score normalization for meta-search_。

## 后续扫描（2026-09-12）：三项测量发现，对照文献复核

这里从 LoCoMo 转到 NFCorpus，不是同一数据集的另一臂。后续标签审计发现未判定候选
曾被假定为负例；这些是历史代理输出，不是核验噪声标签或当前准入训练。AUC 0.89 →
0.72 跨数据集／标签／设置变化，不单独识别修正标签的因果效果，文献类比也不识别原因。

在首个带 qrels 标签的训练集上测量（NFCorpus，3633 个文档 / 323 条判定查询 -> 298 组）：学习型头的 gold 题覆盖为 **0.68**，确定性词法闸门为 **0.36**；**两者的 AND 是 0.12**——比任何一个都差——而并集是 0.92。把"候选包含 gold 答案字符串"的标签换成真实的逐文档相关性判定后，检验 AUC 从 **0.89 降到 0.72**。

### 1. 把硬性确定性规则与更好的学习型排序器取交集，正是融合文献存在以避免的失败模式

- **Bruch, Gai & Ingber, _An Analysis of Fusion Functions for Hybrid Retrieval_（TOIS 2023, arXiv 2210.11934）。** 词法与语义信号被组合，该文的发现是：**学习得到的凸组合（分数融合）在域内与域外都优于 Reciprocal Rank Fusion**，RRF 对参数敏感，而且——这里最重要的一点——凸组合是**样本高效的："只需一小批训练样本即可调好它唯一的参数"**。因此文献对"如何组合两个信号"的回答是_融合分数_，而融合权重很便宜就能学到。
- **交集不是一种融合函数。** 排名融合综述把后融合（分数平均、RRF）与早/中融合当作术语表；硬约束是另一回事，其代价记录在过滤式 ANN 文献中：_"预过滤把搜索限制在匹配过滤条件的点上……结果：因过度搜索导致召回更低或延迟更高"_，而元数据过滤被描述为_"没有人测量的召回胜利"_。
- **我们的情形比他们的更糟。** 他们的过滤器是一个精确的元数据谓词（租户、日期、权限），其政策条件无论相关性如何都必须满足，不假设统计独立。我们的则是**带噪声的分数阈值**，因此它既移除真阳性，又只与目标弱相关。`AND = 0.12` 是该总体的所报代理工作点，不是普适最坏形状或实测生产损害率。

### 2. 学习型预测器击败无监督分数分布规则，有文献记录的原因

- **DuoQPP / _Unsupervised QPP for Neural Models_（SIGIR 2023）：** 无监督 QPP 方法预期_"对神经排序模型效果有限，因为这些模型的检索分数落在很窄的范围内"_——正是迫使我们把离散度特征搬到原始尺度的分数范围压缩。监督/自适应 QPP（例如用于稠密检索器的 ADG-QPP）在 Kendall τ 与 Spearman ρ 上优于这些基线。
- 对我们的推论：一旦标签是真实的，"学习的那一半覆盖 0.68 而 cv 规则覆盖 0.36"是预期方向，而这些比较尚未单独识别共同因果解释。另请注意，QPP 用**相关性**（Kendall τ / Spearman ρ）评估，而不是 AUC——一个我们尚未采用的指标变更。

### 3. 样本是否充足取决于所声称的界

- eDiscovery / TAR 验证正是把这一测量操作化的领域，其公开标准很直接：一个召回估计只有其样本那么可辩护，而_"一个置信区间宽到证明不了任何东西的召回点估计——'召回 80%，正负 22 个点'——不是可辩护的结果"_。这里明确**没有一刀切的样本量**：样本必须为所主张的区间提供依据。
- 应用到我们自己的输出：qrels 运行的切分是 **cal 60 / test 60 题**。“HOLDS at α = 0.70”是所报工具结局，不足以在此建立总体主张；n=60 本身不禁止所有有效认证，307/307 也不是通用最低量，bge 工作点还可能只有 n ≈ 8。须一起审查抽样、标签与实际统计界。

### 这意味着什么（组成假说，不授予默认权限）

1. 凸融合是待比较方案，不因只有一个权重就证明风险更低或认证更便宜。独立 test 前
   须冻结选择，调参数据不是未触碰 test。
2. 启发式分数成为特征不保证永不劣于学习型头；权限／有效性硬约束仍为硬约束。
3. 报告 n = 60 及标签／不确定性限制，不是新认证。早先低于 alpha 0.60 无点的回答
   针对题级运行；条目标定通过语义不同且复查未保持，见认证记录。
