# 文献梳理：Google 搜索／推荐如何用弱行为信号推断"有用"

[English](google-feedback-signals-literature-2026-10-10.md) | [简体中文](google-feedback-signals-literature-2026-10-10.zh-CN.md) · [术语](google-feedback-signals-literature-2026-10-10.terms.yaml)


**日期：** 2026-10-10
**状态：** 外部文献综述（原文阅读）；**不是**已批准设计，也不代表 Google 当前生产实现。
**目的：** 回答用户提出的问题——在没有逐条显式评分时，搜索／推荐系统凭什么判断一次展示"有用"，
以及这些做法哪些可迁移到 NMG 的主动／自动召回，哪些不能。
**范围：** Google Research／Search／YouTube 原文优先；通用去偏文献标注为"外部通用"。
每条只记录**读过原文**的部分，未读全文的只写到摘要能支撑的程度。

## 结论摘要（先说不能做什么）

1. **"没被选择"不是负标签。** Google 的 good abandonment 研究明确指出，把查询放弃统一当负信号是错的。
   NMG 的"注入后未被读取"同理不能直接当负例。
2. **"被点击"也不是正标签。** ULTR 系列论文说明点击混杂了位置／曝光偏差；KDD'23 更进一步：提升点击的
   模型可能同时**减少有点击的用户数**（clickbait／偏置放大）。
3. 大规模日志、多策略重叠曝光、A/B 平台是若干方法的前提；NMG 是否具备足够数据需逐项核实。
   SIGIR'16 与 WSDM'18 提醒个人搜索反馈稀疏，不能假定大流量方法在小库有效。
4. YouTube'16 的曝光频率特征可启发重复展示研究，但不是唯一可迁移机制或 NMG 的已验证收益。
   未读取不自动变成负例；需区分真实展示、已在上下文、摘要已够用与预算停止。
5. **长期效用与短期效用会背离**（KDD'15、RecSys'24），但度量长期效用需要 A/B 或约束优化基础设施，
   NMG 目前没有，**不能声称已经能度量"长期有用"**。
6. **可搬的是形态、不是机制；映射与提案见 §九。**

---

## 一、无显式评价时，如何估计"这次展示满足需求"

### 1. Good Abandonment in Mobile and PC Internet Search（SIGIR 2009，Google）
- 来源：`https://research.google/pubs/good-abandonment-in-mobile-and-pc-internet-search/`（已读摘要全文）
- 定义：**good abandonment**＝用户放弃查询，但信息需求**已被结果页本身满足**，无需点击或改写。
- 发现：① 疑似 good abandonment 的查询占全部放弃查询的**显著比例**；② mobile 明显高于 PC；
  ③ 按需求类型分类，主要类别随 locale／modality **差异很大**。
- 原文结论句：*"it is a mistake to uniformly consider query abandonment as a negative signal"*，
  且可通过改进 snippets／features **主动增加** good abandonment。
- **NMG 可借鉴：** 召回头部（摘要级）本身可能已满足需求；"未 `nmg_get`"应视为**未知**，不是差评。
- **不可借鉴：** 论文只给流行度和分类，没有给出"如何逐条判定 good abandonment"的可用判据。

### 2. Incorporating Clicks, Attention and Satisfaction（CAS 模型，CIKM 2016，Google Research Europe + UvA）
- 来源：`https://arxiv.org/html/1609.00552v1`（已读正文，含 Section 3–7）
- 模型：把**点击、注意力（鼠标注视→examination）、满意度**联合建模。满意度
  `P(S=1) = σ(τ0 + Σ_k P(E_k=1)·u_d(D_k) + Σ_k P(C_k=1)·u_r(R_k))`。
- 关键区分：**D_k＝SERP 条目本身是否回答了问题**（摘要级效用）；**R_k＝点击后全文是否回答了问题**（文档级效用）。
  人工标注下二者 Pearson 相关仅 **0.085**、Spearman **0.094**——即**摘要级有用 ≠ 文档级有用**。
- 评价指标：`U = Σ_k ε(φ_k)·(u_d(D_k) + α(R_k)·u_r(R_k))`，可适配非线性布局，且比传统指标更贴合**用户自报满意度**。
- 数据规模（重要限制）：**12 名参与者 / 2334 个会话 / 仅 243 个带满意度反馈**；问卷只在 **50% 会话**弹出、
  每人每天 ≤10 次，并提供 1 小时／24 小时静音按钮。
