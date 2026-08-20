# NMG 记忆维护反馈（Feedback Loop）设计

> 一个统一的"记忆维护反馈"通道：**NMG 自动记录可观测事实，LLM/用户/
> 工具只在各自能验证的边界内提供判断**。写路径不强制语义标注
> （0-annotation ingest），过时、取代和检索意图等语义判断可在 `remember`/
> 反馈接入点中由 LLM 补充。该边界同时防止把 API 模型的回答表面行为误当成
> 因果证据。

## 定位

反馈通道解决三类不同的事，不得混用：

| 信号                                       | 谁提供                                       | 可以驱动什么                               |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| `disclosure`（哪些精确记忆已给模型）       | **NMG 自动**                                 | 读取统计、下一轮反馈复查选择；不是答案归因 |
| `answer_overlap`（回答与记忆文本表面重合） | **NMG 诊断器**                               | 审计和测量诊断；不训练控制器，不改图和层级 |
| `verified_evidence`（可验证证据与结果）    | **用户明确反馈、成功工具结果或官方评测标注** | 控制器监督、边后验、长期巩固               |
| `supersede`（旧值过时/被取代）             | **LLM 主动**（语义判断）                     | 动态更新：旧值不再作为当前答案             |
| `retrieveHints`（该被什么词检索到）        | **LLM 主动**（检索意图只有写入者知道）       | #2 中英混合召回弱 → agent 给等价检索词     |

分工的本质：**NMG 自动记录它能直接观测的，LLM 主动做需要理解的语义判断，
但只有独立可验证的结果才能作为学习和图巩固证据**。

## API

```ts
recordFeedback(input: RecordFeedbackInput): void;

interface RecordFeedbackInput {
  sessionId?: string;
  /**
   * 由调用方明确报告的访问需求信号。只更新 access_count / last_accessed_at，
   * 不证明 API 模型因果使用，也不能代替 verified_evidence。
   */
  attributedMemoryIds?: string[];
  /**
   * LLM 判定的一条旧值被取代。
   * - 给 newMemoryId  → 完整 supersession（旧值 superseded，指针指向新值）
   * - 只给旧值 id     → 标 disputed（过时但新值未定），后续摄入新值再 supersede
   */
  supersede?: {
    supersededMemoryId: string;
    newMemoryId?: string;
    reason?: string;
  };
  /** 记忆的检索提示（别名/预期触发词/中英等价词），存为 retrieveHint marker。 */
  retrieveHints?: string[];
}
```

软信号：反馈里任何无效目标（缺失/已删除/已 superseded）都被忽略，绝不抛给调用方。

`recordFeedback` 是写路径维护 API，不是 Active Graph 证据归因 API。AG 的三层
观测分别通过 `recordActiveGraphDisclosure`、`answer_overlap` 诊断归因和
`verified_evidence` 验证归因记录。直接的
`recordActiveGraphAttribution` daemon RPC 只能写入 `answer_overlap`，不得伪造
验证证据；验证归因必须经过 `recordClaimOutcomes` 的 source、lineage、精确证据和
Active Graph 暴露校验。

Pi 在用户/工具 outcome 成功落库后，将同一图的累计支持集合写成
`verified_claim_support` shadow attribution。省略图 ID 时，只能绑定到当前 Pi 会话中
最新且确实包含该 memory 的图；没有匹配图时仍可保存 claim posterior，但不产生召回
监督。`task` 来源可能是模型自行报告，因此在 Pi 中不自动进入 verified shadow target；
官方 benchmark 由独立评测控制器写入。

claim outcome 还必须保存 `collectionOrigin=natural|controlled|legacy`。普通产品使用为
`natural`，受控探针和 benchmark 为 `controlled`，迁移前无法证明来源的记录为 `legacy`。
自然维护审计只能用 `natural` 事件证明精度或可逆性；总事件数仅用于存储审计。

## supersede 的两种模式

1. **完整取代**（new + old）：调用方知道新值 id → `applySupersession`——旧值
   `status='superseded'` + `valid_until`，新值 `supersedes_id` 指针 + `evidence_role='update'`。
   检索过滤旧值、带出新值。
2. **过时标记**（old only）：调用方只确定旧值过时、新值未摄入 → 标
   `status='disputed'`——检索仍返回但降权/标注"过时"；后续摄入同主题新值
   时 supersedeCandidates 会把它当作候选，judge 判定后走完整 supersede。
   agent（LLM）对 id 记性差，只给旧值（检索结果里看得到）是最可靠的输入。

## retrieveHints

- **存储**：markers 里的开放 kind——`{ kind: "retrieveHint", attributes: { value } }`——
  无需 schema 迁移（markers 本就是开放的）。
- **消费**：检索候选生成时，hints 作为**额外检索词**参与——query 含 hint 词（或其
  CJK 子串）时该记忆进入候选。缓解 kimi #2（unicode61 不切中文：agent 写入时给
  中文等价词，中英混合查询能命中）。
- **来源**：LLM 主动（写入者最懂检索意图）；评测桥模拟时 hints 来自记忆本身
  （非 golden 问题），公平。

## 与 supersession 的关系

supersession（记忆取代）是 nmg 写路径能力：单值属性的"旧→新"更新。它有三种触发：

1. **摄入时 judge**（已有）：supersedeCandidates（转换检测/token/polarity）→ 外部
   judge 判定 → applySupersession。0-annotation 摄入（不传 polarity 也能跑）。
2. **反馈驱动**（本设计）：agent 回答后 recordFeedback({ supersede }) → 同上应用。
3. **自动矛盾**（已有）：contradictionNotes 检索时提示 affirmative/negative 对立。

## 评测桥模拟

评测桥模拟 agent 调 recordFeedback：

- `attributedMemoryIds`：评测桥默认不给；它只是显式访问需求，不是正确性标注；
- `supersede`：评测桥用评测 LLM（judge）判断 → 传 old（+ 可能 new）——信息来自
  对话/检索，非 golden，公平；
- `retrieveHints`：评测桥可选（用 judge 提取记忆检索词）——默认不给（nmg 自动
  检索为主）。

官方 benchmark 若有与问题对齐的支持证据标注，可由评测控制器直接写入
`verified_evidence`。它与回答模型分离，因此可用于控制器和召回策略评估。
