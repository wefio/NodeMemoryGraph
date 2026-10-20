# STG 独立存储

[English](stg-isolated-store.md) | [简体中文](stg-isolated-store.zh-CN.md) · [术语](stg-isolated-store.terms.yaml)

**状态：**当前架构；阶段标签为历史记录。**更新：**2026-08-13。相关：[Memory graphs](memory-graphs.zh-CN.md) §1／§3／§5、[外部来源设计](external-source-design.zh-CN.md)、design.md §1。

## 1. 问题

旧调用若不提供 `projectDir`，仍可使用共享 residence flag；现在带 project context 的 daemon、CLI 与 Pi 调用会路由到独立 store。旧实现让 STG 与 LTG 共用一个 SQLite database 和 `memory_records.residence` 标志，`expireShortTermMemories` 通过批量停用 `stg` 行实现过期。这与三图模型冲突：STG 是临时、任务／项目局部的语义生命周期，不只是 residence flag。

主要问题：跨项目 provisional memory 会污染检索；无法删除单个项目的临时状态而不影响权威 store；STG／LTG 同一 FTS pass 扫描，无法优先独立检索项目局部热点记忆。

## 2. 三种存储

```text
LTG（权威、共享、持久）          SQLite，共享位置
      │ 按使用复制（缓存子集）
      ▼
STG（项目局部、按 session 隔离） SQLite，项目目录
      │ query projection
      ▼
AG（每次 query 的记忆图）       RAM，query 结束释放
```

| 属性 | LTG | STG | AG |
|---|---|---|---|
| 位置 | shared store | `<project>/.nmg/stg.sqlite`；通过 `session_id` 行过滤隔离 | RAM |
| 权威性 | 唯一权威 | 局部 provisional + LTG cache 子集 | 派生 |
| 生命周期 | 持久 | session 生命周期逐行管理；项目清理可删除该项目 STG | 每次 query |
| 写入 | governed、持久 | 本地快速写入 | — |
| 备份 | 是 | 否，可重建 | 否 |

早期 prototype 为每个 session 建独立物理 database；当前 v2 改为每个 project 一个 STG database，避免索引与缓存子集重复。隐私仍按 session 隔离：direct、exact、attachment 与 graph-expansion 读取都应用调用方 `session_id`；只有显式以无 session owner 写入的共享行才跨 session 可见。物理共置不等于语义共享。

## 3. LTG cache 是提示，不是副本权威

STG 中缓存的 LTG memory 带 `cached_from_ltg` marker，例如：

```json
{ "kind": "cached_from_ltg",
  "attributes": { "sourceMemoryId": "<ltg id>", "cachedAt": "2026-07-31" } }
```

它是可能过期的 search hint，不重新核实；Agent 可用 `nmg_get <sourceMemoryId>` 读取权威内容。此类缓存不得进入 promotion pipeline，以免形成复制循环。重复同步会跳过已存在的 `sourceMemoryId`；刷新／失效策略属于后续集成。缓存按项目的实际使用驱动，不使用全局 L1/L2 盲拷贝；未被项目使用的缓存项可按访问情况淘汰，且与 provisional-STG 过期独立。

## 4. STG 内容来源

1. **Provisional STG**（无 cache marker）：写入项目 store 的新任务事实／偏好，符合既有 governed 条件时可 consolidation。
2. **Cached LTG subset**（有 `cached_from_ltg`）：按使用记录与项目 scope 从 LTG 复制到 STG。只有项目实际使用的 LTG memory 才适合缓存；全局热门但项目未使用的内容不会因此自动复制。

## 5. 搜索：STG 优先，LTG 回退

```text
query
  → 搜索 STG（项目局部）
  → 结果充分？（QPP/coverage）── 是 → 返回
  └─ 否 → 搜索 LTG
       → 合并并按 sourceMemoryId 去重
       → 按 event/valid/creation time 合并同 scope 的 stateKey 版本
```

STG-first 让项目热点记忆优先，并在常见充分情形下避免访问共享 store。预算在两 store 间分配，先用 STG；当前状态 projection 在 STG 与 LTG 中仅暴露每个 canonical `stateKey + scope` 的最新值，时间相同时 LTG（权威 store）胜出。历史时间过滤在 reconciliation 前运行，旧值仍可用于 as-of query。Scope pushdown 与 filterUsage 在每个 store 分别执行。

## 6. 不得破坏的不变量

| 不变量 | 保护方式 |
|---|---|
| 缓存副本不能 promotion | `cached_from_ltg` marker 使其被 promotion pipeline 排除 |
| 删除 STG 不影响 LTG | 两者使用不同文件，LTG path 不写 STG |
| provisional STG 仍会过期 | 项目本地过期，与 cache 生命周期分离 |
| LTG 是唯一权威 | `nmg_get` 按 `sourceMemoryId` 从 LTG 解析 |
| 双 store 去重 | 合并时按 `sourceMemoryId` 去重缓存副本 |
| 跨 store state 更新 | 同 scope 的最新 `stateKey` 获胜；历史过滤保留旧值 |

## 7. 分阶段实施记录

下表的实施标签反映文档在 **2026-08-13** 的状态，不是本轮新鲜测试回执；本轮文档工作没有运行这些测试。

| 阶段 | 范围 | 当时记录的 evidence gate |
|---|---|---|
| 1 | 已实现：独立项目本地 SQLite store | daemon／CLI／Pi 隔离测试通过 |
| 2 | 已实现、opt-in：`cached_from_ltg` marker 与按使用排序的显式／搜索触发同步 | copy／幂等与有界 cooldown 测试通过；自然成本收益仍未校准 |
| 3 | 已实现：STG-first 双 store 搜索、QPP fallback 与权威去重 | service／adapter 测试通过；benchmark gate 待定 |

Daemon 会惰性打开项目本地 STG 文件。`stgStorePath()` 只使用 `projectDir`；session identity 用于逐行过滤，不构成独立文件 key。Pi 在 remember、search、auto-recall、get 时传入当前目录和 native session ID。CLI 接受 `--project-dir` 与可选 `--session-id`；省略时使用隔离的管理 session `cli`，不加入 Pi session。

## 8. 非目标

- 不自动重新核实缓存 LTG 内容；marker 显示其来源，Agent 决定是否重查。
- 不运行后台同步 daemon；复制由 maintenance action 执行，或通过 opt-in、scope-bound 的 read-through cache 执行。
- 不改变 LTG schema。
- 不新增 memory type；cache 由 marker 表示。