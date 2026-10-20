# 跨抽取层的谓词键规范化

[English](predicate-key-canonicalization.md) · [术语](predicate-key-canonicalization.terms.yaml)

Status: plan, 2026-07-27. 分层极性 worker（`evals/omnimemeval/polarity-worker.py`）的后续。

## 问题

矛盾检测的本意是一次确定性连接：

```sql
SELECT ... WHERE a.predicate_key = b.predicate_key
           AND a.polarity <> b.polarity
```

在 BEAM 100K conversation 1 上，流水线把每个极性都判对了，但那个已知的配对仍然漏掉，因为两个层为同一个谓词产出了不同的键：

- msg-24 "I'm trying to implement the basic homepage route with Flask"
  → LLM 层：`user_try_implement`
- msg-58 "I've never written any Flask routes..."
  → 规则层：`user_write_route`

分歧有三个不同来源，从最便宜的先修：

1. **体貌／情态包裹。** "trying to implement"、"want to add"、"started using"——表面谓词是 `try`/`want`/`start`，语义谓词是被嵌入的动词。规则层取 ROOT；LLM 取法不一致。
2. **动词同义。** 同一个行为用 `implement`、`write`、`build`。没有词形还原器能修好这个；只有词汇压力或一次 LLM 判断能做到。
3. **宾语漂移。** `route` 对 `routes` 对 `flask_routes`。取依存头名词及其词元基本能解决，但复合修饰语（"homepage route" 对 "Flask routes"）仍然不同。

带极性守卫的 embedding 聚类（cos ≥ 0.85）无法桥接如此不相似的键——`user_try_implement` 对 `user_write_route` 远低于阈值，而降低阈值会重新引入我们已经测量过的过度合并失败（一条 union-find 链吞掉约 90 个键）。

## 设计

两个机制，按顺序应用。连接本身保持精确——所有模糊工作都发生在它之前、在规范化时，而不是在查询时。

### 1. 统一键语法（预防，两个层都适用）

规范形式：`{subject}_{verb_lemma}[_{object_head_lemma}]`。

- **verb** 是主要的*词汇*动词。体貌与情态动词
  （`try`、`want`、`need`、`start`、`begin`、`manage`、`used`、`going`、
  `plan`、`hope`）是透明的：谓词是它们的不定式补语（`xcomp`），递归处理。
  - spaCy：如果 ROOT 词元 ∈ ASPECTUALS 且它有一个 `xcomp` 动词子节点，
    下降一层。"trying to implement the route" → `implement_route`。
  - LLM prompt：用文字给出同一指令，并附例子。
- **object** 是直接宾语／attr／acomp 短语的头名词，做词形还原（去掉复数：`routes` → `route`）。复合修饰语被丢弃，除非它们是命名实体或带连字符的技术 token（`flask-login` 保留，`homepage` 丢弃）。理由：修饰语是方差最大的部分；主语＋动词＋头名词才是稳定的核心。
- **subject** 是说话者 slug，与今天相同。

对运行中例子的预期效果：msg-24 变成
`user_implement_route`（规则层与 LLM 都一样），msg-58 保持
`user_write_route`。仅靠语法统一仍然不能把它们连上——那正是机制 2 的用途。

### 2. LLM 仲裁的键规范化（修复，离线一遍）

在 DB 上跑一遍抽取后处理（`polarity-canonicalize.py`）：

1. 收集去重后的键及其极性。
2. 候选对： cosine(key embeddings) ≥ 0.75、同一 subject slug，
   且**极性守卫**——只有当合并它不会吞掉一个肯定键与一个有支持的否定键时，这对才合格。
   （受守卫的合并在上一轮已被验证：它挡住了全部 3 次错误的跨极性合并。）
3. 每个候选对进入一次批量的 LLM 调用（每次调用最多 30 对）：「这两个谓词键是否指向同一个底层谓词？逐对回答 yes/no。」yes → union-find 合并。LLM 看到两个键，并为消歧各看一条示例陈述。
4. 把 `memory_records` 中的 `predicate_key` 重映射到每个簇的代表（最短键，平手时按频率破平）。

