# Fibonacci 渐进召回

> 状态：实验性；核心 API 仅在启用 `secondPass` 时生效。OmniMemEval
> 适配器默认启用（可用 `NMG_QPP_SECOND_PASS=0` 固定窗口），其他适配器自行选择。

## 定义

NMG 将 Fibonacci 数列解释为**累计可见记忆数量**，而不是每轮新增数量：

```text
1 → 2 → 3 → 5 → 8 → 13 → …
```

重复的第二个 `1` 不产生新读取，因此执行时省略。最后一档始终包含调用方的硬上限；
例如上限为 10 时，档位为：

```text
1 → 2 → 3 → 5 → 8 → 10
```

第一档完整加载 Top-1。后续档位仍从首次检索产生的同一过采样候选池中重选，不重新
计算 query embedding，不再次调用 ANN、FTS 或 LLM。

## 每档决策

每个档位重新计算一次 QPP：

\[
C_t = QPP(R_{1:K_t})
\]

若 QPP 判断证据充分，则立即停止；否则进入下一档。以下条件也会停止：

- 候选池已经耗尽；
- 达到 evidence 硬上限；
- token、节点或其他 Active Graph 预算不再允许加入记录。

每次运行把下列轨迹写入 `QppTriggerDecision.expansion`：

```text
strategy
stages[]
  targetEvidence
  selectedEvidence
  estimatedTokens
  qpp
  trigger
  reason
stoppedBecause
```

轨迹跟随 Active Graph 持久化到 retrieval trace。回答结束后的
`usefulMemoryIds` 可以与各档新增记忆连接，形成 QPP 校准数据。

## 为什么是实验开关

现有 QPP 主要衡量匹配强度、分数分布、类型覆盖和召回路径健康度。强 Top-1 很容易
得到“充分”的判断，但这些信号尚不能可靠证明计数、比较或多跳问题的证据链已经完整。

因此当前策略同时具有两种可能：

- 简单查询在 Top-1 停止，显著减少上下文；
- 多跳查询被错误早停，遗漏后续证据。

只观察已经触发的扩展还不能发现全部错误早停。仍需要少量受控探索，例如让一部分
“Top-1 已充分”的查询在 shadow 模式继续计算更深档位，并用官方 benchmark 证据、
用户确认或工具验证判断额外内容是否有价值。API 回答重合只用于诊断，不能替代这些标签。

## 与旧 Stage 0 的区别

旧实现：

```text
正常 Top-K → 触发或截断 → 直接扩大到约 2K
```

当前实验实现：

```text
Top-1 → QPP → Top-2 → QPP → Top-3 → QPP → Top-5 → …
```

它优化的是平均暴露上下文，而不是候选生成。候选池之外的遗漏仍需真正的二次检索或
图路由扩展解决。

## 当前边界

- `secondPass=false`：保持原有固定预算检索；
- `secondPass=true`：启用 Fibonacci 渐进召回；
- `topK`/`limit` 是正常预算而非必须填满的返回数量；动态窗口可以从
  Top-1 开始。`forget` 等结构化控制 marker 在输出投影时转换为给模型的
  提示，不要求为了展示标签额外扩大检索窗口；
- 最终档位不会超过 `expandActiveGraphBudget()` 给出的硬上限；
- 当前只渐进扩展 evidence，图关系仍按首次 `graphHops` 计算；
- 第一次 Top-1 probe 将 QPP 分量和查询意图送入现有 autodiff 控制器；
- evidence budget head 输出连续值并映射到 Fibonacci 首档；
- 最深 verified-evidence rank 作为首档深度训练目标，二重 QPP负责继续扩展；
- 旧版控制器状态会为新增特征零填充，保留既有参数。
