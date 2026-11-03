# Store schema 与旧 tessera 迁移——2026-10-28

[English](legacy-tessera-migration-2026-10-28.md) · [术语](legacy-tessera-migration-2026-10-28.terms.yaml)

在版本 `cd193624f10d72b69b010ca70de5d61c6f8cd09d`，隔离 SQLite 测试发现旧 `anchors` 迁移有两个恢复缺口：新旧表共存时跳过旧记录；表改名后、标记更新前失败时，重试会留下旧标记。这些观察不能证明所有安装都存在这些状态。测试不访问用户数据库。

## Schema 与迁移清单

[Store schema](../../../src/core/store/schema.ts) 拥有主要表，并组合[协调 schema](../../../src/core/store/coordination-schema.ts)和[任务声明](../../../src/integration/task-unit-declaration-store.ts)。它涵盖历史与语义记忆、图与检索索引、任务协调与运行记录、文件书签。[Store 构造函数](../../../src/core/store/base.ts)在可写打开时启用外键并执行迁移；只读打开不迁移。

全新内存数据库执行 `migrate` 后有 57 张普通表、5 张虚拟表和 22 张 SQLite 内部 shadow 表。`PRAGMA user_version` 为 0，`PRAGMA foreign_key_check` 没有返回行。计数不含 `sqlite_` 对象；空白测试库不能证明已有数据的完整性。Schema 并非单条 `user_version` 序列：`migrate` 使用幂等 DDL、列探测和回填。向量和词法 FTS 迁移使用保存点；旧表改名和标记替换没有共同事务。Agent 注册表重建有自己的事务。这是已检查机制的地图，不是对每条迁移的完整审计。

## 隔离场景

在记录的版本、`src/core/store/schema.ts` 未修改的仓库根目录，使用 Node `v24.19.0` 运行。脚本记录旧行为，并拒绝其他版本或已修改的 schema：

```sh
node --experimental-strip-types docs/experiments/store/legacy-tessera-migration-2026-10-28.mjs --run
```

[测试脚本](legacy-tessera-migration-2026-10-28.mjs)创建全新内存库、构造合成的新旧表和 `anchor_ref` 标记，运行迁移两次并断言观察到的数量。“旧记录 FTS”统计旧记录的唯一词在当前 tessera 索引中的匹配数。旧表为空的场景故意保留一个指向不存在记录的标记，用于检查标记分支，不代表实际库曾出现该数据。相同 ID 场景中新旧记录内容不同。`null` 表示旧表已不存在。

| 场景 | 重试后旧记录 | Tessera 记录 | 旧标记 | 旧记录 FTS | 观察 |
| --- | ---: | ---: | ---: | ---: | --- |
| 仅旧表 | null | 1 | 0 | 1 | 表改名、标记类型替换和 FTS 查询成功。 |
| 两表共存，旧表为空 | 0 | 1 | 1 | 0 | 旧表和旧标记仍在。 |
| 两表共存，ID 不同 | 1 | 1 | 1 | 0 | 旧记录保留，但不在当前 tessera 检索中。 |
| 两表共存，ID 相同 | 1 | 1 | 1 | 0 | 冲突的旧记录保留；没有执行合并策略。 |
| 改名后失败，再重试 | null | 1 | 1 | 1 | 记录可检索，但旧标记仍在。 |

最后一个场景在表改名执行后、标记 `UPDATE` 前注入异常，模拟该语句边界；它不是进程杀死、断电或并发写入测试。测试检查标记类型，没有验证历史标记属性是否符合当前消费者。共存场景显示记录仍保留在 `anchors`，没有被删除，也没有决定冲突时应保留哪个版本。

## 影响与限制

[`migrateLegacyTesseraeTables`](../../../src/core/store/schema.ts) 在 `tesserae` 存在时直接返回，因此这些状态下不会合并旧记录或修正旧标记。安全修复需要明确冲突策略、原子性和重启行为，并用回归测试保护记录、引用和 FTS 索引。不能因为当前本地实例曾观察到旧表为空，就删除其他库的旧表；该观察只适用于当时的实例，之后也可能变化。

这是现状测试证据，不是迁移修复或修改实际数据库的授权。它没有测试其他历史 schema、所有 Store 事务、已部署云存储或用户数据库内容。现有设计归属[记忆 tesserae](../../design/memory-tesserae-design.zh-CN.md)。
