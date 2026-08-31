# 渐进式披露评估（2026-08-08）

> 渐进式披露（progressive disclosure）包含两个正交问题：**能力何时对
> Agent 可见**，以及**调用能力后哪些记忆内容何时可见**。Kimi 官方的
> 动态工具加载说明解决前者；NMG 的 header → exact evidence、QPP 和分层
> 展开解决后者。评估对象为 HaluMem 全量 supersession_trial19（0.7352，
> 嵌入生效）的真实评测数据 + 检索 probe。该 backend benchmark 只覆盖
> 内容披露，不覆盖 Agent 是否会调用工具。

## 0. 结论速览

- **当前报告只评估了内容披露**。OmniMemEval 会直接调用 backend
  `search()`，无法测量 Agent 是否调用 `nmg_search`、是否根据 headers
  调用 `nmg_get`、是否继续回忆，以及不需要记忆时是否弃权。
- **按需追加（QPP 第二遍）已实现**，但评测 env `NMG_QPP_SECOND_PASS=0` 关了；**即使开，promotion 案例也救不回**（probe 实证 secondPass=true 结果不变，13 条、promotion 仍不在）。
- **promotion 强信号不先行**：真实评测里 "What is Martin Mark's current job title as of June 15, 2033?" 披露的 13 条**全是 2033-05-10 无关泛化对话**，Executive Director promotion 记忆**不在披露内** → answer 无从得知（答错）。
- **评测的披露是"纯扁平"**：评测 store **全部 2329 条都是 tier2 conversation_evidence**（bridge add 显式 `tier:2`，与真实插件写路径一致）→ **warm_halves 折叠永不触发**（需 tier1≥5）→ 0.7352 是扁平披露分数，与渐进式披露无关。
- **三层根因**：① 检索排序（promotion 排 #34，词法 0 + 向量弱）② QPP 触发保守（无意图家族缺口就不追加）③ **hardLimit 矛盾**（注释说 limit 是 recommended，实现却用 limit 硬封顶追加）。

## 1. 机制现状（代码）

| 机制                                                                       | 代码                                          | 评测状态                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| **位置** = `[...direct, ...related].sort(contextUsefulness 降序)`          | `retrieval.ts:267-272`                        | 生效（排序重排，**direct 不保底**）                      |
| contextUsefulness = combinedScore + 意图 bonus                             | `search-ranking.ts:5`                         | 生效（list/recommend/assistant 三类意图）                |
| **时机①** warm_halves（tier1≥5 折叠一半，另一半 `deferredMemoryIds` 标记） | `retrieval.ts:274-281, 585-593`               | **永不触发**（评测全 tier2，progressiveDisclosure=null） |
| **时机②** QPP 第二遍（Fibonacci 逐步加证据）                               | `retrieval.ts:345-430` + `active-graph.ts:79` | **评测关**（env `NMG_QPP_SECOND_PASS=0`）                |
| **时机③** budget 裁剪（maxTokens 超限裁尾部）                              | `retrieval.ts:295-315`                        | 生效（20 条 → 13 条，6000 token 满）                     |

**披露预算（评测 bridge）**：`limit=min(trunc(top_k),50)=20`、`maxTokens=max(1000, limit*300)=6000`、`maxEvidence=20`——6000 token 只够 ~13 条对话证据（每条 ~450 token）。

## 2. 实证：promotion 案例

数据源：`results/halumem/nmg-supersession_trial19/nmg_hm_search_results.json`（真实评测渲染上下文）+ `progressive-disclosure-probe.mjs`（大 budget 看全序）。

| 查询                                                                       | 检索排序位置                            | 评测披露                      |
| -------------------------------------------------------------------------- | --------------------------------------- | ----------------------------- |
| query 2 "How did Martin's **promotion** on April 25, 2033 impact..."       | promotion 排 **#1**                     | ✓ 披露第 1 条（词法命中先行） |
| query 1 "What is Martin Mark's current **job title** as of June 15, 2033?" | promotion 排 **#34**（大 budget probe） | ✗ **不在披露的 13 条**        |