- 作者自承局限：数据量远小于常规 click-model 数据集，用户多为 CS 背景，query 分布有偏。
- **NMG 可借鉴：** ① 把"头部信息足够"与"必须读正文"分成两种效用，与 NMG 的 `header`／`exact` 两档天然对应；
  ② 满意度可用**低频、可静音、随机会话**的方式采样，不必每轮问。
- **迁移限制：** NMG 没有该实验的鼠标注视观测；243 条满意度的可训练性取决于模型、目标及数据分布，
  论文不能给出 NMG 的通用样本下限，用户问卷也不是本轮实施项。

---

## 二、点击／读取信号的偏差与去偏

### 3. Learning to Rank with Selection Bias in Personal Search（SIGIR 2016，Google）
- 来源：`https://research.google/pubs/learning-to-rank-with-selection-bias-in-personal-search/`（摘要）
- 问题：传统 click model 需要**每个 query-document 对**的大量点击；个人搜索因语料与需求个性化，
  点击**高度稀疏**，无法直接套用。
- 方案：提出 **selection bias** 问题并用 learning-to-rank 框架处理；含一种**query-dependent** 偏差估计，
  能借"结果相似的查询"缓解稀疏；在"世界最大个人搜索引擎之一"的在线实验中显著提升效果。
- **NMG 可借鉴：** 稀疏点击要靠**跨相似查询／跨条目聚合**，不能要求单条记忆有足够反馈。

### 4. Position Bias Estimation for Unbiased Learning to Rank in Personal Search（WSDM 2018，Google）
- 来源：`https://storage.googleapis.com/gweb-research2023-media/pubtools/4120.pdf`（已读 PDF 前 200 行，含摘要与引言）
- 结论：① 结果随机化（RandTopN／RandPair）会**损害用户搜索体验**，在个人搜索中**不可取**；
  ② 提出基于 position-bias click model 的**回归式 EM**，从**常规点击**中估计偏差，可处理**高度稀疏**点击；
  ③ 提取的偏差能显著改进 LTR；**pairwise 模型比 pointwise 更能利用该偏差**。
- **NMG 可借鉴：** 不要为学习而扰动用户看到的顺序（"非侵入"是明确的设计约束）；相对偏好比绝对判断可靠。
- **迁移限制：** EM 需要足够数据估计偏差参数；论文未给出 NMG 场景的小样本下界，
  不能直接判为必然不可行，也不能把结果当作小库收益证明。

### 5. Estimating Position Bias without Intrusive Interventions（WSDM 2019，Cornell + Google）
- 来源：`https://research.google/pubs/estimating-position-bias-without-intrusive-interventions/`（摘要）
- 方案：从**历史日志中多个不同排序函数**造成的"干预数据"里收割偏好信号，做一致的 propensity 估计；
  无需人工相关性标注、无需侵入式干预、无需限制性相关性建模假设。
- 验证系统：**Arxiv Full-text Search** 与 **Google Drive Search**；前者是公开论文全文检索，
  不能把两个系统都称为私有／个人语料。
- **NMG 可借鉴：** 历史排序变化可能提供可分析的曝光差异，但版本变化本身不等于有效干预或因果对照；
  需重叠查询/条目、可比上下文、实际曝光记录及方法的识别假设。
- **不可借鉴：** 需要"多个排序函数在同一语料上产生过日志"，NMG 尚无稳定的策略版本记录。

### 6. Towards Disentangling Relevance and Bias in Unbiased Learning to Rank（KDD 2023，Google）
- 来源：`https://arxiv.org/pdf/2212.13937`（PDF 前半，含摘要、方法、实验表；Google Research 页面同一论文）
- 问题：两塔 ULTR 中，**bias tower 会通过与真实相关性关联被 confound**——因为**位置本身是 logging policy
  （上一个生产模型）决定的，而它含有相关性信息**。
- 在线 A/B（Chrome Web Store，4 周）：
  - Biased 单塔模型：点击率 **+1.21%**，但**有点击的用户数 −5.78%**；
  - 去偏 GradRev：点击率 **+2.90%**，有点击用户 **+0.96%**。
