# Supersession（记忆取代）设计

> nmg 的写路径能力：当一个新记忆是某个旧记忆的**更新值**（"Employed" 被 "self-employed" 取代、"salary 20k" 被 "salary 30k" 取代），把旧记忆标记为 superseded，检索侧自动过滤并带出后继新值。参照 MemStrata / MemClaw 的写时确定性取代模式，nmg 的 schema 从一开始就预留了 `supersedes_id` / `valid_until`。

## 分工：nmg 只做确定性的部分

| 层 | 做什么 | 谁 |
|---|---|---|
| 候选检测 | 找"可能是旧值的同 scope 记忆" | **nmg 核心**（文本/结构信号） |
| 语义判断 | 哪个候选真的是被取代的旧值 | **外部 judge**（LLM，由调用方提供） |
| 应用 | 标记 superseded + 指针 + valid_until | **nmg 核心** |
| 检索 | 过滤 superseded + 带出后继新值 | **nmg 核心** |

nmg 不内置任何 LLM 调用（同嵌入 provider 的原则：nmg 不带模型）。judge 是**调用方注入**的——插件借 agent 的 LLM、评测借评测的 LLM、daemon 自主运行时可配独立端点。

## nmg 核心接入点（src/core/）

### 类型（`src/core/types.ts`）

```ts
// remember 返回的候选（文本启发式，非语义）
interface RememberResult {
  supersedeCandidates?: DuplicateCandidate[];  // { memoryId, statement, eventTime, similarity }
}

// judge 的返回（外部 LLM 判定）
interface DuplicateJudgement {
  merge: boolean;               // 与某候选是重复 → 走合并
  supersede?: boolean;          // 新语句是新值，取代某旧值
  supersededMemoryId?: string;  // 被取代的旧值候选 id
}

// remember 的扩展点：调用方注入 judge 回调（同步）
interface RememberInput {
  judgeDuplicates?: DuplicateJudge;
}
```

### 候选检测（`src/core/store/writes.ts` → `supersedeCandidates`）

纯文本启发式，**不判语义**，把"可能被取代的旧值"找出来交给 judge：

- **全 scope 候选池**：不限制"最近 N 条"——旧值可以隔 10 年（2025 的 employment 被 2035 的 self-employment 取代）
- **instr 子串预过滤**（`lower(statement)` 匹配 token）避免全表扫；不用 `LIKE ... ESCAPE`（node:sqlite 对 `ESCAPE '\'` 报错）
- **token 规范化**：小写 + 去标点（"Employed" ≡ "employed"、"healthcare." ≡ "healthcare"）
- **转换结构检测**（`transitionFromTokens`）：`moving / transition / switch / shift ... from X to Y` 的 **X 就是旧值侧关键词**，反查召回该主题的前任——相似度（lexical 或 vector）无法可靠分离"真前任"和"同主题闲聊"，但语言结构给确定性信号
- 排序：转换命中优先 → 相似度；上限 `SUPERSEDE_CANDIDATE_MAX = 10`

### 应用（`src/core/store/writes.ts` → `applySupersession`）

```ts
store.applySupersession({
  newMemoryId,          // 新记录 id
  supersededMemoryId,   // 旧值 id（judge 判定）
  validUntil?,          // 可选
});
// 旧值 → status='superseded' + valid_until
// 新记录 → supersedes_id 指向旧值 + evidence_role='update'
// 事务（BEGIN IMMEDIATE）
```

### 检索侧（`src/core/store/retrieval.ts`）

- 候选 SQL 已过滤 `status='superseded'`
- 若候选是 superseded 且 `!includeHistorical`，查它的 active 后继（`supersedes_id` 链）带出并加权（`SUPERSEDE_SUCCESSOR_BOOST`）——新值能被检索到，即使它自身的排序分低

## judge 实现（归评测侧，非 nmg 核心）

`evals/omnimemeval/judge-provider.ts` — OpenAi 兼容 judge 客户端（DeepSeek 格式：`thinking:{type:enabled}` + `reasoning_effort` 或 `temperature:0`）。**这是评测桥模拟插件时"借评测 LLM"的实现，不是 nmg 的一部分**。

```ts
// 评测桥：ingest 时收集 supersedeCandidates → 并行调 judge（复用评测 LLM）→ applySupersession
const remembered = store.remember({ statement, scope, ... });
if (judge && remembered.supersedeCandidates?.length) {
  const cands = remembered.supersedeCandidates
    .filter((c) => 候选时间早于新语句)   // 旧值必早于新值
    .slice(0, 3);                        // 保留核心排序，不按 sim 重排
  const j = await judge.judge({ statement, supersedeCandidates: cands });
  if (j.supersede && j.supersededMemoryId)
    store.applySupersession({ newMemoryId: remembered.memory.id, supersededMemoryId: j.supersededMemoryId });
}
```

评测桥的 judge 配置：`NMG_JUDGE_BASE_URL/MODEL/API_KEY` → 回退 `EVAL_*` → `ANSWER_*`（复用评测的 DeepSeek），`NMG_JUDGE_DISABLED=1` 关闭。

## 调用方接入（真实插件 / daemon）

nmg 核心不调 LLM。接入方两种方式：

1. **同步回调**（`RememberInput.judgeDuplicates`）：调用方在 remember 时注入 judge 回调（插件在线时用 agent 的 LLM）。
2. **候选 + 后置应用**（评测桥模式）：remember 返回 `supersedeCandidates`，调用方用任意 LLM（agent / 独立便宜模型 / 评测 LLM）判定后调 `applySupersession`。

**反馈驱动**（0-annotation）：`store.recordFeedback({ supersede })` 在**回答后**应用 supersede——LLM 在反馈内，摄入时不做语义标注。完整设计见
`docs/design/feedback-loop-design.md`（统一记忆维护反馈通道：nmg 自动 + LLM 主动）。

## 验证

Martin persona 一条（trial6）：Dynamic Update 2/6 → 4/6（含 self-employment 那条），Generalization 0.645 → 0.710，整体 QA 0.811 → 0.835（+0.024，无回退）。96 单测全绿。
