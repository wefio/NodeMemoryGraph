# HaluMem 操作级评测 — 2026-08-11

[English](halumem-operation-evaluation-2026-08-11.md) | [简体中文](halumem-operation-evaluation-2026-08-11.zh-CN.md) · [术语](halumem-operation-evaluation-2026-08-11.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史实验记录。下文的配置、测量、实现描述和后续建议均限于当时实验。本轮未重跑实验，也未独立复核原始产物；这些内容不是当前测试回执、默认策略决定或通用保证。

本评测衡量写入时的抽取污染、期望记忆覆盖率、干扰拒绝与更新检索。它不是 QA 分数，也还不是 STG-to-LTG promotion 的直接分数。

## 协议

- 来源：OmniMemEval 分发的官方 HaluMem Medium JSONL。
- Artifact 字段沿用官方 HaluMem adapter：每个 session 的 `extracted_memories`，每个 update 点的 `memories_from_system`。
- 官方 HaluMem prompt、rubric、`process_user` 与 scoring 函数原样使用。
- wrapper 同时接受 fenced JSON 与裸 JSON，因为 DeepSeek 返回的是合法裸 JSON，而官方 parser 只接受 fenced JSON。
- 在 Windows 上，官方 process pool 被替换为有界 thread pool。调用主要耗时在 HTTP 请求；这样保留了官方的调度与计分，同时避免子进程 parser 漂移与重复的 Python runtime。
- QA 字段被有意省略。本次 run 只评估抽取与更新操作。
- 模型：`deepseek-chat`（配置的 DeepSeek flash 路由），temperature 0，judge 请求最多四条并发。

adapter 在为较后的 slice 计分前会重放之前的 session，因此 update 查询看到的是同一份累积记忆状态。命令：

```powershell
npm run eval:halumem:prepare -- --users 1 --session-start 6 --sessions 1 --reset
npm run eval:halumem:score -- --users 1 --workers 4
```

生成的 store 与结果 artifact 留在 `.benchmarks/halumem-nmg/` 下，不提交。

## 自然数据 smoke 结果

选中的第六个 session 含 30 轮对话、两个普通 gold memory point、一个干扰记忆与四个更新。之前的五个 session 被重放但不计分。

| 指标                            | 结果 |
| ------------------------------- | ----: |
| full expected-memory recall     |  1.000 |
| importance-weighted recall      |  1.000 |
| official target accuracy        |  0.875 |
| all-candidate weighted accuracy |  0.683 |
| official extraction F1          |  0.933 |
| interference rejection          |    0/1 |
| correct updates                 |    3/4 |

官方 target-accuracy 的分母只包含字段出现在 gold memories 中的 candidate。因此抽取 F1 可以保持很高，同时大量额外 candidate 仍带有噪声。all-candidate weighted accuracy 与 interference rejection 更直接地暴露这种污染。

干扰失败是可归因的：benchmark bridge 当前把每条对话消息都物化为 `conversation_evidence`，包括很长的 assistant 建议。被拒绝的 candidate 大多是 assistant 的指导、提问或合成解释，而不是稳定的用户事实。唯一遗漏的更新检索到了若干相关陈述，但没有把完整的「旧值到新值」替换明确表达出来。

## 产品边界与决定

这是对**benchmark raw-message ingress** 的如实评分，而不是对 Pi 产品 ingress 的评分。Pi 不会自动持久化对话记录或 tool output。它的持久边界是显式的、经模型中介的 `nmg_remember`，并保留精确 evidence 与 provenance 校验。

因此这次 smoke 不能作为修改 Core 排序或启用自动 promotion 的依据。它为未来任何自动写入 gate 确立了两条要求：

1. assistant 陈述必须获得用户确认或独立验证的 evidence，才能成为持久用户事实；
2. 一次更新必须保留新值，并显式 retire 或 supersede 可归因的旧值。

在启用无人值守的 STG-to-LTG promotion 之前，同一个操作 scorer 必须评估真实的 promotion candidate（而不是原始消息），覆盖更多用户与 session，并报告错误 promotion 的成本以及成功撤回情况。

## Agent 过滤的 remember-policy 组

第二组要求配置的 Agent 模型在该对话上执行当前 NMG 持久写入策略，且不能访问 HaluMem 的 memory point 或问题。它返回原子陈述，加上精确 evidence、type、可选 time、可选 state key。输出按对话、策略与模型做内容寻址，因此重跑会复用本地被忽略的缓存。

```powershell
npm run eval:halumem:agent-extract -- --users 1 --through-session 6
npm run eval:halumem:prepare -- --users 1 --session-start 6 --sessions 1 `
  --agent-extractions .benchmarks/halumem-nmg/results/agent-extractions.jsonl `
  --data-dir .benchmarks/halumem-nmg/store-agent `
  --output .benchmarks/halumem-nmg/results/nmg-agent_eval_results.jsonl --reset
npm run eval:halumem:score -- --users 1 --workers 4 `
  --input .benchmarks/halumem-nmg/results/nmg-agent_eval_results.jsonl `
  --output .benchmarks/halumem-nmg/results/nmg-agent_eval_stat_result.json
```

在同一个第六 session 的 slice 上：

| 指标                            | raw-message ingress | Agent-filtered ingress |
| ------------------------------- | ------------------: | ---------------------: |
| extracted candidates            |                  30 |                     12 |
| full expected-memory recall     |               1.000 |                  0.500 |
| all-candidate weighted accuracy |               0.683 |                  1.000 |
| interference rejection          |                 0/1 |                    1/1 |
| correct updates                 |                 3/4 |                    4/4 |
| official extraction F1          |               0.933 |                  0.667 |

Agent 边界消除了观察到的污染，并改善了更新处理，但过度过滤了一个 gold point：用户认为改变的宠物偏好有助于管理压力的乐观态度。这是真实的 precision／recall 权衡，而不是恢复原始 assistant 消息的理由。未来的自动写入器应当保留用户显式表达的态度与因果限定，同时继续拒绝 benchmark 中那些与之矛盾的怀疑表述。

这一组更接近产品 `remember` 的职责划分，但还不是后验 consolidation：它衡量的是在重复的跨任务结果 evidence 出现之前的 candidate 形成。自动 STG-to-LTG 驱动仍然关闭。

## 第二个匹配的自然 slice

为检查第六 session 的结果是否只是某次 prompt 偶然，同样的两组在 user 1 的 session 5 上重跑。之前的四个 session 在两个 store 中都被重放。该 session 含 52 轮对话、八个普通 memory point、两个 benchmark 干扰点与一个更新。

| 指标                            | raw-message ingress | Agent-filtered ingress |
| ------------------------------- | ------------------: | ---------------------: |
| extracted candidates            |                  52 |                      8 |
| full expected-memory recall     |               1.000 |                  0.875 |
| all-candidate weighted accuracy |               0.971 |                  1.000 |
| interference rejection          |                 0/2 |                    0/2 |
| correct updates                 |                 1/1 |                    1/1 |
| official extraction F1          |               1.000 |                  0.933 |

过滤组再次消除了大量候选盈余，同时保留了较高比例的普通 evidence。它漏掉的一个普通点是「宠物对用户的情感支持与心理健康至关重要」这一解释；对话支持舒适与放松，但 Agent 没有提升到更强的「至关重要」表述。

干扰得分需要谨慎解读。一个 benchmark 干扰点把「新的体验与互动」改写为「不同的宠物物种与独特行为」；过滤后的记忆不含该主张，judge 拒绝了它。另一个把同一 evidence 改写为「愿意尝试非传统的宠物选择」；官方 judge 依据被保留的偏好变更记忆接受了它，尽管 HaluMem 将其标注为干扰。因此 `interference_accuracy_all = 0` 本身并不能证明 Agent 接纳了两条注入主张。用于产品判定时，应在汇总分数之外报告逐条 judge 决定与可归因的已存 candidate。

在这两个小规模匹配 slice 上，稳定的信号是 precision／recall 权衡：模型中介的准入大幅降低存储量与候选污染，但可能漏掉软性态度或因果解释。这足以继续评估真实的 STG candidate；但不足以调优产品写入 prompt 或启用无人值守的 LTG promotion。

## 后验 STG promotion 审计

下一组使用产品生命周期，而不是把过滤后的 candidate 当作已经持久化：

```text
Agent candidate with exact user evidence
  -> real session-owned STG remember
  -> later sessions inspected without gold memory points
  -> exact later user excerpt becomes an independent support/contradiction vote
  -> existing recordClaimOutcomes posterior and default consolidation gate
  -> qualified candidates only
```

只有 assistant 来源或无法归因的 origin evidence 在进入 STG 之前就被拒绝。后来的主题相似、assistant 陈述、沉默以及部分推断都不会成为 vote。模型返回最小的精确用户摘录，adapter 在 Core 看到该 vote 之前验证它确实出现在所声称的后续 session 中。gold memory point 始终只供 scorer 使用。

```powershell
npm run eval:halumem:promotion-audit -- --user 1 `
  --origin-start 5 --origin-end 6 --observe-through 11 --reset 1
```

| Origin sessions | 后续 sessions | STG candidates | 在 origin 处被拒 | 独立 vote | Qualified |
| --------------- | ------------: | -------------: | ---------------: | --------: | --------: |
| 5–6             |          7–11 |             17 |                3 |         0 |         0 |
| 1–2             |          3–11 |             16 |                0 |         0 |         0 |

这是一个有用的负结果。有些主题会重现，但后续用户消息往往只支持较早的宽泛 candidate 中的一个成分。例如，后来关于「改善医疗获取」的陈述并不能独立确认早先那条还同时指定了全球倡议与数字覆盖目标的复合主张。放宽 vote 规则会把主题重现变成自我强化，这违反了后验设计。

因此 HaluMem 提供了操作级的准入与更新 gate，但不提供校准 NMG 默认后验 promotion 策略所需的成功工具结果、独立验证的 evidence 归因或显式重复确认。zero-qualified 结果并不意味着 STG 已损坏；它意味着这个 benchmark 本身无法授权自动 consolidation。它还追加了一条抽取要求：可以独立变化的限定成分应当成为独立的主张或记录，以便后续 evidence 能分别更新它们。
