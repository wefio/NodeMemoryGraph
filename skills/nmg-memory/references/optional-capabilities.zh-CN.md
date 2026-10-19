# 可选能力手册

[English](optional-capabilities.md) · [术语](optional-capabilities.terms.yaml)

当某项功能已经实现、但不属于默认 Lite 路径时阅读本参考。环境变量在 Pi 或 daemon 启动时读取；修改后应重启相应进程。开关只让机制可用，不会把基准证据变成生产授权。

日常 AG 工作状态与 Task Board 操作使用统一的 `nmg_state` 入口，而不是 Lab 工具。[状态空间合同](../../../docs/design/state-spaces.md)拥有这些接口。下文的 `working_state` Lab 能力描述其租约／管理兼容路径；这不是把普通状态更新路由到 Lab 的理由。

## 检索控制

| 能力 | 默认值 | 启用方式 | 边界 |
| --- | --- | --- | --- |
| QPP1 分配 | `shadow` | `NMG_QPP1_MODE=active` | 仅影响 Pi 显式搜索；调用者提供的 `limit` 优先。 |
| QPP2 渐进折叠 | `off` | `NMG_QPP2_MODE=active` | 在 AG 中保留 top-1 和折叠 ID；`NMG_QPP2_RETAINED_MASS` 默认为 `0.98`。 |
| 搜索建议 | `off` | `NMG_SEARCH_RECOMMENDATION=advisory` 或 `guardrail` | `guardrail` 仅在硬性召回失败时建议搜索。 |
| 确定性 Fibonacci pass | 显式调用 | `nmg search "..." --second-pass` | 对一个过采样候选池重新选择；不会进行第二次向量搜索。 |
| 顺序存储层披露 | 显式调用 | `nmg search "..." --tiered-disclosure` | 先打开 L0，再在确定性 QPP 判定证据不足时逐步打开更深层。 |
| 完整 warm 窗口 | folded | `nmg search "..." --full-warm` | 诊断覆盖；正常应使用 `nmg get` 加载延迟 ID。 |

启用 QPP active 模式前，先观察 shadow 结果：

```powershell
$env:NMG_QPP1_MODE = "shadow"
$env:NMG_QPP2_MODE = "shadow"
$env:NMG_SEARCH_RECOMMENDATION = "off"
pi
```

## 学习型控制器

`NMG_CONTROLLER_RUNTIME_MODE=off|shadow|controlled|active`，默认值为 `shadow`。

- `off`：不使用学习型评分。
- `shadow`：只评分和记录；不能重排、分配或折叠。
- `controlled`：要求已训练的 `NMG_CONTROLLER_RUNTIME_STATE`，以及 `NMG_SHADOW_COLLECTION_ORIGIN=controlled`。
- `active`：还要求 `NMG_CONTROLLER_ACTIVATION_RECEIPT`。Receipt 必须将候选哈希和特征协议绑定到通过的检索、控制器、产品 gate 产物，以及一个不同且可加载的回滚状态。产物缺失或发生变化时 fail closed。

`NMG_CONTROLLER_RERANK=active` 仅声明允许使用重排，不会绕过上述运行时通道。

## STG 与拓扑维护

自动 STG 到 LTG 的 consolidation 默认关闭：

```powershell
$env:NMG_STG_AUTO_CONSOLIDATE = "1"
$env:NMG_STG_CONSOLIDATE_MIN_VOTES = "3"
$env:NMG_STG_CONSOLIDATE_MIN_MEAN = "0.75"
$env:NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND = "0.5"
```

从 LTG 自动将项目工作集缓存到 STG 也默认关闭：

```powershell
$env:NMG_STG_AUTO_SYNC = "1"
$env:NMG_STG_AUTO_SYNC_LIMIT = "20"
$env:NMG_STG_AUTO_SYNC_INTERVAL_SECONDS = "300"
```

仅当项目搜索携带非空 `scope` 时才运行。缓存行是无 session 的提示，标记为 `cached_from_ltg`；LTG 仍是权威来源。

自动身份合并默认关闭，并且有硬上限：

