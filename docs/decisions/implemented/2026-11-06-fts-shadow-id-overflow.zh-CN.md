# 重建全文索引时同时重建两张 FTS 表

[English](2026-11-06-fts-shadow-id-overflow.md) · [术语](2026-11-06-fts-shadow-id-overflow.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

删除一条记忆时抛出 `Value is too large to be represented as a JavaScript
number: 9010497789624320`。这个数来自 FTS5 的影子表：`memory_fts_data.id` 与
`memory_surface_fts_data.id` 把段号编码成 `segid << 31`，每次提交产生一个段，长期存在
的库会越过 `Number.MAX_SAFE_INTEGER`。`node:sqlite` 无法把这样的 rowid 转成 JS 数字，
于是 `DELETE FROM memory_fts WHERE rowid IN (…)` 在真正删除之前就抛出。该库上每一次
forget 都失败，之后任何触发段合并的写入同样有风险。

重建词法索引的迁移会 DROP `memory_fts`——这能重置该表的段号——但对
`memory_surface_fts` 只执行 `DELETE FROM`。删除不会碰表层索引的影子 id，于是它的段
计数器一直上涨且没有归零路径。

## 决策

格式迁移现在同时 DROP 并重建**两张**全文表，两个影子 id 空间都从干净状态开始。读取旧
rowid 顺序是尽力而为：旧索引一旦溢出，对它的查询就会抛出，因此这一步被包住；读不出来
时降级为重新分配 rowid，而不是让整次迁移失败。表层 schema 抽成导出常量，与主 DDL 共用，
使重建路径不会与建表路径产生分歧。

格式标记前移，因此所有存量库会在下一次打开时执行一次这次重建。活动库在文件备份之后用
同一份代码就地迁移，最大影子 id 从 `9.0e15` 降到 `3.2e12`。

## 考虑过的替代方案

- 给相关语句开 `setReadBigInts`。它只覆盖 store 自己 prepare 的语句；出错的读取发生在
  虚拟表的删除路径内部，store 无法给它加注解。
- `VACUUM` 或 `INSERT … VALUES('rebuild')`。两者都不重置影子表的 id 空间，只有 DROP
  表才会。
- 表层索引保留 `DELETE`、只重建词法索引。这正是缺陷本身：表层计数器永远回不到安全区间。

## 后果

标记变化后，每个库下一次打开时做一次全量重建。段号回到百位数量级，再需要约四百万次提交
才会重新触顶；真触顶时前移格式标记即可修复，走的是同一条路径。

旧 id 已经不可读的库会丢掉原来的词法 rowid 顺序，因此 BM25 的打平顺序可能变化一次。其余
内容——词项、doc size、注册表映射、证据——都从源行重建。

## 延期

没有任何机制在再次触顶之前主动重建。修复路径存在，但只在格式标记变化时执行。
