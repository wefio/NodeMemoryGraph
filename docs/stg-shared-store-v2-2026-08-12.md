# STG Shared-Store v2：物理共享 + 逻辑隔离

**Status:** 设计定稿，待实现
**Date:** 2026-08-12
**Supersedes:** [stg-isolated-store.md](stg-isolated-store.md)（v1：session-private per-session 文件）
**Related:** [memory-graphs.md](memory-graphs.md) §1/§3/§5, docs/design.md §1, `src/core/stg.ts`, `src/core/store/schema.ts`, `src/cli/service.ts`

## 0. TL;DR

v1 用"每会话一个 `stg.sqlite` 文件"实现 STG 会话隔离。实测代价：**1765 个文件、~1.6G 磁盘**（含 1.5G 未 checkpoint 的 WAL + 1765 份完整 schema/FTS 骨架），而 STG 语义内容几乎为空（样本 `memory_records` 全 0 行）。v2 收敛为**每项目一个 `stg.sqlite`**，把会话隔离从"文件系统层级"上移到"**数据行层级**"（`memory_records.session_id`），由 daemon 作为唯一守门人签发/校验 session_id——即业界多租户"共享表 + tenant_id"架构在 SQLite 上的实现，并用 daemon 认证消除 SQLite 无 RLS 的缺口。

```
v1:  <project>/.nmg/sessions/<session-hash>/stg.sqlite   (每会话一文件)
v2:  <project>/.nmg/stg.sqlite                           (每项目一文件)
     ├─ cached_from_ltg 行  → session_id NULL（项目共享，所有会话共用一份 LTG 缓存）
     ├─ provisional 行      → session_id = 会话（逻辑私有，daemon 认证过滤）
     └─ 会话结束           → DELETE WHERE session_id=?（删行，原子轻量）
     单 WAL → close 时 wal_checkpoint(TRUNCATE) → 无泄漏
```

效果：**1765 文件 → 1**；**~1.5G WAL → 正常回收**；**1765 份 schema/FTS 骨架 → 1 份**；LTG 缓存 N 份 → 1 份；空库 → 0。

---

## 1. 问题与动机（v1 的实测成本）

### 1.1 现状（2026-08-12 实测）

`<project>/.nmg/sessions/` 目录：

| 项 | 数量 | 大小 | 说明 |
| --- | --- | --- | --- |
| `stg.sqlite` | 1765 | 42MB | 平均 23KB；**1677 个是 4KB 空库** |
| `stg.sqlite-wal` | 1681 | **1.5G** | 平均 ~900KB；从不 checkpoint，连接未干净关闭 |
| schema/FTS 骨架 | 1765 份 | ~900MB | 每库建库即初始化十几个表 + FTS 虚拟表（4-580KB 固定开销） |

语义内容（`memory_records`）抽样：**全 0 行**。即：`memory_records` 数据量极小，磁盘几乎全部被"每会话一份的文件系统开销"吃掉。

### 1.2 根因

1. **隔离单位过度**：用"一个 SQLite 文件"去隔离"数据库一行数据"。`stgStorePath` 把 `sha256(sessionId)` 写进路径（`src/core/stg.ts`），每会话一个完整 store。
2. **WAL 泄漏**：所有 store `PRAGMA journal_mode = WAL`（`base.ts:66`），但全库无 `wal_checkpoint`；daemon 关闭走强制退出（`daemon-client.ts` "force-exits survivors"），SQLite 连接未干净 close → WAL 从不合并进主库。
3. **生命周期缺失**：`session_shutdown`（`.pi/extensions/nmg/index.ts:514`）只做归档 + daemon 关闭，不清理 session 目录、不删空库。设计意图"删 session 文件夹即删 STG"从未被执行。

### 1.3 结论

不是"会话隔离"语义错，是"**用文件系统实现隔离**"的代价不可持续。隔离是**查询时**的约束，不是**物理文件**的约束。

---

## 2. 业界框架（调研，2026-08-12）

多租户数据隔离三种标准架构（电科金仓 / Propelius / 数据库行业共识）：

| 架构 | 特征 | 成本 | 扩展性 | NMG 对应 |
| --- | --- | --- | --- | --- |
| ① 独立库 per-tenant | 每租户一文件/一库 | 最贵 | <50 | **v1 现状** |
| ② Schema-per-tenant | 共享实例、独立 schema | 中 | 50-500 | — |
| ③ 共享表 + tenant_id + 行级过滤 | 同一张表，行级过滤 | 最低 | 500+ | **v2 目标** |