**query 1 实锤**：披露的 13 条全部是 2033-05-10 的泛化对话（"I'm considering exploring new career paths..."、"These efforts could definitely enhance my role..."），对 "current job title" 毫无帮助；真正的答案（2033-04-25 "promoted to Executive Director"）被挤出披露。

## 3. 三层根因

```
检索排序（promotion #34，lexical=0 + vector 弱）
   └→ 候选池 top-20 没有 promotion
        └→ QPP 追加也不触发（query 1 无意图家族缺口，secondPass 只跑 0.15ms 即停）
              └→ 即使触发也到不了 #34（hardLimit=min(limit=20, maxEvidence) 被 limit 压住）
```

| 层                   | 问题                                                                                                                                                                            | 证据                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| ① 检索排序           | promotion 词法 0（"job title" vs "promoted to Executive Director"）+ 向量弱 → 排 #34                                                                                            | probe（limit 50 全序 #34）          |
| ② QPP 触发保守       | 只判断"有没有检索到 + 意图覆盖"，不判断"内容是否真正相关"；query 1 无 list/recommend/assistant 缺口 → 认为 13 条"足够"                                                          | timings `search.secondPass: 0.15ms` |
| ③ **hardLimit 矛盾** | 注释"limit 是 recommended 不是硬 cap"（retrieval.ts:345），实现 `hardLimit = max(1, min(requestedLimit, maximum.maxEvidence))` 却仍被 caller limit 封顶 → Fibonacci 13→21>20 停 | retrieval.ts:348-350                |

## 4. direct 保底概念澄清

- **direct** = 检索直接命中的候选（`[...direct, ...related]` 的 direct 部分，主检索结果）；**related** = 图扩展（边传播 routeScore）。
- **direct 保底** = 披露时保证 direct 一定保留（不被 budget 裁剪/排序挤出）。
- **但 promotion 案例不是 direct**（词法 0 没直接命中 query 词）→ direct 保底救不了它；它是"追加缺失"问题。
- 附带发现：评测 API 层面 `MemoryContext.results` 是 `MemorySearchResult[]`（无 source/rank/usefulness），selection 层（ActiveGraphSelection 的 direct/related 标记、contextUsefulness 值）**不对外暴露**——评估时看不到 direct 分布。

## 5. 对照 Kimi 官方动态工具加载模式

Kimi 官方说明的目标是避免一次携带全部工具定义造成的 token 膨胀与选择
错误。其 Tool Search 不是服务端内置能力，而是应用层组合：顶层只保留
`search_tools`；模型调用后，应用根据返回结果把匹配工具的**完整声明**
作为携带 `tools` 的 system message 追加到 `messages`；随后模型才能调用
该工具。为保持前缀缓存，应只在末尾追加、后续请求原样保留已加载声明，
并让核心工具的顶层声明固定不变。

Kimi 当前把这种动态加载能力限定在 `kimi-k3`。NMG 只借鉴其“稳定发现入口

- 按需展开完整能力”的协议思想，不把自身实现绑定到 Kimi 模型或它的消息
  格式。

这与 NMG 的内容展开相似，但不能混为一个机制：

| Kimi 能力披露                   | NMG 对应层                                               | 当前状态 / 差距                                                            |
| ------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| 核心工具固定在顶层              | `nmg_search` / `nmg_get` / `nmg_remember` 是稳定三工具面 | 已做；声明规模很小，暂无必要再把三者藏到工具目录后面                       |
| `search_tools` 返回候选工具简介 | Skill metadata / harness 工具目录提示 Agent 存在 NMG     | Codex Skill 可做发现层；Pi 目前直接暴露三工具                              |
| 追加匹配工具的完整声明          | Agent 调用 `nmg_search` 后只得到 memory headers          | 不同层：前者披露能力 schema，后者披露记忆候选                              |
| 保留已加载工具声明              | 会话 AG 窗口保留已注入 memory IDs                        | 目标相似，但保留对象不同；不能用 AG 命中率代替工具缓存命中率               |
| 追加而不修改旧前缀              | 固定 policy 前缀 + 动态 recall 尾部                      | Pi 已采用稳定 policy；需要实测 provider cache tokens，而非仅检查字符串顺序 |

