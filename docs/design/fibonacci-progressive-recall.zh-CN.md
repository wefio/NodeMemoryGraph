# Fibonacci 渐进召回

[English](fibonacci-progressive-recall.md) · [使用的术语](fibonacci-progressive-recall.terms.yaml)

> **状态：实验性。** 核心 `searchContext` 仅在调用方传入 `secondPass: true` 时执行渐进重选；该方法默认关闭。`searchContextWithSecondPass()` 默认开启此选项。Pi 自动召回仅在 `NMG_QPP2_MODE=active` 时开启（该模式默认 `off`）；OmniMemEval runner 默认开启，可用 `NMG_QPP_SECOND_PASS=0` 关闭。本文描述检索机制，不承诺质量或成本收益。

## 定义

NMG 将 Fibonacci 数列解释为**累计可见证据数量**，而不是每轮新增数量：

```text
1 → 2 → 3 → 5 → 8 → 13 → …
```

重复的第二个 `1` 不产生新读取，因此执行时省略。`fibonacciEvidenceBudgets(maxEvidence)` 会把传入的 evidence 上限作为数列的末档；例如：

```text
maxEvidence = 10:
1 → 2 → 3 → 5 → 8 → 10
```

这与调用方的 `limit` 是两种不同的上限。当前实现把 `limit` 当作硬上限，但不会为夹在两个 Fibonacci 档位之间的 `limit` 临时生成一档。例如扩展 envelope 大于 10、而调用方 `limit=10` 时，循环会在下一个 13 档之前停止，不会额外合成 10 档。

渐进阶段从同一过采样候选池中重选，不重新计算 query embedding，也不再次调用 ANN、FTS 或 LLM。当前首档是数列中首个不小于调用方 `initialEvidenceTarget` 的档位；该值默认 13。强 Top-1/Top-2 分差可将首档降至至多默认的 3 档，仍受调用方目标限制。它并不总是从 Top-1 开始。

## 每档决策

每个档位重新计算一次 QPP：

\[
C_t = QPP(R_{1:K_t})
\]

当前默认 QPP 分数为 `Top1 + 0.5 × NQC`。`intentCoverage` 和 `reasonHealth` 仍可记录用于 shadow 审计，但不进入当前分数。若 QPP 判断证据充分，则停止；否则尝试下一档。候选池耗尽、caller `limit` 或扩展预算 envelope 到顶时也会停止。

`QppTriggerDecision.expansion` 记录以下轨迹：

```text
strategy
stages[]
  targetEvidence
  selectedEvidence
  estimatedTokens
  qpp
  trigger
  reason
stoppedBecause: budget_exhausted | candidate_pool_exhausted | sufficient
```

轨迹随 Active Graph 的 `qpp` 决策返回。阶段记录包含计数和分数，不含每档新增的 memory ID。回答结束后的 `usefulMemoryIds` 可以与最终选择结果作粗粒度校准；它本身不能证明具体哪一档新增的记忆有用。

## 为什么渐进召回仍保持实验性

QPP 估计的是当前证据的检索充分性，不证明计数、比较或多跳问题的证据链已经完整。因此渐进召回有两种可能：

- 简单查询在首个启用档位停止，减少暴露的上下文；
- 多跳查询被错误早停，遗漏候选池中后续的证据。

只观察已经触发的扩展，不能发现所有错误早停。仍需要少量受控探索：例如让一部分首档已判充分的查询在 shadow 模式继续计算更深档位，并使用与任务匹配的 benchmark 标注、用户确认或工具验证来判断额外内容是否有价值。回答文本是否重合只能用于诊断，不能替代这些标签。

## 与早期 Stage 0 草案的区别

早期草案：

```text
正常 Top-K → QPP 触发或截断 → 直接扩大到约 2K
```

当前实现：

```text
initialEvidenceTarget → QPP → 下一 Fibonacci 档 → QPP → …
```

当前实现优化的是在固定候选池与预算范围内逐档选择 evidence，而不是候选生成。候选池之外的遗漏仍需真正的二次检索或图路由扩展解决。

## 当前边界

- `secondPass=false`：使用固定选择预算，并保留 QPP 观测，但不执行 Fibonacci 扩展。
- `secondPass=true`：启用渐进重选。
- `searchContext` 默认关闭 `secondPass`；`searchContextWithSecondPass()` 默认开启。Pi 自动召回由 `NMG_QPP2_MODE` 控制，该模式默认 `off`；OmniMemEval runner 默认启用，可用 `NMG_QPP_SECOND_PASS=0` 关闭。这些是不同调用边界的默认值。
- 首档取 `initialEvidenceTarget`（core 默认 13）；相对 Top-1/Top-2 分差达到默认 `0.05` 时，可将首档降至 `strongHitInitialTarget`（默认 3）。调用方可覆盖这些参数；core 读取参数，不因此证明它由学习控制器选择。
- `limit` 是最大返回数量而非必须填满的目标；扩展还受 `expandActiveGraphBudget()` 的硬 envelope 限制。当前数列按 envelope 生成，caller `limit` 只截住超出的档位；若它落在两个数列档位之间，末档可能低于 `limit`。
- 只渐进扩展 evidence；关系扩展仍按最初的 `graphHops` 预算计算，不会随 Fibonacci 阶段增加。
- `forget` marker 在输出投影中显示为撤回提示并附带相应提示文本；这属于输出投影，不要求为了展示 marker 而增加检索窗口。
- 核心实现位置：`src/core/store/retrieval.ts`、`src/core/qpp.ts`、`src/core/store/active-graph.ts`、`src/core/types.ts`；Pi 模式配置见 `src/integration/config.ts` 与 `.pi/extensions/nmg/index.ts`，OmniMemEval 默认值见 `evals/omnimemeval/bridge.ts`。