- 原文结论：biased 模型只是让少数用户更爱点，**同时让其余用户更少点**；去偏后总量与用户数同时上升。
- **NMG 可借鉴：** 这是"点击率上升但体验变差"的直接证据，支持**不把"被读取"当作纯正信号**，
  也支持同时看**有多少不同记忆／用户被覆盖**（不能只看总次数）。

---

## 三、多目标、长期效用与探索

### 7. Focus on the Long-Term: It's Better for Users and Business（KDD 2015，Google）
- 来源：`https://research.google/pubs/focus-on-the-long-term-its-better-for-users-and-business/`（摘要）
- 结论：短期 A/B 效应**不总能预测长期效应**；建立量化"长期用户学习"的实验方法；
  广告盲视／可见性由**过去看过／点过的广告质量**驱动；聚焦用户满意度最终带来**50% 广告位缩减**。
- **NMG 可借鉴：** 一次展示的即时收益与长期收益可能反向；"更少展示"可能是正确答案而非退化。
- **不可借鉴：** 长期效应量化需要跨轮实验平台；NMG 不具备，**不能声称已能度量长期效用**。

### 8. Recommending What Video to Watch Next: A Multitask Ranking System（RecSys 2019，Google/YouTube）
- 来源：`https://research.google/pubs/recommending-what-video-to-watch-next-a-multitask-ranking-system/`（摘要）
- 要点：多个**相互竞争**的排序目标 + 用户反馈中的**隐式选择偏差**；用 MMoE 软参数共享，
  并在 Wide & Deep 框架下缓解选择偏差。
- **NMG 可借鉴：** "相关性"与"是否展示"是不同目标，需要分开建模而非压成一个分数。

### 9. Learned Ranking Function: 从短期行为预测到长期满意度（RecSys 2024，Google/YouTube）
- 来源：`https://arxiv.org/html/2408.06512v1`（已读正文，含算法与部署）
- 做法：把排序建模为 **slate 优化**，直接最大化长期满意度；给出**约束优化**算法
  （主目标 max，次目标 `J_k ≥ β_k`；单约束有闭式解，多约束顺序施加）；探索用 **ϵ 概率把随机候选提到首位**。
- 工程条件：**on-policy** 训练，且只在 **约 1% 流量**上训练所有模型以便并排比较；奖励函数是
  "watch 上的用户满意度"（引 Christakopoulou et al. 2021）；旧系统是**贝叶斯优化调参的启发式排序函数**。
- **NMG 不能借鉴的地方（明确）：** 它需要 on-policy 采样与多模型并行流量，NMG 没有；
  "长期满意度"奖励的定义依赖 Google 的满意度代理指标，不可直接借用。
- **可借鉴的原则：** ① 把"多目标"显式写成主／次约束，而不是加权和拍脑袋；
  ② 探索必须是**有界、小比例、可回滚**的（1% 流量或 ϵ 概率），不是全局放开。

### 10. Sampling-Bias-Corrected Neural Modeling（RecSys 2019）／Top-K Off-Policy Correction（WSDM 2019）
- 来源：两条 Google 摘要 + `https://arxiv.org/html/1812.02353`（已读正文 4–5 节）
- Top-K 论文明确承认：**"学习自 logged feedback 会受到偏差影响，因为只能观察到上一版推荐器所选项目的反馈"**；
  重要性权重在 π 与 β 差距大时**方差极大**，故采用一阶近似（略偏、低方差，误差有界）；
  **behavior policy 需从日志估计**（系统内有多个 agent，部分是确定性策略）。
- **NMG 结论：** 若要以"策略行为"为基准做去偏，必须先能记录**当时是谁／用什么策略／按什么顺序展示的**——
  当前 `RecallInstance` 已保存有序候选与分数，数组顺序可提供候选位置；但这不证明最终可见位置、
  折叠/重复披露状态或实际曝光概率已记录，尚不足以直接支撑此类估计。

---

## 四、与 NMG 最贴近的一条：重复曝光与冷却

