# 边稳定性与结构性合并

[English](edge-stability-and-structural-consolidation.md) · [使用的术语](edge-stability-and-structural-consolidation.terms.yaml)

**Authority:** [父级范围](../active-graph-activation-and-consolidation.md)。

### 边稳定性与结构性合并

边稳定性比激活变化更慢，它估计一条关系是否在独立上下文中反复有用：

```text
S_e(t+1) = decay * S_e(t)
         + alpha * cross_task_usefulness
         + beta  * independent_recurrence
         + gamma * user_or_tool_verification
         - delta * contradiction_or_failure
```

仅重复检索不得提升稳定性。否则一条偶然的检索边会形成反馈回路：它导致共检索，共检索强化同一条边，从而带来更多共检索。有用的观察应按会话／任务／来源 lineage 去重，并在其仅仅由正在被评估的候选边造成时予以折扣。

临时与推断边遵循显式生命周期：

```text
ephemeral -> observed -> candidate -> consolidated
                         |             |
                         `-> rejected  `-> LTG typed relation
```

只有当局部子图满足最小独立证据、有用性、作用域一致性、provenance 覆盖率、冲突与稳定性阈值时，才有资格进入 LTG 物化：

```text
consolidate(G') iff
  stability(G')       >= high_threshold
  independent_tasks   >= min_tasks
  evidence_coverage   >= min_coverage
  observed_utility    >= min_utility
  unresolved_conflict <= max_conflict
```

合并使用滞后：降级或重开所需的阈值低于晋升阈值，从而避免反复的晋升／降级振荡。该操作带版本、可审计、保留证据，且必须能通过从历史重建语义投影而回退。稳定的共激活支持一条关系；它本身并不证明某项事实主张。

原子记忆晋升与结构性合并保持分离。清晰的事实、偏好、约束、状态或显式 remember 请求可以立即进入 LTG。新关系、派生概念、聚合策略以及节点合并／拆分需要上述更强的稳定性过程。

由于 Pi 会话 STG 与共享 LTG 是物理上分离的 SQLite store，改变某一行的 `residence` 标志并不是跨 store 合并。因此运行时把合并视为一个显式物化步骤：

```text
independently attributable claim outcomes
  -> per-claim posterior eligibility
  -> STG consolidation candidate (shadow by default)
  -> exact evidence + semantic record copied into LTG
  -> LTG remember/dedup transaction
```

检索频率、重复渲染与沉默永远不能让一条记忆合格。在这条基于后验的合并路径中，每一条原子声明都必须通过最小独立票数、后验均值与保守下界门禁。被复制的 LTG 记录携带指向其来源记忆的 `consolidated_from_stg` 标记；LTG 的精确同作用域去重使中断后的重试幂等。自动执行被有意默认禁用，且需要 `NMG_STG_AUTO_CONSOLIDATE=1`；候选报告仍在 shadow 中可用，以便先测量自然使用中的精确率与可逆性。

Claim 结果通过显式、可归因的边界进入，而不是普通检索反馈。Pi 暴露 `nmg_remember action=claim_outcome`，与 agent 无关的 CLI 暴露 `nmg claim outcome`；两者都要求语义任务 ID、`supported|contradicted`、来源类别与稳定来源 lineage。可选的归会话所有的 Active Graph 会把投票限制在该次检索实际暴露的记录上。检索、精确 `get`、答案复用、沉默与笼统的任务成功永远不会产生正向 claim 票。这套接线使后验收集在普通使用中成为可能，同时不削弱晋升门禁。当 Pi 接纳一次用户／工具结果时，它验证一段精确的当前会话摘录，并把该摘录作为去重后的 `HistoryRecord` 存储；结果事件保留其 `evidenceId`。因此移除或压缩 Pi transcript 不会留下一个仅由悬空消息 ID 支撑的后验票。任务与 benchmark 票可以保留 lineage 而不复制任意生成文本。

物理分离还意味着新的 STG 状态无法以事务方式把更早的已合并 LTG 状态标记为被取代。因此运行时 STG/LTG 投影会调和具有同一规范 `stateKey + scope` 的活动记录，只暴露最新的事件／有效／创建时间版本；完全相同时 LTG 胜出。时间过滤在调和之前应用，从而为历史查询保留较旧状态。这一确定性当前状态不变量不同于后验合并撤回：单次权威更新不必等待若干矛盾结果票，陈旧状态才消失。

原子生命周期还有一条显式反向路径。晋升使用严格的票数／均值／保守下界门禁；已经物化的副本在其满足更低的保留均值与保留下界阈值期间保持活动。一旦它跌破该滞后门禁，NMG 只逻辑撤回那条 `consolidated_from_stg.sourceMemoryId` 与 STG 来源匹配的活动 LTG 行。手工的或既有的 LTG 重复项不携带这种所有权标记，无法被 STG 反馈撤回。重新合格会创建新的 LTG 版本，而不是复活被撤回的解释。当前冷启动阈值与 LoCoMo 官方证据覆盖率／反转审计记录在 `consolidation-evaluation-2026-08-09.md` 中；自动执行仍然关闭，因为该数据集没有权威的误晋升标签。