```powershell
$env:NMG_TOPOLOGY_AUTO_MERGE = "1"
$env:NMG_TOPOLOGY_AUTO_MERGE_LIMIT = "1" # 硬上限：4
```

在自然产生的错误合并证据足够之前，优先使用可审查路径：

```text
nmg topology proposals
nmg topology assess <PROPOSAL_ID>
nmg topology review <PROPOSAL_ID> --decision accept
nmg topology actuate <PROPOSAL_ID>
```

Edge consolidation 本身运行在有界语义维护中，采用保守的稳定性、冷却期和降级阈值。它没有单独的启用开关；单凭检索不能提升一条边。

维护策略候选项使用仅供审查的 CLI 通道，不会自动启用，接受也不会修改记忆：

```text
nmg maintenance propose --defect retrieval --maintenance-action observe \
  --target-memory <MEMORY_ID> --policy-id <ID> --policy-revision <REV> \
  --policy-hash <HASH> --policy-min-score 0.7 --score 0.8 \
  --evaluation-kind matched_replay --evaluation-ref <RUN_ID>
nmg maintenance proposals --status pending
nmg maintenance review <PROPOSAL_ID> --decision accept --reason "<review evidence>"
```

`rewrite` 还需传入 `--proposed-statement`。`rescope` 需传入一个或多个 `--scope KEY=VALUE`。内容和 scope 候选必须之后通过现有的显式维护命令应用；检索缺陷只能使用 `observe`，并属于检索策略校准。

## 可选的会话 Lab 能力

Lab 使用现有 daemon。启用前先发现能力：

```text
nmg lab list --json
nmg lab enable <CAPABILITY> --session-id <SESSION> \
  --requester agent:<NAME> --reason "<why ordinary NMG is insufficient>" --json
nmg lab status <CAPABILITY> --session-id <SESSION> --json
nmg lab invoke <CAPABILITY> --session-id <SESSION> \
  --operation <OP> --input-json '<JSON>' --json
nmg lab disable <CAPABILITY> --session-id <SESSION> --json
```

`nmg lab list` 是权威合同来源：它为每项能力返回 `id`、`summary`、`agentMayEnable`、`supportedScopes` 和 `operations`。调用 `invoke` 前必须读取该列表；不要猜操作名称。

### 启用规则

- 可由 Agent 自行启用的能力（`agentMayEnable=true`）：
  - `working_state`：租约管理通过普通 `nmg_state` 接口（`space=ag`）暴露；日常 replace／clear 由该接口拥有。Lab CLI/RPC 属于管理兼容路径，不是每日模型侧入口；
  - `reasoning_workspace`：会话私有的 scratch graph 和 checkpoints；
  - `memory_graph_reasoner`：只读可微遍历、模糊逻辑与 what-if 分析；
  - `controller_shadow`：记录控制器观察，不执行 actuation。
- `controller_controlled` 和 `controller_active` 的 `agentMayEnable=false`，Agent **不得自行授权**；它们需要独立的 harness/operator 授权和既有激活 gate。不得尝试绕过拒绝。
- 租约按 session（`--session-id`）作用域，并在启用 TTL 后过期。Lab 输出是 scratch／实验材料；除非之后通过受治理的 `remember` 调用单独准入，否则它不是持久事实。

### `working_state` 操作

它是在现有私有 AG 中的一份当前文本，不是 reasoning scratch graph，也不是 STG/LTG。使用 `nmg_state(action="write", space="ag", operation="enable", reason="…")` 显式租用写入权限；然后调用 `operation="replace", text="<complete current state>"` 或 `operation="clear"`。不接受 frame、permission、schema 或 patch 字段。常驻 daemon CLI 等价命令：

```text
nmg state write ag enable --session-id <SESSION> --reason "<why>" --json
nmg state write ag replace --session-id <SESSION> --text "<complete current state>"
nmg state read ag --session-id <SESSION>
nmg state write ag clear --session-id <SESSION>
nmg state write ag disable --session-id <SESSION>
```

