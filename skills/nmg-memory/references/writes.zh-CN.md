# 持久写入

[English](writes.md) · [术语](writes.terms.yaml)

## 事实、偏好、约束与策略

```text
nmg remember "<statement>" \
  --node "<stable semantic node>" \
  --type fact \
  --actor user \
  --evidence "<short exact source excerpt>" \
  --recall-trigger "<short alias or likely future query phrase>" \
  --write-reason "<why it remains useful>" \
  --json
```

如果 Agent 使用方式更符合偏好、约束或策略，就选 `preference`、`constraint` 或 `strategy`，不要选 `fact`。

`--recall-trigger` 可选且可重复。只有当简短、精确的别名或可能的未来问题能比规范表述更可靠地找到同一事实时才使用。它是路由元数据，不是另一条事实：不得放入新声明、宽泛主题标签、秘密或完整陈述。Pi、MCP 和 DSH 的 `nmg_remember` 工具将同一字段暴露为 `recallTriggers`（最多 16 项，每项最多 80 个字符）。

## 可变状态

使用 `--type state` 和稳定的 `--state-key`。Key 标识属性，而非其当前值、日期、主题、节点、项目或分组。相同规范 scope 与 state key 的两次写入表示“同一个单值属性的连续取值”；较新的写入会自动取代旧值。

区分以下三个标识符：

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `--node` | 可容纳多条相关记忆的语义聚类 | `pi-lsp environment` |
| `--scope` | 记忆适用的范围 | `project=pi-lsp` |
| `--state-key` | 该 scope 中唯一可替换的属性 | `pi-lsp.installation.path` |

不要用像 `pi-lsp-env` 这样宽泛的 key 同时表示安装路径、工具清单、patch 策略和 symbol-provider 机制。这些事实可以共享节点和 scope，但只有可分别变化的属性才应该是 state key：

```text
pi-lsp.installation.path
pi-lsp.patch.survives_update
pi-lsp.workspace_symbol.provider
```

若记录不是一个可替换的单值，就使用 `fact`、`constraint` 或 `event`，不要设置 state key。

```text
nmg remember "Atlas currently uses SQLite." \
  --node "Atlas storage" \
  --type state \
  --state-key "atlas.storage.engine" \
  --scope project=atlas \
  --evidence "We switched Atlas to SQLite." \
  --write-reason "Current project architecture" \
  --json
```

以相同 key 和 scope 写入新状态时，会自动取代之前的活动状态（同一 `state_key + scope`）。

## 事件

对已发生的事情使用 `--type event --event-time <ISO_TIME>`。如果该事件也改变当前状态，则分别写入事件和状态。

## Open、resolved 与 reopened 结构

对可归因、尚未解决的问题、阻塞的决策或必须跨 session 保持可达的可复用近失事件，使用 open 记录。它必须指向同一 store 中至少一条现存记忆：

```text
nmg remember "Verify Atlas on the remaining target platform." \
  --node "Atlas portability follow-up" \
  --type event \
  --resolution open \
  --related-memory <ATLAS_STORAGE_MEMORY_ID> \
  --write-reason "Unresolved release blocker" \
  --json
```

Open 和 reopened 记录继续保留在索引中，并免于基于热度的保留处理和 STG 到期清理。只有在明确证据支持时才关闭或重新打开：

```text
nmg resolve <MEMORY_ID> --reason "The target platform test passed" --json
nmg reopen <MEMORY_ID> --related-memory <ANCHOR_ID> \
  --reason "A new target platform was added" --json
```

这些状态迁移会被审计，不会删除或改写来源历史。不要用 open 状态保存原始 chain-of-thought、普通工具错误或泛化的任务清单。

## 高级选项

| 选项 | 用途 |
| --- | --- |
| `--event-time "<ISO>"` | `--type event` 必需；事件发生时间 |
| `--supersedes "<MEMORY_ID>"` | 显式取代旧记忆，但不删除其证据 |
| `--residence ltg` | 长期：持久、共享、正常可见（默认） |
| `--residence stg` | 短期：暂定、任务局部，按策略过期 |
| `--project-dir <DIR>` | 在该项目的隔离 store 中放置／读取 `stg` 记录 |
| `--scope key=value` | 可重复；与 search 的 `--scope` 过滤配合 |
| `--evidence-role support|contradict|...` | 构建多证据记忆：第二条记忆用 `contradict` 时，会将反证加入同一证据链 |
| `--truth unverified` | 未经用户或工具验证的 Assistant 输出 |
| `--valid-from` / `--valid-until` | 记忆有效时间范围 |
| `--expires-at` | 硬性过期时间（例如临时事实） |
| `--source-ref` | 工具或文件来源的引用 |
| `--external-source web:URL|file:PATH` | 标记外部来源；默认 trust 为 `unverified` |
| `--retrieved-at` / `--content-hash` | 外部来源的获取时间与可选摘要 |
| `--write-reason` | 为什么此写入仍有用；会出现在搜索结果中 |
| `--resolution open|resolved|reopened` | 未解决结构的生命周期状态 |
| `--opened-at` | 可选的 open 时间；默认是写入时间 |
| `--related-memory ID` | 可重复的锚点；open/reopened 记录必需 |

完整 `--actor` 取值集合为 `user`、`assistant`、`system`、`tool`。

## Claim outcome 与 STG 巩固证据

只有当可独立归因的用户消息、工具结果、已完成任务或基准明确支持或反驳一条已保存声明时，才记录 outcome：

```text
nmg claim outcome <MEMORY_ID> \
  --outcome supported \
  --source tool \
  --source-lineage "tool-result:<stable-id>" \
  --semantic-task-id "task:<stable-id>" \
  --active-graph-id <AG_ID> \
  --json
```

可重复传入 `--claim-index` 选择原子声明；省略时将 outcome 应用于记录的所有声明。`--active-graph-id` 可选，但若传入，它表示该记忆曾由该 session 所属的 AG 暴露。Pi 适配器将同一操作暴露为 `nmg_remember action=claim_outcome`。对 user/tool outcome，应在 `evidence` 中传入最短的精确支持或反驳摘录；Pi 会绑定真实消息 ID，并忽略伪造的 lineage。对已完成任务的 outcome，传入稳定的 `claimSourceLineage` task ID。

这与 retrieval feedback 刻意分开。被检索、被 Agent 引用、任务完成、保持沉默或没有纠正都不构成对 claim 的支持。稳定的 `source-lineage` 和 `semantic-task-id` 可防止把同一个来源或重复回合算成多份独立投票。

## 删除记忆

```text
nmg memory delete <MEMORY_ID> --json
```

`memory delete` 只删除语义解释，保留不可变的历史证据。

## 证据规则

- 优先使用简短、精确的用户或工具摘录。
- `sourceActor` 标明证据由谁产生，不代表 Agent 希望谁具权威性。在 Pi 适配器中，省略 actor 会安全地默认为 `assistant`；要声明 `user`、`tool` 或 `system`，必须有匹配的精确 session 摘录或明确外部来源。绝不把 Assistant 推断重新标为用户陈述。
- 对未验证的 Assistant 输出记忆，使用 `--truth unverified`。
- 将需要独立计数的事件或义务分开保存。
- 存储有歧义的敏感信息前先询问。绝不存储凭证。
