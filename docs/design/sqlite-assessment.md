# SQLite 评估与性能调优

**Created:** 2026-07-20

## 1. 是否真的需要 SQLite

### 1.1 NMG 对存储的实际需求

```
✓ 关系型查询（JOIN memory ← node ← evidence）
✓ 全文搜索（FTS5）
✓ 事务（多表原子写入）
✓ BLOB 存储（向量 embeddings）
✓ 嵌入式（随 Pi 进程启动，零配置）
✓ 单机本地（数据库文件一个 .sqlite）
```

### 1.2 替代方案对比

| 方案 | JOIN | 全文搜索 | 事务 | 嵌入式 | 适合吗 |
|---|---|---|---|---|---|
| **SQLite** | ✓ | ✓ FTS5 | ✓ | ✓ | **是** |
| LevelDB / RocksDB | ✗ 无 SQL | ✗ | ✗ 单 key | ✓ | 否。NMG 查 memory 要 JOIN node 和 evidence，用 KV 得在应用层手动 join |
| LMDB | ✗ 无 SQL | ✗ | ✓ | ✓ | 否。同 KV 问题 |
| DuckDB | ✓ | ✓ | ✗ OLAP | ✓ | 否。分析引擎，不适合高频小事务 OLTP |
| PostgreSQL | ✓ | ✓ GIN/tsvector | ✓ | ✗ 需独立进程 | 否。违反 "local-first, zero-config" 原则 |
| 纯 JSON 文件 | ✗ | ✗ | ✗ | ✓ | 否。每次检索要全量载入解析 |

**结论：SQLite 是正确的选择。** NMG 的数据模型（memory → node → evidence，多对多，有 FTS）天然是关系型的。换成 KV 或文档存储会在应用层重新发明 SQLite 已经做好的东西。

### 1.3 唯一的真实替代场景

当 NMG 需要**多进程并发读写**时（例如多个 Pi agent 共享一份记忆），SQLite 的 WAL 模式支持一写多读，但不是为高并发写的。这个场景下可以考虑：
- **LiteFS**（分布式 SQLite，基于 FUSE）：保持 SQLite API，复制到多节点
- **Turso**（libSQL，SQLite 兼容但有远程同步）
- **PostgreSQL**：仅当部署模式从嵌入式变成服务化时

但目前这些都是 P3（设计文档明确写了 "cloud sync is optional and never authoritative"），不需要现在处理。

---

## 2. SQLite 性能调优

### 2.1 当前状态

```sql
-- 仅此两行
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

### 2.2 立即加上的 PRAGMA（零风险）

```sql
-- WAL 模式下 NORMAL 是安全的：崩溃恢复由 WAL 保证，不是由 fsync 保证
-- 写事务不等待 fsync，显著提升写入吞吐
PRAGMA synchronous = NORMAL;

-- 默认缓存 2MB（-2000 KB）。对于 NMG 的访问模式（高频检索，几百到几千条内存记录）
-- 增大到 16-64MB，让热数据（低 tier 的 memory + index pages）留在内存
PRAGMA cache_size = -64000;  -- 64MB

-- 临时表和临时索引放内存而非磁盘
PRAGMA temp_store = MEMORY;

-- 内存映射 I/O：把数据库文件的一部分映射到进程地址空间
-- 对只读为主的检索查询有显著提升（省掉 read() 系统调用）
-- 设置成数据库文件预期最大大小。NMG 的数据库通常不会超过几百 MB
PRAGMA mmap_size = 268435456;  -- 256MB
```

加在 constructor 里，紧接现有 PRAGMA 之后：

```typescript
this.#db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
`);
```

### 2.3 周期性维护

```sql
-- 更新统计信息，让查询优化器做出更好的索引选择
-- 在 N 条记录变更后或定时执行
PRAGMA optimize;

-- 整理空闲页面，回收空间
-- 仅在数据库文件显著膨胀后执行（如在大量 delete/update 后）
PRAGMA vacuum;
```

加到 `rebalanceNode` 末尾或做一个独立的 `maintenance` 方法，建议每 1000 次写入或每次大 eval 后触发一次 `PRAGMA optimize`。Vacuum 很少需要，手动触发即可。

### 2.4 查询优化

#### 2.4.1 热路径：`#searchWithVector`

这是每次检索都走的方法。核心查询是三表 JOIN：

```sql
SELECT ... FROM memory_records m
JOIN memory_nodes n ON n.id = m.node_id
JOIN history_records h ON h.id = m.evidence_id
LEFT JOIN memory_embeddings ve ON ve.memory_id = m.id AND ve.model = ?
WHERE m.tier <= ? AND ... AND n.status = 'active'
ORDER BY m.tier ASC, m.importance DESC, m.access_count DESC
LIMIT ?
```

