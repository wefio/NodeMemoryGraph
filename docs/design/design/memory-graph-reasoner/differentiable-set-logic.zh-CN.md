# 可微集合逻辑

[English](differentiable-set-logic.md) · [使用的术语](differentiable-set-logic.terms.yaml)

**Authority:** [父级范围](../memory-graph-reasoner.zh-CN.md)。

证据边界： 下述结果来自文中报告的研究探针运行记录，并非重新验证，也不代表当前产品性能。这些探针用于诊断，不定义公开 benchmark 执行路径或运行时默认值；参见[研究工具说明](../../../../evals/omnimemeval/research/README.md)。

### 可微集合逻辑

除链式遍历之外，MGR 在同一批节点向量上提供模糊集合逻辑，完全实现在自动微分 DAG 内（`LogicExpr`、`logicSearch`、`trainLogic`）。一个原子把每个节点映射到隶属度 `σ(τ·cos(v, q))`——一个软集合——而组合子是 t-norm 算子：AND = 乘积（交集），OR = 概率和（并集），NOT = 补集。唯一参数是一个全局锐度 `τ`，以对比方式训练。

2026 年 7 月的一次定性探针（`evals/omnimemeval/research/probes/mgr-logic-probe.ts`）在真实的 LoCoMo 多跳失败样本上、以 BGE 记录 embedding 运行了这些算子：

- **合取问题是甜点区。** 对「Which city have both Jean and John visited?」，单向量查询完全错过第二跳，而 `and(cities Gina visited, cities Jon visited)` 把「trip last week to Rome」召回到第 3 名，并把同时提到 Paris 与 Rome 的桥接 turn 保持在第 1 名。
- **NOT 配宽原子是危险的。** `and(promotion, NOT business talk)` 把全部隶属度压到 ≈0.02 并返回噪声：被否定概念的近邻会随目标一起被压制。NOT 原子必须窄，否则该算子需要一个学习到的阻尼指数。
- **AND 会过度约束覆盖型问题。** 「How did Gina promote her store?」需要若干彼此不相似的证据 turn，每个只匹配一个原子；乘积 t-norm 恰恰惩罚了那些 turn。约束型问题要 AND；覆盖型问题要 OR 或带多样性的普通排序。

一个附带发现：探针中的纯向量基线在某个问题上胜过生产桥，进一步说明桥层重排（actor 策略、FTS 交互）可能丢掉原始记录向量能保留的证据。

第二轮针对覆盖失败（「How did Gina promote her clothes store?」）的探针用硬数字定位了残余瓶颈：

- **元数据过滤必要但不充分。** 把候选限制到 Gina 的 turn（`source_actor`）消除了另一位说话人的噪声，但 4 个 gold turn 中仍有 3 个没进 top-20。
- **embedding 的相关带太窄。** Gold turn 相对问题的余弦为 0.58--0.66，而 top-20 截断是 ≈0.619、语料中位数是 0.542——一条约 0.14 的窄廊，信号与填充物混杂。按方面分解的子查询给 gold 打得更高分（最高 0.76），但各方面取并集后同样拥挤。在这次探针中，这些漏失与所测试的 BGE embedding 设置的限制一致，并不能证明算子本身失败；这一层级的覆盖漏失可能需要更强的 embedder 或更大的预算（K=40 的消融已经展示了这一预算权衡）。
- **固定 τ 会让真实 embedding 分布饱和。** 用默认 τ = 8 时，切题隶属度全部坍缩到 ≈1.0，OR/AND 排序退化为并列噪声；τ ≈ 1 恢复排序。隶属锐度必须按 embedding 空间校准（或经 `trainLogic` 学习），集合逻辑才能在真实向量上有意义地组合。

两个派生算子补全该集合：`nand(...)` = NOT(AND)，功能完备但单独使用时是反选择器（不相关节点排名最高，因此它只是构造块或可微冲突惩罚——例如训练被取代状态不要共激活）；以及 `xor(a, b)` = OR·NAND，它把只属于一侧的证据排在两侧皆是的歧义陈述之上。