### 11. Deep Neural Networks for YouTube Recommendations（RecSys 2016，Google/YouTube）
- 来源：`https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45530.pdf`（已读全文 PDF）
- 直接相关原文：
  - *"Features describing the frequency of past video impressions are also critical for introducing 'churn' in
    recommendations (successive requests do not return identical lists). **If a user was recently recommended a
    video but did not watch it then the model will naturally demote this impression on the next page load.**"*
  - 用**隐式反馈**（看完）而非显式点赞，理由：隐式历史多几个数量级，能在长尾处产生推荐。
  - *"Ranking by click-through rate often promotes deceptive videos that the user does not complete ('clickbait')
    whereas watch time better captures engagement."*
  - **训练样本取自全站所有观看**，而不只是自家推荐产生的观看，否则"会过度偏向 exploitation"，
    新内容难以浮现。
  - **每用户固定样本数**，避免少数重度用户主导损失函数。
  - **example age 特征**：模型天然偏向历史，"训练时把样本年龄作为特征"，服务时置零，以纠正非平稳。
  - 选择替代学习问题的影响**远大于**离线指标，"live A/B 结果与离线实验并不总是相关"。
- **NMG 可借鉴（最直接）：** "近期展示过、未被消费 → 下次自然降权"是**工业界已采用的排序特征做法**，
  且是**有界、可恢复**的（不是删除，也不是改真值）。这与"情境降权＋重复注入冷却"的设想一致。
- **NMG 迁移限制／需注意：** ① 大规模多用户实验与单用户私有库的数据分布不同，样本量需核实；
  ② 它靠 A/B 验证效果，NMG 本轮只授权受控离线验证，未建立对应线上证据；
  ③ 论文自己也说这种特征的作用**很难用离线和单独指标度量**——所以不能承诺"加了就更好"。

---

## 五、能不能迁移到 NMG：逐条判定

| 文献结论 | 需要的前提 | NMG 是否具备 | 判定 |
| --- | --- | --- | --- |
| 未点击／未读取 ≠ 负信号（good abandonment） | 无 | 具备 | **可直接采纳为解释原则** |
| 摘要级效用 ≠ 文档级效用（CAS 的 D vs R） | 两级展示 | 具备（`header`／`exact`） | **可直接采纳为解释原则** |
| 点击混杂位置／曝光偏差 | 实际曝光日志 | 候选顺序已有，实际可见状态待核实 | 不能只加 position 就声称可去偏 |
| 用多排序函数历史日志做无干预 propensity | 多策略历史 | **缺** | 需先有策略版本记录 |
| 曝光频率特征（YouTube） | 真实曝光与情境 | 待核实 | 仅作为假设，不因未 get 自动惩罚 |
| 长期效用 ≠ 短期效用 | A/B 或长期奖励 | **缺** | 只能声明为未度量目标 |
| slate 优化 + 约束式多目标 | on-policy 采样 | **缺** | 只能借用"主/次约束"的表述方式 |
| 低频、可静音的满意度采样（CAS 弹窗） | 用户可静音 | 具备（同 `<nmg_nudge>` 通道） | **可研究，但不得每轮询问** |

## 六、人工标注在 Google 到底放在哪一层（已核实官方原文）

- **Search Quality Rater Guidelines 更新公告**（Google Search Central Blog, 2023-11-16）原文：
  *"these guidelines are what are used by our search raters to help **evaluate** the performance of our various search
  ranking systems, and **their ratings don't directly influence ranking**."*
- **How Search Works — rigorous testing**（Google 官方页面）原文："719,326 search quality tests"，
  *"These ratings **do not directly impact ranking**, but they do help us **benchmark** the quality of our results"*；
  同页把 live traffic experiments 的观测量列为
  *"what people click on, how many queries were done, **whether queries were abandoned**, or how long it took for
  people to click on a result"* —— "是否放弃"是官方列出的实验指标之一。
- **Google Cloud 官方博客（Google 内部搜索 Moma）** —— 最接近 NMG 的私有语料场景，原文：
  *"we **continuously train on our own usage logs of the last four weeks**"*；
  *"Generate the training data from search logs that capture **which results were clicked for which queries**"*；
  *"**Each click on a document gets a label of 1, everything else a label of 0.**"*
  同文明确写：*"even inside Google we can't use our web search technology, because that assumes a **fully public
  dataset, a lot of traffic, and more active content owners**"*，且 *"each person has individual goals, access levels
  and needs"*。
