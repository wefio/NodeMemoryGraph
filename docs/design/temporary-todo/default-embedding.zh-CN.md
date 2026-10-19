# 让 embedding 在 store 与 retrieve 上默认工作

[English](default-embedding.md) · [术语](default-embedding.terms.yaml)

**Authority:** [父级范围](../temporary-todo.zh-CN.md)。

## 让 embedding 在 store 与 retrieve 上默认工作

用户要求：embedding 必须在普通写入与检索路径上存在；本地哈希是兜底，不是替代品。观察到的失败：embedding 配置只放在仓库的 `.env` 里，而 daemon 从不读它，于是一次 daemon 重启就静默丢掉了 API key，之后每次检索都退回词法，而操作者以为 embedding 是开着的（`embedding_index_state.status = "failed"` 出现在一次免费额度的 429 之后，
`last_succeeded_at = null` → 检索永远走词法）。配置的 provider 确实在 2026-09-01 建了 96 个向量，然后再没跑过。

- [x] 在每次 remember/search 上触发一次有界 embedding 排空（不做
  writeThreshold/accessThreshold 批处理）：每个操作在后台补一小批缺失向量，因此低活动 store 仍会收敛，而一次 429 只是把剩下的排到下一次操作。
  （`syncEmbeddingTarget` `maxBatches`，`#drainEmbeddings` 在 remember/search 每次 `#signalMaintenance` 时以 `{ maxBatches: 1 }` 触发。）
- [x] 把 provider 限流／瞬时失败当作*暂停，而不是失败*：429/5xx 不得把整个索引置为 `failed`（那会一直禁用 hybrid 直到完全重建）；记录 `last_failed_at` 加原因，并在下一次排空时恢复。只有持久性（非限流）失败才降级。
  （检索现在从*部分*索引提供 hybrid——`LEFT JOIN` 保住词法结果，同时已索引记录获得向量增益——所以失败／429 的索引绝不是死路；排空会在后续操作重试。provider 失败还会启动 30 秒冷却，使一个宕掉的 provider 不会挂住每个查询；检索报告 `degraded: true` 并附原因。）
- [x] 在没有外部向量时用本地哈希降级检索——**已评估并关闭：不做。** 当前兜底降级为纯词法并带 `degraded: true` 加原因，这就是预期的终态。本地哈希混合被测量并拒绝：在真实 store 上，256 维
  `nmg-hashing-v1` 混合检索与纯词法逐字节相同（自召回两条臂都是 45/154；向量分数 ≈ 0），与已发表的低维哈希向量维度瓶颈一致。已知的修法——NUMEN 式极高维度（16K–32K）击败 BM25——每条向量都要付巨大的固定内存，对一个本地、SQLite 支撑的 store 不可接受。特征哈希／SimHash 是词级工具（拼写、近似去重），不是语义检索。见被拒绝的决策记录（2026-09-03-hashing-vector-retrieval-fallback）。
- [x] 去掉 `NMG_EMBED_AUTO_SYNC` 门：存在已配置的 provider（＋key）就意味着自动同步。保留该环境变量作为显式*禁用*开关。
- [x] 在部署层持久化 embedding 配置（用户级环境变量／有文档的 daemon 启动方式），使重启后 provider ＋ key 仍在；在拥有它的指南／ADR 里记录这一点，而不是发明新的配置文件机制。
  （用户环境变量于 2026-09-03 设置；daemon 重启后保持 `provider: gemini` ＋
  `indexId` ready。）

**可用机制：** 写入与访问路径已经 `signalMaintenance`
（`src/cli/service.ts` 的 #remember/#search）；`#drainEmbeddings` 已经按 SQLite 缺失向量队列增量跑 records→leaves→nodes
（`embeddingDocuments` 带 limit，batch 64）；每条记录已携带
本地哈希向量（`memory_embeddings` 模型 `nmg-hashing-v1`，327 行）；
`searchMemoryContext` 已有词法兜底接缝与
`degraded/reason` 返回形状；`embedding_index_state` 已跟踪
running/ready/failed 与 `last_error`。

**实施前的阻塞（已由上方勾选项解决）：** 排空被维护阈值门控（16 次写入／32 次访问），所以低活动使用永远不收敛；一次 429 就把索引标为 `failed` 且没有暂停再恢复；而没有那个环境变量时，已配置的 provider 在 daemon 重启后就静默消失（操作者的真实事故）。业界实践印证这个方向：写后异步 embedding 配后台队列与自动语义检索升级
（mcp-memory-ts），以及只在*持久性*失败时降级、带不可用原因与兜底路径的 provider 生命周期
（openclaw #94240/#101272）。

**实施前记录的验收条件：** 在配置了 provider 的情况下，一次新的 `remember` 在一个操作周期内产出可检索向量，随后一次 `search` 报告 hybrid；模拟的 429 暂停排空且 `status = failed` 不出现，下一次操作恢复它；没有 provider（或 provider 宕掉）时，检索降级为词法并带 `degraded: true` 与显式原因；而带持久化配置的 daemon 重启保持 embedding 启用（针对真实 store 验证）。上方勾选项记录实施状态；本次审阅未独立复验每项端到端条件。
