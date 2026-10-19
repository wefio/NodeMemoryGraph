# 拓扑身份 gate 评测 — 2026-08-09

[English](gate-evaluation-2026-08-09.md) | [简体中文](gate-evaluation-2026-08-09.zh-CN.md) · [术语](gate-evaluation-2026-08-09.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史记录，其配置、测量结果和实现状态不是当前测试回执，也不授权默认策略。本轮未重跑实验，未独立复核原始运行产物。

## 问题

NMG 保守、只读的 `same_as` gate 能否区分「关于同一个人重复出现的 evidence」与「错误提出的跨人合并」，能否在出现相互矛盾的身份 evidence 时撤回其资格，并且全程不静默变更图？

## 协议

`npm run eval:topology` 使用官方 LoCoMo 对话，不调用 LLM。LoCoMo 稳定的 speaker label 被当作 held-out 身份监督：

- 每个 speaker 被刻意拆成一个早 session 节点与一个晚 session 节点，二者具有相同的 conversation／person scope；
- 早／晚这一对构成注入的正向 `same_as` candidate；
- 每段对话中两个不同 speaker 构成注入的负向 candidate；
- 以置信度 `0.99`、且两个节点都带 evidence 的五次构造 proposal observation，走生产 automation gate；
- 每次正向评估之后，加入一个处于 pending 的 `distinct_from` proposal，并再次评估同一个 gate；
- 评估组不调用被接受的关系与节点合并。

gate 组仍然使用 oracle candidate 构造。第二个非 oracle 的发现组只用 NMG 的本地 hashing embedder 嵌入早／晚话语内容（不含节点名、scope 或 speaker label），然后为每个早期片段选出最相似的晚期片段。官方 speaker label 只在排序之后用于给 candidate 打分。另一个损害探针会强制合并发现的四个错误节点对并回滚；它绕过常规准入来测量污染和恢复，不是无人值守 actuation。构造的 proposal observation 不证明独立的自然确认。

## 结果

数据集：官方 LoCoMo `locomo10.json`（10 段对话）。

| 指标                                      |       结果 |
| ------------------------------------------- | -----------: |
| 同一人的早／晚 candidate                    |           20 |
| 同一人 candidate 获得资格                   | 20/20 (100%) |
| 跨人 candidate                              |           10 |
| 跨人 candidate 被拒绝                       | 10/10 (100%) |
| 在 `distinct_from` 之后撤回资格             | 20/20 (100%) |
| 仅凭内容发现的 candidate                    |           20 |
| 其中属于同一人的已发现 candidate            |  16/20 (80%) |
| candidate 发现 precision                    |          80% |
| candidate 发现 recall                       |          80% |
| 自然发现的错误 candidate                    |             4 |
| 强制合并时会共置的外来记录                  | 12（每个强制合并节点对 3 条） |
| 成功回滚的 false-merge 探针                 |    4/4 (100%) |
| 评估引起的拓扑变更                          |            0 |

所有跨人 candidate 都被 `scope_mismatch` 拒绝。结果写入 `evals/topology/results/latest.json`；确定性单元 fixture 独立于所下载的数据集检查同样的不变量。

## 解释与剩余风险

实验表明当前的 scope／冲突安全检查在自然对话身份上有效，且评估是可逆、只读的。仅凭内容的组也确立了一个真实的非 oracle candidate 基线：即便在两方对话中，20 个最近片段 candidate 里仍有 4 个是错的。把这四个错误节点对强行送入 journal 化合并路径，会在四个变换全部成功回滚之前，把 12 条跨人记录置于错误的共享身份节点之下。这是结构性污染度量，不是答案准确率分数。因此 candidate 相似度不能授权合并。它**并不**确立端到端 false-merge 率：

- 生产 gate 的 candidate 仍是注入的；发现组只衡量 blocking／排序，不提交也不 actuate proposal；
- LoCoMo 不含标注好的 homonym、身份纠正或含糊的 alias 链；
- 本 benchmark 中没有启用无人值守 actuator。journal 化的物理合并回滚由确定性 store／service 测试覆盖，包括在后续拓扑编辑后拒绝执行。上文四个强制错误节点对探针确实演练了物理回滚，但绕过了常规准入，不能证明从发现到 actuation 的无人值守安全性；
- 错误合并的成本仍需要一个真实使用的语料，或一个带自然生成 candidate 的专用实体解析数据集。

因此，无人值守的身份变更仍然关闭。