- 二手（SEJ 引 Danny Sullivan，非一手）：*"this rating does not directly impact how this page or site ranks"*；
  评分员是拿**当前结果页与候选改进结果页**做对比评级，并称评分员超过 1 万人（数字为二手）。
- 传统 LTR（RankNet / Burges et al. 2005, ICML "Learning to Rank using Gradient Descent"）确实是**用人工相关性判断训练**排序模型——
  这是历史路径，与上述「生产用行为、评级只做基准」并不矛盾，二者是不同年代／不同层的做法。

**结论：** 按 Google 自己公开的说法，人工评级服务于**评估与基准**（含对比两版结果页），
**不直接改变排名**；这不排除人工标签间接用于训练、校准或系统改进。Moma 的点击训练是该内部
搜索系统的公开案例，不足以确定公开 Search 的全部训练信号。
**已补读（见 §七）：** YouTube 长期满意度奖励的构造 = Christakopoulou et al. 2021（RecSys / ICML RL4RealLife）。

## 七、三个规模问题（已读官方一手）

### 7.1 长期满意度怎么测 —— Christakopoulou et al. 2021（arXiv:2209.15166，已读正文）

两步：用户主动评分是人类反馈，模型再预测未回答消费项的满意度；不是逐项专业评分员标注。

1. **问卷抽样**：*"These surveys are shown **uniformly to all users**, asking them to rate on a scale how
   satisfying they found a **sampled item from their recent engagement history**."*（1–5 分量表）
   **响应率约 2%**：*"users tend to not respond to surveys— **response rate is around 2%** in our case."*
2. **插补模型**：*"only being able to observe how satisfied users are with a **tiny fraction** of user-item
   interactions... **imputation models** can be useful in predicting satisfaction level for **all items users have
   consumed**"*。reward 为 `r = f(r_u, r_e)`（式 6，含加法/乘法/幂/hinge/sigmoid 组合）；policy 网络与满意度
   插补头**多任务联合训练**。

分析数据：*"More than **two million** interactions with survey responses"*。问卷优于赞/踩的理由：
*"most users tend to not engage in post-click actions such as likes, dismissals"*。
且满意度与完成率**方向一致但方差极大**，故需 *"appropriately balance"* 两者。

### 7.2 评分员规模（Google 官方博客 "How insights from people around the world make Google Search better"）

- **"a group of more than 10,000 people all over the world we call 'search quality raters'"**（一手，非二手）。
- 指南 **>160 页**；任务：抽样 query（*"say, a few hundred"*），成组分配，看**当前版 vs 候选改进版两套结果页**。
- 规模：*"more than **383,605 search quality tests and 62,937 side-by-side experiments**"*；
  How Search Works 官方页（2023）：**719,326** quality tests / **16,871** live experiments / **4,781** launches。
- 官方说明无法逐页评：*"With **hundreds of billions of pages** that are constantly changing, there's no way humans
  could evaluate every page on a recurring basis."* → 人工只能**抽样聚合**做基准。

### 7.3 训练信号规模

| 系统 | 训练信号 | 规模（原文） |
| --- | --- | --- |
| YouTube 候选生成+排序（RecSys'16） | 隐式观看 | *"approximately **one billion parameters**... trained on **hundreds of billions of examples**"*；语料 millions of videos，候选 hundreds，展示 dozens，负采样 several thousand |
| YouTube LRF（长期满意度，RecSys'24） | 用户轨迹 on-policy | 模型 *"roughly **Θ(10⁴) parameters**"*；仅 **1% 流量**；*"trajectories from the **past few days**"* |
| Google 内部搜索 Moma（官方博客） | 点击日志 | *"usage logs of the **last four weeks**"*；**130,000 weekly users** |
| 公开 Search 排序 | 未公布 | 数十亿查询 |
| 满意度信号 | 问卷 | **2% 响应率**，>200 万条 |
| CAS 研究（对照） | — | 12 人 / 2334 会话 / **243 条**满意度 |

**对 NMG 的适用边界：**

1. 2% 是问卷响应率，不是全量交互的抽样或标注覆盖率。该插补实验使用大规模交互，不能由此证明
   单用户插补必然不可能，也不能承诺它在 NMG 的样本量下可靠。
2. 官方说质量评分用于评估且不直接改变排名，没有证明所有人工标签都禁止进入训练。
   NMG 可先用固定抽样评估；是否训练是另一项需要数据与授权的决定。