**缺失的索引：**

```sql
-- memory_records.status 被所有查询过滤，没有单独索引
-- 当前只能通过 tier 索引间接过滤
CREATE INDEX IF NOT EXISTS idx_memory_records_status
  ON memory_records(status);
```

**注意**：加了不一定有用——查询优化器可能选择 tier 索引而不是 status 索引，取决于数据分布。应该用 `EXPLAIN QUERY PLAN` 验证。

#### 2.4.2 大量 IN 子句

当 `forcedCandidateIds` 或 `ftsIds` 很多时（上限 2000 个），SQL 变成：

```sql
WHERE m.id IN (?, ?, ?, ... 2000 个参数 ...)
```

大量参数绑定有开销。如果经常达到上限，改写成临时表：

```sql
-- 替代方案：把候选 ID 写入临时表，用 JOIN 替代 IN
CREATE TEMP TABLE IF NOT EXISTS _search_candidates (id TEXT PRIMARY KEY);
INSERT INTO _search_candidates VALUES (?), (?), ...;
SELECT ... FROM memory_records m
JOIN _search_candidates c ON c.id = m.id
...
```

但对于 NMG 的 scale（通常 < 500 candidate），当前 IN 子句足够，不需要这个优化。

#### 2.4.3 FTS5 查询开销

`#ftsCandidates` 每次走 FTS5 BM25 排序，可能在几十万条记录上搜索。这是冷路径（只在 fts5/hybrid 模式触发），但耗时可能显著。

```sql
-- 当前 FTS5 表
CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  statement,
  node_name,
  evidence,
  tokenize = 'unicode61'
);
```

`unicode61` tokenizer 对中文支持不好。如果中文用户多，考虑：

```sql
-- 需要 sqlite3 编译时开启 ICU 或安装 trigram tokenizer 扩展
-- 或者用简单的：把 statement 作为整体做 LIKE '%keyword%' 而不是依赖分词
```

但对 NMG 的规模（agent 长期记忆而非搜索引擎），`unicode61` 够用。

### 2.5 写入优化

当前写入路径是好的：

```
✓ PRAGMA journal_mode = WAL（写不阻塞读）
✓ BEGIN IMMEDIATE（避免 SQLITE_BUSY）
✓ 事务批量提交（不是每条 INSERT 一个事务）
✓ 使用 prepared statement（避免每次编译 SQL）
```

**可改进：** 加上 `synchronous = NORMAL` 后，写事务提交更快（不等待 fsync）。在 WAL 模式下这是安全的：即使进程崩溃，WAL 文件保证可以恢复。只有在操作系统崩溃 + 磁盘写入乱序的极端情况下可能丢最后一个事务——对 agent 记忆系统这个风险可以接受。

### 2.6 Prepared Statement 缓存

当前代码每次都调用 `this.#db.prepare(...)`，SQLite 内部对相同 SQL 字符串有 LRU 缓存，但显式缓存 prepared statement 对象可以减少哈希查找开销。

```typescript
// 对高频查询（#searchWithVector 的主查询），显式缓存
#searchStmt: StatementSync | undefined;

get #searchStatement(): StatementSync {
  if (!this.#searchStmt) {
    this.#searchStmt = this.#db.prepare(`SELECT ... 长查询 ...`);
  }
  return this.#searchStmt;
}
```

**但如果查询 SQL 是动态拼接的**（当前确实如此，因为 IN 子句参数数量变化），则没法缓存。这就是动态 SQL 的代价——不需要急着改，只是标注为已知限制。

## 3. 总结

| 优化 | 效果 | 风险 | 动作 |
|---|---|---|---|
| `synchronous = NORMAL` | 写入速度 ↑ | WAL 保护下极低 | 立即加 |
| `cache_size = 64MB` | 检索延迟 ↓ | 多用 64MB 内存 | 立即加 |
| `mmap_size = 256MB` | 读延迟 ↓ | 虚拟地址空间（不影响物理内存） | 立即加 |
| `temp_store = MEMORY` | 临时操作加速 | 大排序可能 OOM | 立即加 |
| `PRAGMA optimize` | 查询计划质量 | 零 | 周期性执行 |
| `idx_memory_records_status` | 可能改善检索 | 写入微微变慢 | 加索引后用 EXPLAIN 验证 |
| Prepared statement 缓存 | CPU 开销 ↓ | 无 | 低优先级 |
| 临时表替代大 IN | 大量候选时加速 | 需要 benchmark | 有需要时做 |
