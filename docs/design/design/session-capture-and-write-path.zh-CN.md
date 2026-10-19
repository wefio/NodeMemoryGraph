# 会话捕获与写入路径

[English](session-capture-and-write-path.md) · [使用的术语](session-capture-and-write-path.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 会话捕获与写入路径

完成的 Pi turn 不会被自动复制。Pi 仍是其完整会话历史的所有者。在一次被接受的 `nmg_remember` 期间，适配器可以把 LLM 选中的证据解析到活动的 Pi 分支上，并只保留那段精确摘录，附上稳定的 `(session_id, source_message_id)` provenance。因此 NMG 存储的是受治理证据，而不是累积的 transcript 快照。未来的 `HistoryProvider` 边界可以为没有持久历史的宿主解析其他引用，或提供受管副本。

会话存储与语义抽取是分开的：

```text
Pi message/turn
  -> turn-local pending evidence
  -> governed extraction/admission
  -> zero or more retained HistoryRecord excerpts
  -> zero or more governed MemoryRecord writes into STG
  -> optional immediate atomic promotion into LTG
  -> later evidence-backed structural consolidation
```

NMG 使用选择性历史准入，而不是复制每条 Pi 消息。一条消息正文在以下情况下成为持久 NMG 历史：它支撑一条被接受的记忆、它记录了一个显式用户保留请求、它保存一个决策或未解决义务、它捕获一个冲突／例外，或它包含不可复现的结果。否则 Pi 保留临时 transcript 所有者身份，NMG 不保留第二份正文副本。

准入有三种当前结局：

```text
reference  source/message identity only; body remains in the harness
excerpt    exact bounded source excerpt plus provenance
discard    no NMG history row
```

同一个稳定的 Pi 写入工具也暴露显式逻辑撤回：
`nmg_remember action=forget` 要求精确记忆 ID，且仅用于显式用户请求。NMG 把记录标记为已删除、把它从普通检索与派生索引中移除，并保留一个墓碑以供审计。CLI 等价物是 `nmg memory delete MEMORY_ID`。二者都不声称为物理隐私擦除；完整 provenance 与聚合信号擦除是一项独立的生命周期操作。

用户自有数据可以在不直接打开 SQLite 的情况下导出。`nmg memory export --json` 输出一个带版本的 `nmg.memory-export.v1` 包，含每条 MemoryRecord、其 MemoryNode，以及全部保留的 HistoryRecord 证据／provenance。默认 actor 过滤为 `user`；`--all-actors` 与 `--include-deleted` 显式扩大导出范围，使日常 Agent／工具材料与墓碑不会被意外包含。

默认 Pi 路径把一次成功的受治理 `nmg_remember` 写入视为正向准入信号。适配器把其精确 `evidence` 解析到当前 Pi 分支最近的有限窗口上，保留匹配来源中的原始大小写，并按稳定来源消息 ID 绑定 HistoryRecord。该投影契约带版本号 `pi.branch.v1`；不兼容的 Pi 消息形状会 fail closed 到自包含证据路径，而不是绑定错误的 provenance。长于确定性摘录界限的证据不会经此路径复制，应改用显式外部 artifact 引用。若来源无法解析，所提供的证据仍作为自包含的显式兜底。这样在 Pi 删除会话之后仍能保留被选中的证据，而不必付出保留普通对话的代价。

清晰、稳定的用户陈述事实、偏好、约束与可替换状态可以自动成为原子 LTG 记忆。它们不需要等待一个稳定的局部子图。歧义的、推断的、敏感的或仅当前任务相关的候选留在 STG、需要确认，或按策略过期。推断出的关系与派生概念需要重复的独立证据才能进行结构性合并。闲聊、凭据、密钥与未验证的模型主张不会成为已验证语义记忆。当「记住它曾被说过」有用时，Assistant 内容可以作为未验证的对话证据被保留。

### `remember` 作为语义维护边界

归因在宿主边界处 fail-closed。Pi 适配器把未指定的 `sourceActor` 默认为 `assistant`；被归因为 `user`、`tool` 或 `system` 的记录必须绑定当前会话中来自该 actor 的精确摘录，或携带显式外部 provenance。这防止 Agent 的推断在 Core 准入与合并之前悄悄获得用户权威。

`remember` 是语义判断与确定性存储之间那个刻意的 LLM 介入点。两侧责任不同：

| LLM / Agent | NMG core |
| --- | --- |
| 抽取一条自包含陈述；指定类型、actor、时间、作用域与重要性；可选地提供几个短词，未来很可能用它们召回同一事实；判断返回的候选是同一含义、真正被替换的旧值、相关概念，还是不同实体。 | 强制准入策略、稳定 ID、精确去重、作用域／状态不变量、provenance、事务、触发器上限、索引增量、版本历史与可逆图变更。 |

`recallTriggers` 是同一次受治理写入上的可选检索元数据，不是额外事实、标签或第二个记忆对象。当规范陈述的措辞可能不会被未来查询重复时，Agent 可以至多提供 16 个简短、互不相同的别名或可能的查询短语。NMG 把这些短语与记录一起归一化并索引，但绝不向回答 Agent 披露标记语法，也绝不让触发器改变真值、作用域、provenance、重要性或节点成员关系。规范陈述与证据仍是召回之后返回的内容。这有意借用了 Skill header/body 拆分中有用的部分：一个小的路由 header 可以找到精确正文，但它不会变成另一套指令系统。

```text
remember(statement, evidence, recallTriggers=[short alias, likely query phrase])
  -> validate and store one semantic record
  -> index statement + evidence + recall triggers
search(query)
  -> trigger text may nominate the record
  -> disclose only the canonical statement/evidence
```

触发器应当编码既有事实可能如何被询问，而不是宽泛主题词、对未来事实的猜测，或整条陈述的副本。缺省触发器是正常的：语义 embedding 与 FTS 仍在规范记录上运作。迁移期间旧的 `retrieveHint` 标记仍可读取，而新写入使用规范 `recall_trigger` 标记。

常规路径仍是一次调用。NMG 写入受治理原子，并只返回一小组有界的歧义近似重复或取代候选。当某个候选需要语义判断时，Agent 可以通过同一个 `nmg_remember` 工具提交第二阶段。首个已实现的解析是 `supersede`：Agent 指出新记录与陈旧记录；NMG 在应用带版本替换之前验证两条记录存在于同一 LTG 或归会话所有的 STG store 中且作用域完全相同。该写入幂等，并对每个版本强制恰好一个直接前驱与一个直接后继，防止反馈重试覆盖链上的某一环。检索可以用陈旧措辞作为锚点，但在披露之前会解析整条链并物化当前或所请求的 as-of 版本。仅相似性从不授权替换。

精确重复与稳定 `stateKey + scope` 替换仍是确定性的，不需要 LLM 往返。物理节点合并、拆分、删除与任意 SQL 变更不属于面向模型的 `remember`；它们需要更强的验证，并且仍是可逆的维护操作。这在保持小工具面的同时，让模型能力的提升可以改善语义组织而不把数据库不变量搬进 prompt。

工具输出与日志默认是临时的。NMG 在会话捕获期间不复制其结果正文。模型或用户可以经受治理的记忆／证据路径显式晋升一段有界精确摘录、一个不可复现的结果，或一个被请求的完整产物；被保留的证据保留其工具来源身份。成功的常规输出、构建日志与可复现的命令输出留在宿主历史中并遵循其保留策略。密钥与凭据永不自动晋升。

原始事件身份与内容存储是两件不同的事。重复事件可以保留各自不同的时间戳与 provenance，同时在未来的对象层共享一份按内容寻址的正文。精确哈希／身份去重对证据是安全的；基于 embedding 的语义去重保留给可变的记忆组织，且不得抹除不同的历史事件。

可替换状态使用稳定的语义 `stateKey` 加规范作用域。新的活动值取代先前的值而不删除历史证据。只有当新值使旧值不再当前时才复用该键；两个可以同时为真的值（例如个人最好成绩与目标）是彼此独立的属性，需要不同的键。

> `RememberInput.judgeDuplicates`（`DuplicateJudge`，`src/core/types.ts`）是一个已实现的 Core 注入点：精确、规范化与近似候选被确定性计算，随后一个基于 embedding 或模型的调用者可以返回经过验证的合并／取代决策。daemon 与适配器有意不跨 RPC 边界序列化回调；它们的受治理路径仍是上文描述的显式两阶段 Agent 解析。因此 judge 缺席时降级为候选，而绝不降级为隐式模型调用。