3. Moma（13 万周活、四周滚动）不能直接复用 Google 自家 Web 搜索技术，不等于一切公开检索
   算法都不能用于私有语料。

## 八、私有语料：上限在哪与导航偏好来自什么

**来源：**
- Bendersky, Metzler, Najork, Wang, "Searching Personal Collections", Chapter 14 in *Information Retrieval:
  Advanced Topics and Techniques*, ACM 2025（arXiv:2412.12330）——作者均为 Google。
- Bergman, Beyth-Marom, Nachmias, Gradovitch & Whittaker 2008, *ACM TOIS* 26(4)。
- Bergman, Tene-Rubinstein & Shalom 2013, *Personal and Ubiquitous Computing* 17(3), 583–590。
- Benn et al. 2015, *Nature Scientific Reports* 5:14719。
- Spotify, "Do LLM-judges Align with Human Relevance in Cranfield-style Recommender Evaluation?"（arXiv:2511.23312）。

### 8.1 私有 vs 公开（Chapter 14 原文三点）

1. *"Users are typically aware of most, if not all, of the items that exist in the collection."*
2. *"Personal collections are typically many orders of magnitude smaller than public collections."*
3. *"...while [web] search engines are optimized for **precision**, personal search tends to be optimized for
   **recall** — specifically, to ensure that when a user is searching for a known asset, that asset is among the
   retrieved assets."*

除排序外还需考虑：① **线索表达**（主导任务是 known-item search；失败根因是记忆失效；用户记得内容
而非形式描述符——原文称之为 known-item 检索的 *"raison d'être"*；实测 *"an average of about **two
reformulations** per refinding task, suggesting that personal search indeed suffers from **recall issues**"*）；
② **判定来源极缺**（Enron 619,446 条/158 人，*"neither queries nor relevance judgments"*；W3C/TREC-2005 Enterprise；
**Avocado** 279 账户/~2M 条，65 query × ~100 结果，每条标 **relevance 与 sensitivity**；桌面 pooling 集因隐私从未公开）。
隐私直接卡住研究：*"difficult to conduct due to user privacy concerns, which make it all but impossible to analyze
consumer email search behavior."*

### 8.2 时间序偏好与导航研究的限制

Chapter 14 将时间线索与 episodic memory 联系起来。用户提出另一种解释：时间序可能是
内容线索检索失败后的兜底。现有材料不能严格裁决这一假说。

- 2013 年研究关于表达需求和注意资源的结论主要来自摘要/引用；本轮 PDF 未成功获取，不能当全文核实。
- Bergman et al. 2008 报告改进搜索后仍偏好文件夹导航。文件夹导航不等于时间排序，
  改进某个搜索器也不等于消除内容线索表达困难。
- Benn et al. 2015 的资源差异及相近任务成功率支持导航与搜索可能有不同成本；
  不证明时间序偏好完全由成本造成，也不排除兜底作用。

NMG 可以研究时间/情境锚点是否改善检索，不能从人类导航偏好直接推出按时间排序。
LLM 也可能形成含糊或错误查询，不能假定它没有需求表达成本。

### 8.3 LLM judge 作为判定来源的可行档位

Spotify（arXiv:2511.23312）报告系统排名与人类判断一致度 **Kendall's τ = 0.87**，不是每候选标签
准确率。更丰富元数据和更长历史有助于该实验的对齐；不证明 NMG 已获相同收益，judge 也不是无代价真值。

## 九、映射到 NMG：研究启发与待验证假设

本节区分论文原始结果、迁移启发与 NMG 已验证行为；外部结果不构成实施证明。
历史 19 次召回不能证明当前所有分数无信息，也不能排除调权、改善候选生成或排序的收益。
有界分数不等于校准后的相关性概率；结构匹配也不保证内容能回答问题。

