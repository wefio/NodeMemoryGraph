# QPP 校准

[English](qpp-calibration.md) · [术语](qpp-calibration.terms.yaml)

部署中的 Agent 需要调整 QPP 阈值或权重时使用本流程。不要把基准测试最优值直接复制为产品默认值：基准查询、强制搜索行为、记忆密度和答案裁判可能与普通 Agent 使用有显著差异。

## 当前未训练基线

当前发布的分数是刻意设计的启发式规则，不是学习得到或校准过的概率：

```text
C = Top1 + 0.5 * NQC
trigger when C < 0.55
```

`Top1` 是绝对且有界的检索强度锚点。`NQC` 是列表内离散度的归一化值；手工设置的 0.5 权重可能促使系统扩展，但不能压过一次确实强的命中。0.55 阈值、0.2 的 Top1 硬下限及各 guardrail 都是冷启动运行点。不得将这些数值描述为已在生产环境校准；只有基准提升也不足以授权修改它们。

## 必需 trace 数据

收集匹配的真实使用 trace，包括：

- 查询及稳定的 task/session identity；
- 第一遍候选分数和 QPP 特征；
- 已暴露、已扩展、已精确获取且实际使用的记录；
- Agent 是否再次搜索；
- 可用时的用户纠正、任务结果或其他 outcome 信号；
- 注入 token、工具轮次、搜索延迟和端到端延迟。

未被纠正的答案应视为未知，不能自动标记为成功。同一语义任务的重复尝试需去重，避免一次对话主导校准。

## 标签

使用彼此分离的标签，不要用一个含义过宽的“检索良好”标志：

1. `evidence_sufficient`：暴露的证据足以正确作答；
2. `expansion_helpful`：额外的 search/get 操作补充了必要证据；
3. `noise_excessive`：暴露的记录消耗预算却没有帮助；
4. `no_memory_needed`：正确行为是不进行召回。

优先使用明确的用户纠正、官方评估证据、工具验证结果和经过审查的样本。较弱的隐式信号可以低权重保留，但不得当成 ground truth。

## 校准流程

1. 收集 trace 期间冻结当前策略。
2. 按语义任务或时间拆分，不按单条 trace 拆分，避免相关回合在训练集和验证集间泄漏。还要检查精确使用的证据身份：派生自 query 的 task ID 或改写查询，如果最终使用了同一条记忆，就不算独立。训练集和验证集必须有足够多不同的训练证据目标，且不能有目标重叠。为衡量多样性，每个任务只计一个主要精确使用目标；但还要对 Agent 使用过的所有精确记录检查泄漏，避免次要证据跨越数据拆分边界。
3. 仅在训练部分拟合或扫描参数。先校准阈值；只有阈值调整无法修复错误时才改特征权重。
4. 根据真实产品成本选择运行点：

   ```text
   cost = missed_required_evidence
        + lambda * unnecessary_expansion
        + mu * injected_tokens
        + nu * tool_and_search_latency
   ```

   通常漏掉必要证据的代价应高于一次有界的额外扩展。
5. 在留出的任务上验证；仅当标签可靠时，按查询类型、语言、记忆密度以及单证据／多证据问题报告校准结果。
6. 在 shadow 模式下与之前冻结的策略比较。只有当证据充分性不退化且新增成本可接受时才晋升新策略。
7. 将生效配置、数据窗口、特征版本和指标与结果一起保存，以便复现或回滚。

## 保护措施

- 让 QPP1、QPP2 和搜索建议保持独立开关。
- 不要训练“当前策略是否选择扩展”；应训练扩展实际上是否必要或有用。
- 不要仅凭检索或渲染结果推断成功。
- 更新默认值前必须有足够的独立任务；在此之前保留保守的启发式策略。
- Embedding 模型、检索模式、prompt／工具合同、记忆分布或基础模型发生重大变化后重新校准。
- 基准数据仍适合作为回归集和冷启动先验，但不能作为真实使用概率的最终估计。

## 自然控制器 shadow 收集

普通 Pi session 可设置 `NMG_CONTROLLER_SHADOW=1`，收集有界的匹配 trace，但不改变检索。NMG 将 `controller-shadow-events.jsonl` 和 `controller-shadow-state.json` 存在 `NMG_DATA_DIR` 下。一次检索只是候选事件；只有从同一会话所属 Active Graph 显式调用 `nmg_get` 后才会用于训练。普通工作不要设置 `NMG_SHADOW_COLLECTION_ORIGIN=controlled`。反过来，对无头探针、基准或脚本实验，不得移除此标记来伪装成自然数据。完整收集和更新流程见[自然证据](natural-evidence.zh-CN.md)。

对于 outcome 已明确的 Active Graph，现有 Pi 工具接口可以直接记录标签，无需另建评估工具：

```text
nmg_remember action=feedback activeGraphId=<AG_ID>
  taskSuccess=true evidenceSufficient=true expansionUseful=false
  excessiveNoise=false noMemoryNeeded=false
```

只提供实际观察到的字段。用户纠正可设 `userCorrection=true`；除非明确审查过任务，否则不得把“没有纠正”记录为 `false`。该图必须属于当前 session，且已启用 `NMG_CONTROLLER_SHADOW=1`。这些标签只影响有界 shadow 日志，不会改写记忆或改变实时检索。

拟合之前先审查收集覆盖度：

```text
npm run eval:controller-shadow
```

该报告读取有界日志及其轮转文件，统计自动／工具检索、精确使用、outcome、显式标签、语义任务和实际注入字符数。执行 held-out 时间／任务拆分及匹配 shadow 比较之前，`calibrationReady=false` 是有意设计；此命令不会把稀疏遥测变成策略。

拥有独立审查过的标签后，构建可防止泄漏的合并数据：

```text
npm run eval:controller-dataset -- --compact
```

导出器按 Active Graph 合并检索、精确使用、outcome 和反馈，要求四项检索标签齐全，并将完整 `semanticTaskId` 分组分配到按时间排序的训练集或验证集。它会报告阻塞项，不会捏造标签，也不会把 query 指纹当作语义任务身份。

只有当导出器没有协议阻塞项后，才拟合候选：

```text
npm run eval:controller-calibrate -- --compact
```

校准命令会打印有界就绪摘要，并将完整候选（包括学习参数和回滚指纹）写入 `evals/controller-shadow/results/`。只有审计或回放候选时才检查完整产物；日常收集应使用摘要及其 fail-closed gate。