关键结论（与 NMG 直接相关）：

- **架构 ③ 是成本最低、数据模型最统一、扩展性最好的方案**；其已知风险是"漏 WHERE 就串"（隔离靠应用层 SQL，人肉保障）。
- 业界用 **RLS（Row-Level Security，数据库内核强制行过滤，PostgreSQL 9.0+）** 消除该风险——**但 SQLite 没有 RLS**。
- **SQLite 并发边界**：<50 并发写入安全（单写者）；WAL 有写放大 + checkpoint 隐性瓶颈，需管理。
- **行级可见性是 agent 记忆的主流**：腾讯云四层记忆把"可见性标签（私有/团队共享）"作为每条记忆的属性，而非存储物理隔离。

### 2.1 为什么 NMG 可以做架构 ③（RLS 缺失的规避）

"漏 WHERE"风险在多租户 SaaS（多方应用代码写 SQL）才严重。**NMG 的 STG 只有 daemon 一个守门人**：pi 扩展/CLI 客户端只通过 daemon 的 HTTP API 访问 STG，从不直接操作 SQLite 文件。因此：

- session_id 由 **daemon 认证**（不可伪造，满足 memory-graphs.md §3 "non-forgeable runtime_id + session_id must be carried through search"）；
- 行过滤**收敛到 daemon 少数统一入口**（`#getStgStore` / `searchStgFirst` / remember 路径），无散落 SQL → "漏 WHERE"风险近似为零；
- **daemon 认证即业界 RLS 的等价物**（SQLite 无内核 RLS，用守门人架构替代）。

---

## 3. 设计

### 3.1 存储布局

```
<project>/.nmg/stg.sqlite        # 每项目一个，唯一文件
  memory_records:
    session_id  TEXT             # NULL = 共享（cached_from_ltg 缓存、项目级）
                                # 非 NULL = 该会话私有的 provisional
    ...其余列不变
  （history/trace 已有 sessionId 隔离：assertTraceOwner，base.ts:466）
```

- **项目间**：不同项目不同文件，天然隔离（保持 v1 的项目边界）。
- **项目内会话间**：`memory_records.session_id` 行过滤。
- **LTG 缓存（cached_from_ltg）**：`session_id IS NULL`，项目内所有会话共享同一份（v1 中每会话一份是重复缓存）。
- **provisional（会话私有）**：`session_id = 该会话`。带 sessionId 检索时可见共享行 + 本会话私有行；**匿名读取（无 sessionId）只返回共享行（`session_id IS NULL`）**，私有行绝不可见。

  > 真实环境验证（2026-08-12 重启后 daemon RPC）曾暴露：旧谓词 `(? IS NULL OR session_id IS NULL OR session_id = ?)` 在无 sessionId 时放行全部私有行（匿名搜索泄漏）。已修复为两分支谓词：有 sessionId → `(session_id IS NULL OR session_id = ?)`；无 sessionId → `session_id IS NULL`。所有读路径（searchWithVector/getMemory/getContext）统一此语义。LTG 行 `session_id IS NULL`，匿名读全局可见（服务层 LTG remember 强制 `session_id = null`）。

### 3.2 隔离语义（与 history 层对齐）

history/trace 已有 `assertTraceOwner(row, sessionId)`：owner 非空且不等于当前 sessionId 即抛错。memory_records 采用相同模型，保证"trace 私有"与"STG provisional 私有"语义一致。

### 3.3 生命周期

| 事件 | 动作 |
| --- | --- |
| 会话写 provisional | `INSERT ... session_id = <session>` |
| LTG 缓存拷贝 | `INSERT ... session_id = NULL`（幂等，sourceMemoryId 去重） |
| 会话结束（`session_shutdown`） | daemon 方法 `DELETE FROM memory_records WHERE session_id = ?`（连同关联 rows）；文件保留 |
| store 关闭 | `PRAGMA wal_checkpoint(TRUNCATE)`，删除 `-wal`/`-shm` |
| 长期无活跃会话 | 保留文件（单文件，无数量膨胀） |

### 3.4 并发

- 单文件由**一个 daemon 进程**独占（每项目一个 daemon）；Node `DatabaseSync` 同步执行 → **单进程单写者**，远低于 SQLite <50 并发边界。
- 多会话并发 = 单进程内的串行写入（better-sqlite3 事务语义），无跨进程竞争。