[状态空间合同](../../../docs/design/state-spaces.md)拥有共享 AG／board 接口和旧版管理兼容路径。保留必要的精确值、约束、来源引用与 hypothesis 标签；仅在当前状态确实改变时写入。不得放入秘密或隐藏 chain-of-thought。状态维护不能认证事实、任务成功或协作验收。

普通工具／CLI 文本只会返回 `updated`、`unchanged` 或 `cleared`；JSON 保留标准 RPC envelope。Owner 执行 resident 与 prepared-text 上限，超限时拒绝而不截断，并在失败时保留旧值。禁用或过期会撤销写入租约，但不会删除文本。状态在 visibility clearing 后仍存在；frame/session 驱逐、release 或 daemon 重启则会移除状态。

当前适配器在租约有效时使用显式的**会话工作 frame**：查询变化不会迁移它。这不代表语义任务检测，也不保证 A→B→A 恢复。普通客户端在传输前于模型输入之外捕获 binding，重试时不刷新它；迟到的操作不能借用重新启用的租约或重建的图。原始 RPC／library 调用者必须自行提供捕获的元数据。Binding 隔离上下文变化，不是身份认证。

Pi 通过独立的[携带合同](../../../docs/decisions/implemented/2026-10-08-ag-working-state-input.md)，在每个用户回合将状态携带一次，放入持久化的 turn message；它没有注册逐推理注入，最终 provider 确认仍不受支持。状态写入或用户视图都不能证明披露、验收、模型连续性或成本节省。另见[工作状态决策](../../../docs/decisions/implemented/2026-10-08-ag-working-state.md)。

### 日常工作状态

持续多步工作时，使用共享 Agent 协议 [`memory_policy`](../../../src/prompts/nmg-prompts.yaml)，不要依赖历史搜索找回当前步骤。选择、精简和修正快照内容时，使用[工作状态维护 Skill](../../working-state-maintenance/SKILL.md)。

启用 AG writer，再通过 `nmg_state` 或上面的常驻 daemon `nmg state write ag` CLI，用完整当前文本替换。文本仍是临时状态；进度事实由引用的任务／仓库证据负责。重启后缺失的状态只能根据那些证据重建，不能从缓存显示恢复。

Pi 展示与携带使用同一快照的只读 widget。它会在启动／重载及 state 工具返回时刷新，不执行空闲轮询、不额外搜索，也不会每次模型调用读取 snapshot。Widget 预览六行来源文本；超过时明确提示使用 `/nmg state`。`/nmg state` 读取并通知全部获准文本；`/nmg state on|off` 只切换预览，不写入状态、携带内容或模型／session 历史。这两个动作都属于 `/nmg` 交互菜单，因此没有顶层 `/nmg-state` 命令。带通知 UI 的 RPC 客户端无需终端 widget，也可以使用该命令。Owner 读取失败时显示 unavailable，而不是旧进度；过期或切换 session 的响应会被忽略。任务完成后禁用 writer 租约但保留最终状态供读取；只有明确要丢弃状态时才清除。

### `reasoning_workspace` 操作

面向多步推理和压缩恢复的会话私有、可审计 scratch graph。每个节点有一个 `kind`。已确认的 `kind` 值：`goal`、`observation`、`hypothesis`、`evidence`、`conclusion`、`decision`、`open_question`、`next_action`。

| 操作 | 必需输入键 | 返回值 | 状态 |
| --- | --- | --- | --- |
| `add` | `id`、`kind`、`content` | 节点 `{id, kind, content, status, importance, evidenceRefs, createdAt, updatedAt}` | 已验证运行 |
| `link` | `sourceId`、`targetId`、`type` | `{sourceId, targetId, type, createdAt}` | 已验证运行 |
| `checkpoint` | `label`（可选） | snapshot `{sessionId, nodes, edges, omittedNodes, text}` | 已验证运行 |
| `update` | 节点 ID 和字段 | 节点 | 未重新验证 |
| `mark_compacted` | session | 压缩标记 | 未重新验证 |
| `consume_checkpoint` | session | checkpoint 消费结果 | 未重新验证 |
| `clear` | session | 已清除的 workspace | 未重新验证 |