`implement_route` 对 `write_route` 正是弱 LLM 在看到两条源陈述时能可靠做出的那种判断——远比开放式生成键容易，而且可批量。

### 什么不变

- 检测仍用精确连接。查询时没有模糊逻辑。
- 极性抽取（已达 100%/99.3% 一致率）。
- `extract_method` 语义；规范化不重新标注行。

## 验证（定性门禁，BEAM conv 1）

1. msg-24/msg-58 共享一个极性相反的规范键 → 已知矛盾出现在连接中。**通过/失败判据。**
2. 人工检查仲裁通过所做的每一次合并：统计错误合并。目标：188 条消息上 0 次明显错误合并。
3. 规则层覆盖率不低于已测量的 27%。
4. 成本：语法改动免费；规范化 ≤ 每对话约 2 次批量 LLM 调用。
5. 重跑 `polarity-validate.py`：极性一致率保持 ≥ 99%。

如果门禁 1 通过且 0 次错误合并，下一步是做一次 LoCoMo 规模的运行，最终把规范化移进 worker 作为周期性清扫。如果动词同义连仲裁都击败，兜底方案是把动词从连接键里彻底去掉（只留 subject + object-head），让极性与 LLM 仲裁承担矛盾判定。

## 结果（2026-07-27，BEAM conv 1）

门禁 1 **通过**：已知配对共享规范键 `user_write_route` 且极性相反，在 4 个连接候选中排第一。计划之外还实现了：

- 一个 `neutral` 极性值（问句、寒暄、非声称）把非事实挡在肯定／否定连接之外；schema 里的极性 CHECK 约束被删掉，因为 SQLite 无法在既有表上改 CHECK——取值改在代码里校验。
- 连接上的时间过滤（`a.rowid < b.rowid`）：矛盾是较早的肯定对较晚的否定。这消掉了 11 个候选中的 7 个，包括每一条共享该键的后续 how-to。（用 `rowid`，不是 `created_at`——毫秒级 ISO 时间戳在快速摄取时会并列。更早一份 `a.id < b.id` 草稿静默丢掉了约 50% 的配对，因为 ID 是随机 UUID。）
- 仲裁有效：`user_implement_route == user_write_route` 加上另外 6 次干净的近义合并，巡检 0 次错误合并。候选对**不能**加极性守卫（它恰好挡住了这一对）——合并键永远不会掩盖矛盾，因为行保留各自的极性。
- worker prompt 里词汇受限的复用反噬过一次：LLM 把 33 条无关陈述塞进一个热门键。复用必须表述为「仅当确实是同一谓词，否则铸新键」。

剩余已知错误（4 个候选，1 个真实）：一次键碰撞
（`user_use_route` 吸收了一条 Python 版本陈述）与两次极性误标（一条部署问题报告在没有否定线索的情况下被标为否定）。

**负面结果：在当前模型档位上，LLM 逐对验证不能当门禁用。** deepseek-chat 对完全相同金标对的矛盾裁决会随 prompt 措辞与批次上下文翻转（单独一种措辞判真、11 个一批时判假、改写后的单条 prompt 又判假）。验证仅作为咨询性标注保留；输出仍是确定性连接加时间顺序。精确率提升必须来自上游更好的键化／极性，而不是下游弱模型的否决。

## claims 模型（2026-07-27）：两条官方矛盾都可检出

BEAM conv 1 恰好有两个 `contradiction_resolution` 探测问题。记录级流水线只抓到 Q1（Flask routes）；Q2（Flask-Login）不可见，因为它的证据在一条 4,776 字符的消息（msg-66）**内部**——那条消息把 "integrating Flask-Login" ＋ "completed login modules" ＋ "never written Flask routes" 塞在一起——一条记录、一个极性，所以在记录粒度上这条消息内矛盾不可能存在。