### 5.1 完整的 NMG 渐进式披露链

```text
Skill / 稳定工具目录提示（知道 NMG 可用）
  -> Agent 判断是否需要长期记忆
  -> nmg_search（候选 headers）
  -> Agent 选择一个或多个 IDs
  -> nmg_get（完整 statement + source evidence）
  -> 证据不足时再次 search/get，足够时停止
```

前两步属于**能力发现与工具调用策略**，后三步属于**记忆内容披露**。
HaluMem backend track 从 `search()` 开始，不能证明前两步有效。

### 5.2 必须补充的 Agent 工具轨迹评估

使用 Pi/Codex 端到端运行，而不是 backend 强制搜索。至少记录：

- 应搜索时的 `nmg_search` 召回率，以及不应搜索时的误触发率；
- headers 后 `nmg_get` 的必要证据召回率和无用正文加载率；
- 首轮不足时继续搜索/扩展的成功率和过早停止率；
- 同会话重复注入率、工具调用轮数、工具 schema tokens、记忆内容 tokens；
- provider 实际 cached prompt tokens、首 token 延迟和端到端延迟；
- 最终答案质量，并区分“未调用工具”“检索失败”“证据足够但回答失败”。

只有工具轨迹和 backend 内容披露都通过，才能声称 NMG 的渐进式披露有效。

## 6. 结构性改进方向（通用，非针对 benchmark 特征刷分）

按优先级/成本：

- **A. 修 hardLimit 矛盾**（实锤 bug，通用正确）：QPP 追加应突破第一遍 limit（用 expanded maxEvidence 而非 caller limit 封顶）——改一行，让"按需追加"在 QPP 触发时真能扩容到 #34 这类候选。
- **B. 评测开 secondPass**：bridge 默认开（`options.secondPass ?? true`），评测 env 显式 `NMG_QPP_SECOND_PASS=0`——评测产品检索路径时应开。
- **C. QPP 触发增强**：判断"内容是否真正相关"（如披露内容与 query 的语义/覆盖缺口），而非只看意图家族覆盖——结构性但复杂，需设计讨论。
- **D. direct 保底**（评估中发现的结构性缺口）：selection 层保证 direct 一定在披露内；同时暴露 source 标记便于诊断。

**注意**：A+B 做了之后，promotion 案例**仍依赖 C**（QPP 触发）才会被追加——A+B 只影响 QPP 本来会触发的查询。若目标是让 promotion 类弱词法强语义记忆进披露，根子在 ① 检索排序（时间 boost / 混合权重，t14/t17 已试过部分）与 ③ 触发条件。

## 7. 关键发现汇总

1. **评测桥忠实模拟真实写路径**：bridge add `tier:2 + conversation_evidence` 与 `.pi/extensions/nmg` 写路径一致（都 tier:2）——全 tier2 不是失真，是 nmg 写路径默认；**tier1（warm）需主动 remember 才产生**，warm_halves 是低频备用机制。
2. **0.7352 是"扁平披露"分数**：评测测不到渐进式披露的位置/时机编排（warm 折叠不触发 + secondPass 关）。
3. **budget 6000 token** 只够 13 条对话证据，20 条查询直接被 token 裁剪——披露预算偏紧。
4. **as-of 查询（Dynamic Update）是重灾区**：弱词法强语义记忆（promotion）天然排后，最需要"核心先行 + 按需追加"。

## 8. 参考

- Kimi 动态加载工具：`https://platform.kimi.com/docs/guide/use-dynamic-tool-loading`（核心固定顶层 + search 按需注入 + 前缀缓存）
- probe：`evals/omnimemeval/research/probes/progressive-disclosure-probe.mjs`（大 budget 全序 + warm on/off 对比）
- 数据：`results/halumem/nmg-supersession_trial19/nmg_hm_search_results.json`
- 相关：`docs/experiments/qpp-engineering-notes.md`（QPP 触发/预算）、`docs/design/supersession-design.md`
