# SimHash 词法层补充设计（工单 7）

**Status:** proposed  
**Owner:** supersession 候选召回（写路径），与 `supersession-design.md` 互补  
**Date:** 2026-09-03

## 1. 问题

`supersedeCandidates`（写路径的候选召回）目前用：
- **instr 子串预过滤**（lower(statement) 匹配 token）
- **token 规范化**（小写 + 去标点）
- **转换结构检测**（`transitionFromTokens`）
- 排序：转换命中优先 → `statementSimilarity`（word-set Jaccard）

**盲区**：所有词法判定都是**词级精确匹配**。词形变化与拼写变体导致召回为 0：

| 已有表述 | 新写入 | 词级判定 | 语义上是同一物？ |
|---|---|---|---|
| "用户偏好 Chinese explanations" | "用户偏好 Chinese explanation" | instr 匹配（explanation ⊂ explanations 前缀？否，词边界）→ 漏 | 是 |
| "embedding 配置" | "embeddings 配置" | token "embedding" vs "embeddings" 不同词 → 漏 | 是 |
| "colour scheme" | "color scheme" | 拼写变体 → 漏 | 是 |

这些变体是真实的（用户在 2026-08-12 的 supersede 链实测中见到 "Employed" ≡ "employed" 靠 token 规范化救回，但**复数/拼写/派生词形**仍漏）。

## 2. 目标与边界

**目标**：用确定性词法指纹（Feature Hashing / SimHash）补上"词形/拼写变体"的近重复候选召回——让变体重复能进 judge 候选池，而不是被词级精确匹配挡住。

**边界（明确不做）**：
- 不判语义、不替代 judge——只负责**召回候选**
- 不碰搜索排序（检索路径的 hashing 语义混合已被 rejected，见
  `docs/decisions/rejected/2026-09-03-hashing-vector-retrieval-fallback.md`）
- 不引入外部依赖、不建巨大索引（本地轻量：一列整数 / 内存 ~KB 每千条）
- NMG 只对**精确规范化等值**自动行动；近似判定始终交给 judge（维持
  supersession-design.md 的分工红线）

## 3. 方案设计

### 3.1 指纹：64-bit SimHash（token 级）

```
simhash(text) -> 64-bit integer
  tokens = 小写 + 去标点 + 分词（复用现有 token 规范化）
  v[0..64) 每个 token 的 64-bit 哈希累加 ±1
  指纹 = 每一位取 v[i] 符号
```

64-bit 是记忆系统先例验证过的量级（claude-memory-system issue #53：64-bit、
Hamming ≤ 3 召回近重复、每千条 < 1KB 索引）。

### 3.2 存储

`memory_records` 加一列 `simhash INTEGER`（或复用 markers 通道？——**列更优**：
可索引、可 SQL 范围查询）。写入时随 `upsertEmbedding` 同事务算好存下。

### 3.3 召回落点（候选检测内）

在 `supersedeCandidates` 现有 instr 预过滤之后、排序之前，加一个**指纹召回通道**：
- 新 statement → simhash
- `Hamming(new_simhash, old.simhash) ≤ 3` 且**词级判定未命中**的记录进候选
- 与现有候选合并、去重，仍走 `SUPERSEDE_CANDIDATE_MAX = 10` 上限

这样变体重复**先进候选池**，由 judge 判是否 supersede。

### 3.4 阈值与误召回

Hamming ≤ 3 在 64-bit 上对"同主题不同句"的误召回率需实测（不同长句可能恰好近
Hash）。实验阶段先测误召回率，若高则收紧（≤2）或加"至少共享 1 个核心 token"
的护栏——指纹只作**召回补充**，不单独成判定。

## 4. 实验设计（先测缺口，再决定实现）

工单 7 的 Done when 要求先证明"Jaccard 路径确实漏词形变体、SimHash 能召回"。
实验不需要 LLM、不需要外部——纯本地真实库 + 构造变体：

1. **取真实库全部记忆**（~330 条）
2. **构造变体对**：对每条含实质内容的记忆，程序化生成词形变体（复数化 /
   拼写变体 / 派生词形——只变一个 token，其余不变）
3. **测量 A（现状）**：变体作为新写入 → `supersedeCandidates` 能否召回原记忆
4. **测量 B（加指纹）**：同一变体 → 加 SimHash 通道后能否召回
5. **结论**：B - A 的召回增益 > 0 且误召回率可接受 → 实现；否则记录"缺口已
   被其他机制覆盖"并关闭

（可选）对照：真实近重复对（如 2026-08 多次出现的同名 supersede 链）验证
指纹在真实重复上不误伤。

## 5. 实现规划（实验通过后）

1. schema：`memory_records.simhash INTEGER` + migrate（旧行回填：遍历已有记录
   算指纹——一次性，可复用现有 normalizeStatement）
2. 写入：remember 事务内随 upsertEmbedding 算指纹
3. 召回：`supersedeCandidates` 加指纹通道（Hamming ≤ 阈值）
4. 测试：变体召回单测（"employments" vs "employment" 等）+ 误召回率上限断言
5. 文档：本设计 + supersession-design.md 候选检测节更新

## 6. 开放问题

- Hamming 阈值（3 vs 2）与误召回护栏（是否需"共享核心 token"条件）——实验定
- 指纹对**短陈述**（session 元数据等噪音）是否应跳过（无实质 token → 指纹无意义）
- SimHash 与现有 `statementSimilarity` Jaccard 的关系：Jaccard 保留（词级精确），
  指纹只补变体——两者并存的排序权重

## 7. 研究基础

- [claude-memory-system: SimHash near-duplicate pre-filter](https://github.com/nikhilsitaram/claude-memory-system/issues/53)：记忆系统先例——64-bit SimHash、Hamming ≤ 3、写路径预筛、每千条 < 1KB
- [qdrant: Lexical Fuzzy Filter](https://github.com/qdrant/qdrant/pull/8707)、字符 n-gram VSM：词法容错的工业做法（NMG surface anchors 的 trigram 已覆盖显式 token，本设计补**写入侧**变体召回）
- Feature hashing / SimHash 定位为词法级工具（拼写容错、近似去重）——与本设计的语义检索边界一致（见 rejected ADR）