一次后续 BEAM 探针（`evals/omnimemeval/research/probes/mgr-xor-probe.ts`，conversation 1 的 contradiction_resolution 问题）在这个样本中得出了负面结果：
**XOR 在所测试的真实 embedding 上失效，因为它们没有把否定与主题区分开。**「Never wrote Flask routes」与「implemented Flask routes」占据向量空间的同一区域，因此每条切题消息都是两侧成员，XOR 压制了它本要暴露的矛盾证据（top 排名被无关噪声填满）。`and(never, did)` 退化为普通的主题检索——它确实找到了 gold 消息，但未修改的问题向量也能找到（第 3--4 名）。对于这些输入，该探针不支持用朴素 embedding 上的检索侧集合逻辑解决矛盾检测；它支持加入极性感知信号（例如 NMG 的 `truth_status`／冲突元数据，或读者侧检测）。当两个原子占据不同向量区域时，XOR 仍可能有用。

第三个探针测试了针对否定的向量原生补救：一条极性轴，按泛化的「never did X」与「did X」句对的均值差估计。该轴未能迁移——gold 矛盾消息落在中段（167/188 与 127/188 名），其方向与 gold 对自身的差向量基本正交（cos 0.042）。在这个样本中，句间差异由主题主导而非极性：
**所测试的 bge-small-en 样本未提供可迁移的线性否定方向。** 对每个领域用最小极性对拟合的轴也许更好，但那是脆弱的按领域产物；元数据／读者路线仍是可取的那一条。

一个最小对 k-NN 测试（`evals/omnimemeval/research/probes/negation-knn-probe.py`，十对肯定／否定句孪生）在该十对样本中的每个受测模型上都发现了相同模式。对每个受测模型，一个否定句的 top-1 邻居都是它自己的肯定孪生句，而不是另一个否定：

| 模型 | 孪生句为 top1 | cos(neg, twin) | cos(neg, 最佳其他否定) |
| --- | -----------: | -------------: | -----------------------: |
| bge-small-en-v1.5 | 9/10 | 0.823 | 0.671 |
| Qwen3-Embedding-0.6B | 10/10 | 0.861 | 0.556 |
| gemini-embedding-001 | 10/10 | 0.881 | 0.654 |

在这个小样本中，每个受测模型都把否定陈述排得比其他否定句更接近肯定孪生句；这与这些示例中主题相似度主导极性的情况一致，但不足以证明所有 embedding 都有普遍限制。对于必须区分逻辑极性的检索，这些结果支持在写入时抽取并存储显式记录元数据（例如 `polarity` + `predicate_key`），而不是只依赖向量相似度。

一个写入时抽取原型端到端验证了这条路线（`evals/omnimemeval/research/polarity/polarity-extract.py`、`evals/omnimemeval/research/polarity/beam-polarity.py`、`evals/omnimemeval/research/polarity/polarity-pairs.py`）。`memory_records` 增加了三个可空列——`confidence`（REAL）、`polarity`（`affirmative`/`negative`）、`predicate_key`（规范 snake_case 谓词）——由一个廉价流水线填充：正则否定线索过滤，然后由一个固定弱模型（deepseek-chat，temp 0）为线索命中的记录及其 top-3 embedding 邻居抽取极性 + 谓词键 + 置信度。发现：

- **BEAM 的矛盾对可被检测为一个确定性连接。** 在 BEAM 100K conversation 1（188 条消息）上，msg-24「I'm trying to implement the basic homepage route with Flask」被抽取为
  `affirmative / user_implemented_homepage_route_with_flask`，而 msg-58「I've never written any Flask routes...」被抽取为 `negative /