| 研究 | 对 NMG 的启发 | 不能推出的结论／所需前提 |
| --- | --- | --- |
| KDD'23：位置策略携带相关性信息，点击总量与有点击用户数可能背离 | 读取次数是有偏行为观测，不能作为唯一质量目标 | 不证明 NMG 存在同一种混淆或优化现有排序无效；需先识别本地偏差机制 |
| CAS + Good Abandonment：摘要与全文有不同效用，摘要可直接满足需求 | 保留判断相关性所需的预览，区分摘要够用与精确证据读取 | 不要求只提名或展示全文；需比较信息损失与常驻上下文成本，未读取仍属未知 |
| YouTube'16：使用全站观看而非仅推荐产生的观看 | 自选主动搜索与自动召回可为共享检索提供不同来源的观测 | 保留入口、选择方式和证据来源；合并数据不等于合并标签含义，不能直接当事实正确性监督 |
| YouTube'16：曝光频率与 example age 特征 | 重复展示、时效可作为独立可解释特征研究 | 需真实展示及任务上下文；未读取不自动惩罚，样本年龄不等同记忆事件时间或统一新近性偏好 |
| SIGIR'16 / WSDM'18 / WSDM'19：稀疏行为与位置偏差 | 先核实日志能否支持跨查询聚合与曝光分析 | 历史版本差异不是天然因果对照；候选数组顺序已有，最终展示/折叠及策略记录仍需核实 |
| LRF：主目标与次目标约束 | 固定预算比较排序质量，并约束证据丢失、上下文成本与工具轮次 | 只借目标表述，不直接引入 slate、bandit 或 on-policy 训练；足够日志是否存在另行验证 |
| 官方 rater 与 Moma 案例 | 固定问题集并排比较原版与候选；行为观测与独立评估分层 | 不直接影响排名不等于标签绝不训练；Moma 不代表公开 Search 全部训练信号 |
| 满意度问卷与个人语料研究 | 明确样本量、隐私与已知项回找的适用范围 | 2% 是响应率；不能断言单用户学习不可能，也不能把 known-item recall 优先直接套到自动注入 |

### 9.1 本轮确定的方向

主动与自动召回共享部分检索路线；减少无关结果与改善排名对两边都可能有益，但收益大小需分别观察。
自动召回是尽力而为的辅助功能，不承担完整记忆覆盖保证；工具使用率不是当前优化目标。
优先减小每块可见体积，保留前缀缓存，不引入 harness 专属压缩适配。

### 9.2 有界开发的顺序

1. 用固定问题查清正确证据在候选生成、排序、预算或展示哪一步丢失，修复有复现的一处共享问题。
2. 单独比较输出瘦身：减少重复包装，保留必要相关性线索、作用域/时效/来源及精确读取通道；
   不预设纯 ID 提名优于内容预览，也不预设具体条数或字符阈值。
3. 开工前冻结问题集、二臂比较与结束条件；不把旧样本噪声率当作当前基线。

候选覆盖、前列排名、无关注入量与实际可见内容成本是不同指标，不能压成一个 RecallInstance
比例。已有五类实例标签可作粗观察，但不替代候选级 qrels、排名指标或正确弃权判定。
同一共享改动需查看 auto/explicit 结果，避免合计掩盖退化；不要求两边收益必然对称。

### 9.3 暂不实施的机制

不恢复模型 gate，不依赖每轮回答模型评分；不把 get、无重搜、工具完成或沉默当事实支持。
行为去偏、冷却、满意度插补和策略学习都需先核实数据与适用前提，不因为有 Google 先例就上线。
相关性不足时允许自动召回为空；结构命中或分数落差只能是待验证信号，不是充分判据。

## 十、必须承认的证据缺口

- 上述均为**外部文献**，**不能**用来断言 NMG 当前候选噪声率或任何具体阈值。
- CAS 的数据规模（12 人 / 243 条满意度）说明连 Google 也需专门采集才能拿到满意标签；
  NMG 若研究满意度，需要说明采样与独立判定方法；本轮没有批准每轮自评或满意度训练。
- 未读全文、仅有摘要的条目（3、5、7、8、10 的摘要部分）不得作为实现依据。
- 本轮未读全文的：任何 Google 生产权重、衰减公式、以及"本方案已被接受"。
- 不再列为缺口：长期满意度度量（§7.1）、评分员规模（§7.2）、训练信号规模（§7.3）均已读官方／一手原文。
- 已核实为官方一手：rater 评级**不直接影响排名**、live 实验观测量含"是否放弃"、
  Google 内部搜索（Moma）**用点击日志训练**，以及该系统无法直接复用 Google 自家 Web 搜索技术的说明（见 §六）。
