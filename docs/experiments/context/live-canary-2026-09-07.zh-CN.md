# 上下文实机金丝雀：通过官方评分器接通真实主模型暴露

[English](live-canary-2026-09-07.md) | [简体中文](live-canary-2026-09-07.zh-CN.md) · [术语](live-canary-2026-09-07.terms.yaml)

证据边界（2026-10-17 文档审阅）：本带日期记录属于历史研究材料，不是当前 runtime 契约，也不授权运行 provider 实验。本轮未重跑所引实验，未独立复核原始运行产物。

**Date:** 2026-09-07
**Status:** 探索性接线金丝雀——**不是**效能主张，也不是 benchmark。
**Owner context:** agent-convergence-feedback-design（§9），#25 之后的阶段。

## 目的

回答这个前置问题：离线设计出的干预动作（`none` / `cue` / `retrieve`）能否对着**真实主模型**端到端执行，并由**官方** OmniMemEval 评分器判定——同时在模型 `create()` 边界上精确捕获？

此前的 #25 离线探针只用了自定义词法评分器和字符/4 的 token 估算；从未有真实 LLM 消费过某次干预的上下文。本次金丝雀在一个极小的固定问题集上闭合这一接缝。

它刻意**不是**效能或策略比较：n=3、单一模型、仅时序类问题，且回放的是历史检索产物。

## 环境与产物

- 代码：`evals/omnimemeval/research/context-live-canary.py`（以及 `tests/evals/context-live-canary.test.ts` 中的无网络 dry-run 测试）。
- 配置（本地 gitignore）：`.nmg/context-live-canary.config.json`；环境变量派生于 `.env`（从不提交，从不打印）。
- 检索上下文：回放自既有检索产物 `results/locomo/nmg-locomo_20260831T104024Z/nmg_locomo_search_results.json`。
- 数据集：官方 `OmniMemEval/data/locomo/locomo10.json`。

## 设计

### 三个臂（同一 `(group, question)`、同一模型，只有注入的上下文变化）

| 臂 | 上下文 | 说明 |
| --- | --- | --- |
| `none` | `""` | 完全没有任何记忆内容 |
| `cue` | 一条简短字面量（`CONTEXT_CUE`） | 不含具体记忆 |
| `retrieve-replay` | 该题完整的非空检索上下文（≤12000 字符） | 回放所得，不是实时检索 |

三者都通过官方 `LOCOMO_ANSWER_PROMPT.format(context=.., question=..)` 注入后调用模型。

### 问题选择（确定性，绝不按分数）

1. 按数字顺序取前 `3` 个不同的 `locomo_exp_user_N` 组。
2. 在每组内取**顺序最前**的问题，其检索上下文非空且 ≤ `maxContextChars`，且其数据集类别不为 `5`。
3. 选中：g0/g1/g2，全部为时序类（"When did ..."），gold 为一个具体日期。

### 模型与评分

- 模型：官方 `create_async_openai_client("ANSWER")` → `deepseek-chat`（本环境回答与判定的配置路由相同：`ANSWER_MODEL == EVAL_MODEL == deepseek-chat`）。这只是配置记录，不代表独立判定；同模型自评仍是效度限制。
- 判定：官方 `locomo_grader`，不是自定义评分器。
- 捕获：在 `chat.completions.create` 外包一层客户端代理，记录真实的 `messages`、`messagesHash`、`usage` 与每次调用耗时；每次回答与每次判定各一条记录。

### 设计内置的硬约束

- 检索是**回放**的：元数据标记 `retrievalLive=false`、`source=replayed-context`；不产生可观测的检索成本，也不伪造执行器调用次数。
- 不生成任何训练／准入标签（不调用 `admitContextIntervention`）。
- 最多 9 次回答 + 9 次判定；单次调用超时 ≤ 120 s；错误被记录，绝不用零填充；每次运行使用全新的不可覆盖目录；环境变量／密钥从不打印。

## 实机结果

运行目录（本地忽略）：`.nmg/canary-out/context-live-canary-20260907T051333230591Z`（9 次回答 + 9 次判定，全部成功，用量已记录）。

| 组 / 题 | none | cue | retrieve-replay | gold |
| --- | --- | --- | --- | --- |
| g0 Caroline（LGBTQ support group） | 12 Mar 2023 ✗ | "need memories" ✗ | **7 May 2023 ✓** | 7 May 2023 |
| g1 Jon（lost job as banker） | 12 Mar 2023 ✗ | "no memories" ✗ | **19 Jan 2023 ✓** | 19 Jan 2023 |
| g2 Maria（donated car） | 12 Mar 2023 ✗ | "need memories" ✗ | 22 Dec 2022 ✗ | 21 Dec 2022 |

判定结果：none 0/3，cue 0/3，retrieve-replay 2/3。

更早一次运行因 401 失败（过期 `snapshot_eval.env` 中的失效密钥）；改用 `.env` 中的当前密钥重试。该失败被记录而非零填充，演练了该身份验证错误记录路径；这不验证所有失败或恢复分支。

## 本文确立了什么、没有确立什么

**限于所记录调用，确立的是：**“决策 → 真实模型暴露 → 官方评分 → 用量”路径得到演练。表格记录了三次 `none` 回答使用同一个错误日期、三次 `cue` 拒答，以及检索下两个正确日期和一个错误日期。重复的错误日期是观察结果，不是已解释的机制；本 canary 未诊断它是否来自提示词／日期锚定或其他原因。

**没有确立：**`retrieve` 优于 `none`/`cue`。n=3、单一模型、仅时序类问题、非实时检索，不足以支撑任何统计或启用主张。没有默认启用，也没有策略结论。

## 为什么记录但不提交

本记录转述当时的用户指导：该结果尚无独立价值，不应仓促提交为 commit/PR。它是接线脚手架，不是功能里程碑。金丝雀源码与测试在承载真实价值之前保持在工作分支未提交状态（例如一份预注册的、更大规模的同模型匹配比较，或者当路由器／顺序历史决策真正接上这条链时）。

## 后续（非阻塞）

- 在任何策略或默认启用主张之前，做预注册的更大规模匹配比较（臂 × 同模型、更多组、明确指标／边际）。
- 把 `runContextTrial` / `ContextRouter` 接上这条真实链，包括顺序历史与真实（非回放）检索。
- 为奖励／成本真实性提供独立的外部验证者适配器（不是同一评分方的组件评分器）。