user_written_flask_routes`。在键规范化（见下）之后，两者落到同一个 `predicate_key` 上且极性相反，于是矛盾检测变成 `SELECT ... WHERE a.predicate_key = b.predicate_key AND a.polarity
<> b.polarity`——查询时零 embedding 运算。
- **LLM 谓词键跨改写不具规范性。** 单遍抽取器对同一事实产出 `user_implemented_homepage_route_with_flask` 与 `user_written_flask_routes`，连接因此漏掉。第二遍按 embedding 聚类键（bge-small，余弦 ≥ 0.85，union-find）把 181 个原始键合并为 96 个簇，恢复了该对。规范键需要这一合并过程或词汇受限的抽取。
- **键聚类在高阈值下过度合并。** 一条 union-find 链把约 90 个 `assistant_provided_*` 键坍缩为单个簇（所有 assistant turn 作为键看起来都相似）。矛盾对的精确率仍得以保持，因为过度合并撞上的是同极性键，但在安全之前该合并需要极性感知的守卫（绝不跨极性合并）。
- **LoCoMo user_1 基本上没有事实性否定。** 88 个线索命中、0 个真正否定——所有匹配都是习语（「can't wait」「won't quit」）或问句。提示必须把那些当作肯定，且 LoCoMo 是矛盾评测的错误语料；BEAM 才是为此设计的语料。
- **成本与弱模型纪律相容**：每段对话约 180--370 次 deepseek-chat 调用，温度为 0，不涉及读者级模型，且正则预过滤跳过约 76% 的记录。

第二次迭代把原型变成分层 worker（`evals/omnimemeval/research/polarity/polarity-worker.py`，由 `evals/omnimemeval/research/polarity/polarity-validate.py` 对照 BEAM conv 1 上逐消息的 DeepSeek 标签验证，188 条消息经 `evals/omnimemeval/research/ablations/beam-ingest.mjs` 摄入）。一个 spaCy 规则层（对 ROOT 动词的依赖 `neg` 表达否定，用 SVO 主干构造键，习语与「don't need/have」这类必要性否定延后）以零成本解决 27% 的记录，极性一致率 100%；其余以每批 15 条送 LLM（共 10 次调用，对比 188 次逐条），提示中带当前键词表，一致率达到 99.3%。一个 `extract_method` 列记录每一行由哪一层填充。规则层有两条教训：在多子句句子中，谓词必须取自携带否定的那个子句（msg-58 的 ROOT 是「starting」，但事实是「never written」）；对必要性／能力的否定是指引，不是事实性否认。

随后规范化阻塞被关闭（`docs/design/predicate-key-canonicalization.md`、`evals/omnimemeval/research/polarity/polarity-canonicalize.py`）：两层都施加严格键语法（剥离体貌／情态外壳，宾语用裸中心名词），对 embedding 相似的键对由 LLM 仲裁（`implement_route == write_route` 这类同义合并），为非 claim 增加 `neutral` 极性，并加一个时间连接过滤（较早肯定对较晚否定，按 `rowid` 排序）。已知的 BEAM 对现在在 4 个连接候选中排第一。意外的负面结果：deepseek-chat 的逐对矛盾裁决对 prompt 不稳定（同一 gold 对在琐碎改写之下被判定为真与假），因此弱模型验证只是建议性的——精确率必须来自上游的键构造，而不是下游否决。

记录粒度是剩下的天花板：BEAM conv 1 的第二处官方矛盾位于一条 4.7K 字符的消息内部，对「每记录一个极性」的模型不可见。把抽取移到 claim 粒度（188 条记录产出 721 条 claim）使两处官方矛盾对都可检测，且 claim 级仲裁确认了 83 处同义合并。一个答案阶段的 A/B 探针（`evals/omnimemeval/research/probes/beam-answer-probe.py`）随后展示了这对分数为何重要：给定原始证据的未预热弱读者选了一边并错过矛盾（Q1 自信地答错），而同一证据加上一条由元数据派生的矛盾注释，则产生官方 `ideal_answer` 的行为。渲染路径现在在 OmniMemEval 适配器以及 Pi 的常驻、自动召回与 `nmg_get` 上下文中附加这些确定性注释。Pi 的 `nmg_remember` schema 也接受原子 claim，而 core 从首个非中性 claim 派生记录级的极性、谓词、置信度与抽取方法，而不是信任另一份独立提供的汇总。矛盾查找会拒绝共享作用域键彼此不一致的记录。

因此表达形状必须随问题类型而定，而选择形状在今天本身是一个未路由的决策。MGR 集合逻辑仍是 Lab 原语。