### 3.5 安全模型

**信任模型（评审修正，019fefc5 2026-08-12）**：sessionId 来自 pi 的 `sessionManager.getSessionId()`（客户端会话系统），**daemon 只信任客户端传入值，并未签发/认证**。因此 v2 防的是【漏 WHERE 的无意识错误】（唯一入口 + 过滤收敛），**不防恶意/伪造**（本地进程可声称任意 sessionId）。v1 的 `sha256(sessionId)` 路径同样不防伪造——**信任模型无回退**；真正的变化是 **blast radius：v1 漏过滤只污染本会话文件，v2 漏过滤污染整个项目库 + 共享缓存**（风险更集中，因此统一入口更重要）。

**统一入口**：session 过滤收敛在 daemon 层（`#getStgStore` 单 store + `#search` 统一构造 `SearchOptions.sessionId` + store 层 `searchWithVector`/`getMemory`/`getContext` 统一 SQL 谓词），**业务代码不暴露裸 WHERE**。客户端（pi/CLI）只走 daemon HTTP API，不能绕过过滤层直接触库。

**写权限分层（design.md §8/§5b）**：确认的原子事实（fact/preference/constraint/state）可直接进 LTG（§8 快速路径）；其余（derived/strategy 等）需更强跨任务证据 + 语义评判。agent 的角色是显式 `nmg_remember`（确认/提交），升级靠评判机制（两层桥规划中，见 memory-maintenance-policy-skillopt.md）——当前实现比设计宽（residence 由调用方直接指定），属已知 gap，非本改造引入。

### 3.6 Escape Hatch 原则（用户要求，2026-08-12）

**原则**：任何约束/隔离机制必须配一个**显式的、安全的、被设计允许的绕过通道**（escape hatch）。**不允许存在"因为机制不存在/参数可选而发生的意外绕过"**——那种绕过既没被设计，也不安全。

**v1/v2 设计中的违反点（保存时）**：`RememberInput.sessionId` 曾是可选项，缺省 `?? null` → session_id = NULL = 全局可见。这意味着"调用方忘了传 sessionId"会把一条 provisional 意外变成全局可见——这是"机制缺失的绕过"（不安全的意外），必须消除。

**修正（写入侧强制）**：

```
STG provisional 写入（无 cached_from_ltg marker）→ sessionId 必填
  ├─ 缺省 → 拒绝写入（抛错），绝不默认 NULL
  └─ 唯一例外：显式全局声明

session_id = NULL（全局可见）只能通过【显式声明】获得：
  ├─ cached_from_ltg（缓存拷贝，带 marker，本就是共享性质）
  └─ LTG 提升（consolidateStgMemoryToLtg → 全局 LTG，显式通道）
```

**检索侧（显式旁路）**：

```
会话检索：过滤 session_id IS NULL OR session_id = ?（正常路径）
跨会话唯一通道：consolidateStgMemoryToLtg（会话私有 → 全局 LTG）
  ——被设计允许的绕过，安全、显式；不存在跨会话 STG 直接检索
```

**验收**："全局可见"必须是一个显式选择的通道（缓存 marker / LTG 提升），绝不是"忘了传参数"的默认值。测试断言：provisional 写入缺 sessionId 抛错；无任何路径能把会话私有行意外置为 NULL。

---

## 4. Schema 变更

```sql
-- memory_records 增加列
ALTER TABLE memory_records ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_records_session ON memory_records(session_id);
```

`RememberInput` 增加 `sessionId?: string`（`RememberParams` 已有，下沉到 store 层）。

---

## 5. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/core/stg.ts` | `stgStorePath` → `<project>/.nmg/stg.sqlite`；`createStgStore(projectDir)` 去掉 session 路径；`searchStgFirst` 增加 sessionId 过滤参数；`copyLtgSubsetToStg` 写 `session_id=NULL`；新增 `purgeSessionFromStg(stg, sessionId)` |
| `src/core/store/schema.ts` | `memory_records` 加 `session_id` 列 + 索引（migrate 幂等） |
| `src/core/store/base.ts` | `remember` 写 `session_id`；search/query 支持 session 过滤（`session_id IS NULL OR session_id = ?`）；`close()` 时 `wal_checkpoint(TRUNCATE)` |
| `src/core/types.ts` | `MemoryRecord` + `RememberInput` 加 `sessionId?: string` |
| `src/cli/service.ts` | `#getStgStore(projectDir)` 单 store（去掉 session key）；STG remember/search 传 sessionId 过滤；新增 daemon 方法 `stg_purge_session`；关闭时 checkpoint |
| `.pi/extensions/nmg/index.ts` | `session_shutdown` 调 `stg_purge_session` + 触发 daemon checkpoint |
| 测试 | `tests/core/stg.test.ts`（隔离/共享/清理/并发串行） |