身份维护使用更严格的边界。重复的 `same_as` 判定在一个待处理提议上累积观察与 provenance。只读自动化评估要求：一个待处理身份提议、至少五次观察、平均置信度至少 0.98、活动证据记忆总计至少四条，且每个节点至少有一条；证据作用域完全相同，且没有待处理的 `distinct_from` 或 `contradicts` 提议。身份证据必须来自用户或工具来源，且两个节点必须至少共享一个来源 actor 类别；由 Assistant／系统撰写的身份猜测与不相交的 provenance 类别不能驱动自动合并。作用域必须恰好暴露一个非空身份值，且其规范化规范名称不得已经属于某个活动节点。通过该评估默认只是获得资格：除非设置 `NMG_TOPOLOGY_AUTO_MERGE=1`，自动执行 fail-closed。被显式启用时，语义维护默认每轮至多执行一个合格的 `same_as` 提议（可用 `NMG_TOPOLOGY_AUTO_MERGE_LIMIT` 配置，硬上限为四），把变换 ID 与任何执行错误记录在提议上，并使用既有的可逆合并日志。不确定的拆分与合并提议保持待处理，等待显式审阅。

首次自然对话门禁审计记录在 `topology-gate-evaluation-2026-08-09.md` 中。在 LoCoMo 说话人身份上，注入的 20/20 同人早期／晚期候选通过，注入的 10/10 跨人候选被作用域拒绝，全部 20 个合格候选在一个竞争的 `distinct_from` 提议之后失去资格，且评估造成零次拓扑变更。这验证的是门禁及其可逆提议状态，不是自动候选生成、别名解析或端到端误合并成本。可选的执行器与物理回滚现在有确定性覆盖；自然误合并与反转证据仍是默认启用它的前提。

`matched-evaluation-2026-08-09.md` 中的匹配产品探针也没有发现图适配相对 NMG Lite 的答案质量优势（两者均为 5/7），而 Graph 做了额外的检索工作。这个小结果是一个产品门禁，不是普适的 benchmark 主张：图适配仍然仅限 Lab，且无人值守的拓扑变更保持禁用，除非更大规模的匹配评测显示出可复现的收益。

#### 边强度不是一个标量

NMG 不得用单一的「粗细」值同时表示真值、习惯性访问与当前注意。已有理论支持三个正交量：

1. **置信度**是对该带类型关系在其时间与作用域内有效的、有证据支撑的信念。支持与反对的独立来源 lineage 更新一个 Beta 后验 `(confidence_alpha, confidence_beta)`。事实性边使用保守的后验下界作为门禁。
2. **有用性／稳定性**估计遍历该边是否在独立语义任务中反复有帮助。一个独立的 Beta 后验记录有用与已扩展但未被使用两种结果；ACT-R 风格的时近性／频率基准水平可以概括重复的成功观察。
3. **激活**对单个 AG 私有，且衰减很快：

   ```text
   activation_e(t) =
     previous * exp(-lambda * delta_t)
     + eta * activation_source * activation_target
     + zeta * successful_current_path
   ```

   外向激活被规范化并有预算裁剪，遵循 Oja/BCM 的稳定化教训，而不是无界的 Hebbian 增长。

共激活或共检索只能创建一条候选的联想 `related_to` 边。没有显式证据时，它不能建立 `causes`、`depends_on`、`constraint`、取代关系或其他强有向关系。每次持久置信度更新都必须保留 W3C PROV 风格的 source/activity provenance，并按来源 lineage 去重被复制或反复引用的证据。

运行时可以组合这些值而不覆盖它们：

```text
route_score =
  type_match
  * query_relevance
  * usefulness_lower_bound
  * factual_confidence_gate
  * (1 + mu * private_AG_activation)
```

罕见的固定（pinned）或安全关键约束豁免于访问频率降级。在 UI 中，route score 可以暂时控制渲染的行宽，但存储模型把置信度、有用性／稳定性与激活保留为彼此独立的轴。

该模型借鉴了
[ACT-R base-level and spreading activation](https://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/39jra_cds_2000_a.pdf)、
[Collins–Loftus spreading activation](https://doi.org/10.1037/0033-295X.82.6.407)、
[Oja-style normalized Hebbian learning](https://users.ics.aalto.fi/oja/papers.html)、
[temporal tie decay](https://arxiv.org/abs/1906.09394)、
[uncertain knowledge-graph confidence](https://doi.org/10.1609/aaai.v33i01.33013363)
与 [W3C PROV-O](https://www.w3.org/TR/prov-o/)。这些是设计来源，不是「所提议的组合已经改善 NMG 检索」的证据。
