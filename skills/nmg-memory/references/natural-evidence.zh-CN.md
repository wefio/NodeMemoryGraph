# 自然证据循环

[English](natural-evidence.md) · [术语](natural-evidence.terms.yaml)

当 NMG 应从普通 Agent 工作中改进时使用此流程。目标是让真实任务自然地产生可归因观察，而不是制造标签，或根据基准数据静默调整生产行为。

## 1. 启用被动收集

对普通交互式 Pi session，启用 shadow recorder，但不要改变检索行为：

```text
NMG_CONTROLLER_SHADOW=1
```

保持 `NMG_SHADOW_COLLECTION_ORIGIN` 未设置。无头探针、基准、脚本 smoke 和合成任务必须将其设为 `controlled`；不得为了让实验看起来像自然数据而移除该标记。适配器会自动记录有界检索特征、预算、候选项、成本、注入大小及 session/task identity。它不会根据沉默推断成功。

## 2. 保留可观察的证据链

真实任务进行时：

1. 正常搜索，并将返回的 `activeGraphId` 传给精确 `get` 调用。这样可以区分显示过的候选项与实际披露的证据。Pi 适配器可从有界、会话所属的搜索 trace 恢复被省略的 ID；其他 Harness 必须显式保留它。若有该 ID，Agent 仍应传入，不要依赖恢复机制。
2. 让任务正常进行。不要仅为创建训练样例而额外提问。
3. 结果可直接观察时，只记录已知字段：

   ```text
   nmg_remember action=feedback activeGraphId=<AG_ID>
     taskSuccess=true evidenceSufficient=true expansionUseful=false
     excessiveNoise=false noMemoryNeeded=false
   ```

4. 某条已保存声明得到独立支持或反驳时，使用 `nmg_remember action=claim_outcome`，并提供当前 session 用户消息或成功工具结果中的最短精确摘录。检索、复用答案、单独的任务完成、沉默和没有纠正，都不是 claim 证据。
5. 对重试和后续回合复用同一个稳定语义任务身份，避免一次对话被算成多份独立投票。

启用 shadow collection 后，Pi 可能在下一用户回合显示一次性提醒。提醒只包含 `get` 实际披露的记忆 ID，以及所属 Active Graph 和语义任务。仅有搜索预览不会触发 claim 审查。提醒是检查新证据的机会，不是推断 outcome 的许可。

不要因为 API 接受所有布尔字段，就把它们全部填满。例如：

- 用户明确纠正可以支持 `userCorrection=true`，通常也支持对上一答设置 `taskSuccess=false`。
- 成功测试或权威工具检查可以支持任务成功和 claim 支持。
- 没有投诉不能证明 `userCorrection=false` 或任务成功。
- 只有任务本身明确表明无需记忆时，才能设 `noMemoryNeeded=true`；搜索没有结果本身不够。

## 3. 审计，但不改变策略

在 NMG checkout 中定期运行只读汇总：

```text
npm run eval:natural-readiness -- --project-dir <REAL_PROJECT>
npm run eval:controller-shadow
npm run eval:controller-dataset -- --compact
npm run eval:natural-maintenance -- --project-dir <REAL_PROJECT>
```

先运行 `eval:natural-readiness`。它把其他只读视图合并成一份面向 Agent 的行动包，并可通过 `--out <FILE>` 持久化。其 `required`、`available` 和 `blocked` 操作说明下一步应收集或运行什么。它不会激活控制器候选、改变维护策略，也不会把空证据类别当作验证。只有行动包指出某个缺口需要诊断时，才运行组件报告。

将报告视为就绪合同：

- 数据集阻塞项指出缺少的标签、回放输入、已验证的 claim 归因或独立训练／验证组；
- `natural-maintenance` 报告自然 claim outcome、STG 后验、物化／撤回样例、身份提案、转换、回滚及明确的证据缺口；
- `controlled` 和 `legacy` 行可验证接线或保留审计历史，但永远不能满足自然就绪要求。

真实任务积累之后，或模型、prompt、embedding、检索、记忆分布发生重大变化后，再运行审计。不要每个回合都轮询，也不要把固定行数当作质量证明。

## 4. 仅在就绪后让 Agent 更新

如果 `eval:controller-dataset -- --compact` 没有阻塞项，则创建候选：

```text
npm run eval:controller-calibrate -- --compact
```

此命令会写入可回滚候选产物，但不会激活它。只有满足以下条件后，Agent 才可以更新控制器配置或已检入策略：

1. 候选与冻结基线已在留出的语义任务上比较；
2. 候选确实改变了预期检索决策；
3. 证据／答案充分性没有退化；
4. token、工具调用、深度和延迟成本仍处于硬边界内；
5. 已记录生效配置、特征版本、数据窗口、来源日志哈希、测试和回滚目标。

这些 gate 通过且存在仓库写入授权时，Agent 才可应用最小源码／配置更改，运行配对回归套件，并将其与候选产物一同提交或记录其不可变引用。若任一 gate 失败，则将候选保留为 shadow 证据，并维持当前策略。不要仅因样本数量增加就手工编辑 QPP 常量。

## 5. 维护学习需要更严格的证据

控制器已就绪不授权无人值守地将 STG 晋升到 LTG 或合并节点。

- 只有自然产生的支持与反驳 outcome 同时证明精度和可逆撤回能力后，才修改 STG-to-LTG consolidation。
- 只有存在自然 true-pair、同名 false-pair、作用域冲突、别名、source actor 和回滚案例后，才修改自动身份合并。
- 空类别和零个已观察失败表示缺少证据，不证明应放宽阈值。

即使这些缺口仍在，Agent 也可以改进审计工具或提出 shadow 候选，但必须保持对应生产执行器禁用。