### 5.1 数据分类规则（写入时判定）

- `markers` 含 `cached_from_ltg` → `session_id = NULL`
- 其余 provisional → `session_id = <调用会话>`
- 提升到 LTG（`consolidateStgMemoryToLtg`）不变：跨库拷贝，权威在 LTG。

---

## 6. 迁移（现有 v1 数据）

v1 的 1765 个 `stg.sqlite` 处理（评审修正：provisional 合并**不可行**，一律丢弃）：

1. **cached_from_ltg 行**：丢弃，不迁移（LTG 权威在全局库，缓存可随时 `copyLtgSubsetToStg` 重建）。
2. **provisional 行**：**一律丢弃**——v1 路径 = `sha256(sessionId)` 哈希不可逆，无法反推原始 sessionId 归因；且 v1 库内无 `session_id` 列，合并技术上不可行。量 ≈ 0（2026-08-12 实测全库 0 行）+ 短生命周期语义，丢弃安全。
3. **清理**：删 `sessions/` 目录；删 WAL 前先对主库 `wal_checkpoint(TRUNCATE)`（防丢未合并帧）。
4. 一次性迁移脚本需 **dry-run + 全量统计**（每文件行数 / cached vs provisional 占比），不只信抽样。

预计回收：**~1.5G WAL + ~900MB 骨架 ≈ 2.4G**。

---

## 7. 风险与对策

| 风险 | 对策 | 状态 |
| --- | --- | --- |
| SQLite 无 RLS，"漏 WHERE" | daemon 唯一守门人；过滤收敛到统一入口（searchWithVector/getMemory/getContext SQL 谓词）；测试覆盖越权访问（B 查不到 A 的 provisional） | ✅ 已实现 |
| 信任模型过度表述 | 改为"信任调用方 + 统一入口"（不声称 daemon 认证）；blast radius 明确化 | ✅ 文档已修 |
| **WAL 泄漏复发（force-exit）** | **close() checkpoint + 启动时 checkpoint-on-open**（open 折叠上次残留 WAL） | ✅ 已实现（base.ts） |
| **purge 级联** | purgeSession 走 deleteMemory 全级联（FTS/embeddings/traces/proposals）+ 物理删行 | ✅ 已实现 |
| **黑板表共存** | 黑板在 LTG 主库（#getStore），与 STG memory_records 异隔离策略；purge 不碰 task_board 表；测试覆盖 | ✅ 已实现 |
| 单文件写竞争 | 单 daemon 单进程单写者；`DatabaseSync` 同步；远低于 <50 并发边界 | ✅ |
| 迁移丢数据 | cached 丢弃安全（可重建）；provisional 量≈0 一律丢弃；迁移脚本 dry-run + 全量统计 | ✅ 方案定 |

---

## 8. 验证

- **单元/集成**：会话隔离（B 会话检索不到 A 会话 provisional）、共享缓存（所有会话可见 cached 行）、会话清理（purge 后该会话行消失、其他会话行保留）、WAL 回收（close 后无 -wal 残留）、越权访问拒绝。
- **规模量化**：迁移后 `.nmg/sessions/` 消失，`<project>/.nmg/stg.sqlite` 单个文件；磁盘回收 ~2.4G。
- **回归**：STG-first 检索、promotion/consolidation、黑板协作（黑板的 deliveries/suppressions 已是 session-scoped，不受影响）。

---

## 9. 决定记录

- 采纳业界架构 ③（共享表 + session_id + daemon 认证），放弃 v1 的 per-session 文件。
- "项目内共享、项目间私有"：物理单文件（项目内）+ 行级 session 隔离（会话私有）+ 不同项目文件（项目间隔离）。
- 不引入独立登记层/索引（黑板内容入长期层属策略纪律，另见黑板去重设计，与本存储改造正交）。
- Phase 顺序：先止血（WAL checkpoint + 清理空库，不碰架构），后 v2（schema + stg.ts + service + 迁移）。
