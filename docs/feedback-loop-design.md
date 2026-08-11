# NMG 记忆维护反馈（Feedback Loop）设计

> 一个统一的"记忆维护反馈"通道：**nmg 自动兜底 + LLM 主动增强**。写路径不做
> 语义标注（0-annotation ingest），语义判断（过时/取代/检索意图）后置到反馈，
> LLM 在反馈内。该边界用于避免把可靠性寄托在 Agent 自觉写入、稳定记住记录
> ID，或一次性召回行为上。

## 定位

反馈通道解决三件事：

| 信号 | 谁提供 | 解决的 kimi 反馈 |
|---|---|---|
| `used`（用了哪些记忆） | **nmg 自动**（回答匹配推导）+ LLM 可补 | #1 写入靠自觉 → 检索使用不靠自觉 |
| `supersede`（旧值过时/被取代） | **LLM 主动**（语义判断） | 动态更新：旧值不再作为当前答案 |
| `retrieveHints`（该被什么词检索到） | **LLM 主动**（检索意图只有写入者知道） | #2 中英混合召回弱 → agent 给等价检索词 |

分工的本质：**nmg 自动做能推导的（可确定性推导），LLM 主动做需要理解的（语义/意图）**。

## API

```ts
recordFeedback(input: RecordFeedbackInput): void;

interface RecordFeedbackInput {
  sessionId?: string;
  /** 回答实际用到的检索记忆。nmg 也可用 deriveUsedMemoryIds 自动推导。 */
  usedMemoryIds?: string[];
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
- `used`：评测桥可不给（nmg 自动推导）；
- `supersede`：评测桥用评测 LLM（judge）判断 → 传 old（+ 可能 new）——信息来自
  对话/检索，非 golden，公平；
- `retrieveHints`：评测桥可选（用 judge 提取记忆检索词）——默认不给（nmg 自动
  检索为主）。