`link` 使用 `sourceId`／`targetId`／`type`，不是 `from`／`to`／`relation`。`checkpoint` 输出含可直接注入的 `text` projection；把它当作可审计 scratchpad，而不是已验证事实。

```text
nmg lab invoke reasoning_workspace --session-id <SESSION> \
  --operation add --input-json '{"id":"n1","kind":"hypothesis","content":"..."}' --json
nmg lab invoke reasoning_workspace --session-id <SESSION> \
  --operation link --input-json '{"sourceId":"<id>","targetId":"<id>","type":"supports"}' --json
nmg lab invoke reasoning_workspace --session-id <SESSION> \
  --operation checkpoint --input-json '{"label":"step-1"}' --json
```

### `memory_graph_reasoner` 操作

针对**调用者提供的**记忆向量执行只读可微推理。它不会查询 LTG store；每次调用都必须传入图。图节点格式为 `{id, vector, requires?, outgoing?}`，其中 `vector` 是 **L2 归一化的数字数组**（不是查询字符串）。Daemon 会将 JSON 节点数组转换成内部的 `Map<id, node>`。

| 操作 | 必需输入键 | 返回值 | 状态 |
| --- | --- | --- | --- |
| `traverse` | `queryVector`、`graph`、`maxSteps` | `{path:[{nodeId,score,queryBefore,queryAfter,gate}], finalQuery, pathScore}` | 已验证运行 |
| `logic_search` | `expr`、`graph`、`topK` | `[{nodeId, membership, atomScores}]`（按 `membership` 排序） | 来自源码（`logicSearch`） |
| `what_if` | `queryVector`、`graph`、`hypotheticalNode`、`maxSteps`（以及 `impactThreshold`） | `{baseline, withNode, impacted:[{nodeId, scoreBefore, scoreAfter, delta, pathChange}]}` | 来自源码（`whatIf`） |

- `queryVector` 必须是非空、所有值有限的数字数组（否则返回 `queryVector is required`）；它是遍历锚点。
- `graph` 是 JSON 节点对象数组（必须满足 `graph must contain between 1 and 10000 nodes`）。
- `traverse` 从全局最佳起始节点开始贪心前进；每一步的 `queryAfter` 成为下一步的 `queryBefore`。
- 任意节点声明 `outgoing: string[]` 后，全局起始节点之后的遍历受拓扑约束：后续每一步必须沿前一节点的有向 outgoing 边。空数组会终止该路径。省略 `outgoing` 时使用全局（旧版）遍历。
- `logic_search` 接受模糊 `expr`：`{kind:"atom", queryVector}`、`{kind:"and"|"or", children:[...]}` 或 `{kind:"not", child}`（也提供可组合的 `nand`／`xor` helper）。每个结果含 `membership`（范围为 (0,1) 的组合隶属度）和用于解释的逐原子隶属度 `atomScores`。
- `what_if` 注入 `hypotheticalNode` 并比较前后遍历（`impacted` 列出得分变化超过 `impactThreshold` 的节点；默认 `0.05`）。

```text
nmg lab invoke memory_graph_reasoner --session-id <SESSION> \
  --operation traverse --input-json '{"queryVector":[0.8,0.2],"maxSteps":3,"graph":[{"id":"a","vector":[1,0],"outgoing":["b"]},{"id":"b","vector":[0,1]}]}' --json
```

### `controller_shadow`

单一 `observe` 操作：记录控制器决策但不改变产品检索。它是只读诊断，不执行 actuation。

## ANN 索引

ANN 仍为可选项，因为 exact scan 是产品基线。满足可选 `usearch` 依赖并配置 embedding provider 后，可以运行：

```powershell
$env:NMG_DB_PATH = ".nmg/nmg.sqlite"
$env:NMG_ANN_PATH = ".nmg/indexes/qwen3.usearch"
$env:NMG_ANN_TARGET = "leaves" # leaves | nodes | records
$env:NMG_ANN_BATCH_SIZE = "512"
npm run index:ann
```

构建索引不会自动替代 exact retrieval。只有在目标 store 上测得 recall／latency 交叉点后，才提升 ANN 路径。