修法采用 chat.completions 的 content-parts 模型：记录是证据单元，并携带一个 `claims_json` 原子 claim 数组，每个 claim 有自己的 polarity/predicate_key/confidence（`MemoryClaim`、
`claims_json` 列，记录级列保留为首个非中性值的汇总缓存）。worker 做分句（去掉代码块），LLM 返回 claims 数组；规范化器把 claim 展平，矛盾连接按（记录 rowid，claim 序号）排序，使记录内矛盾可连接。

BEAM conv 1 上的结果（188 条记录 -> 721 个 claim，约 3.8 个/记录）：

- **两条官方矛盾配对都被检出并经咨询性验证**——
  Q1（`user_write_flask_route`：implementation homepage route 对 never written
  Flask routes）与 Q2（`user_implement_login`：integrating Flask-Login
  v0.6.2 对 never integrated Flask-Login，否定 claim 从 msg-66 内部抽出）。
- 键仲裁在更丰富的 claim 键空间上确认了 83 次近义合并（记录级时为 7 次），包括
  `user_implement_login == user_integrate_flask_login`。
- 代价：规则层覆盖率从 27% 掉到 10%（免费路径要求每个句子都能解析）；一个大的 claims 批次返回了畸形 JSON（输出更长），用更小批次重试解决；剩余假候选主要是「用户不确定怎么做 X」这类不确定性 claim 被误标为否定（不确定不是否认）。

答案阶段探针（`evals/omnimemeval/beam-answer-probe.py`，2026-07-27）：
一个**未被预先提示**的弱 reader（deepseek-chat，temp 0）拿到原始证据陈述后，两个官方问题都挑了一边、漏掉矛盾（Q1 自信地答错："you HAVE worked with Flask routes"）。给它同一批陈述再加上一条元数据派生的标注（"memory metadata flags a CONTRADICTION on '<key>': earlier claim ... vs later claim ..."），reader 就会标出矛盾并要求澄清——正是 `ideal_answer` 的行为。注意：更早一轮用矛盾预置 reader prompt 的探针没找到 A/B 差异，所以这个收益专门针对那些答案 prompt 本身没有要求处理矛盾的宿主。元数据只有在答案阶段把它渲染出来时才携带信号。下面这条查询期渲染路径现在提供了这个信号。

## 查询期渲染路径（2026-07-27）：矛盾注记到达 reader

上面点出的渲染路径已落地。`NmgStore.contradictionNotes(memoryIds)`
在查询期跑 claim 连接的矛盾查找——不存标志位——并每条记忆返回一条人类可读注记。矛盾配对中的两条记录都收到注记，因为检索可能只浮出较晚的那一条；注记文本始终按记录 rowid 排出较早对较晚。OmniMemEval 桥（`evals/omnimemeval/bridge.ts` 的 `#search`）把注记追加到每条渲染陈述之后，于是答案阶段的 reader 看到探针证明必需的那条元数据派生标注。OmniMemEval 本身未被改动——该标注是 NMG 检索产物，渲染在边界中 NMG 自己这一侧。

同一查找现在也在 Pi 插件里为常驻记忆、自动召回与精确 `nmg_get` 展开运行。`nmg_remember` 接受来自面向模型写入调用的原子 claim，核心持久化把这些 claim 当作记录级汇总的真值来源。当共同的 scope 字段取值不同时，共享谓词键不构成矛盾。

随它一起落地的两处配套修复：`remember()` 不再静默丢弃
`confidence` / `polarity` / `predicateKey` / `extractMethod` / `claims`
（此前只转发了 `truthStatus`），以及 claims 序列化经 `serializeClaims` /
`parseClaims` 在磁盘上的 snake_case 与 TypeScript 的 camelCase 之间往返。

在真实 BEAM conv 1 store 上的定性检查（`scripts/verify-notes.mts`）：175 条带 claim 的记录上 13 条注记。两条官方矛盾配对在双向都被标出（`user_write_flask_route`、`user_implement_login`）。噪声来自泛化的谓词键——`user_ensure` 把无关的 "ensure" 动词 claim 配成对，还有若干「用户不确定怎么做 X」的不确定性 claim 仍留在否定桶里。注记机制本身是健全的；残余错误是 claims 流水线的抽取／规范化质量问题，不是渲染路径的问题。
