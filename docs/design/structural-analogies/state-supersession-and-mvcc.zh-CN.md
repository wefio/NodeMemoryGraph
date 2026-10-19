# State supersession = MVCC / 时态数据库

[English](state-supersession-and-mvcc.md) · [使用的术语](state-supersession-and-mvcc.terms.yaml)

**Authority:** [父级范围](../structural-analogies.zh-CN.md).

## State supersession = MVCC / 时态数据库

**当前实现**：`src/core/store/writes.ts` — `remember` 中的 `automaticPrevious` 逻辑。

**结构**：

```
NMG                              MVCC (PostgreSQL / etc.)
────────────────────────────────────────────────────────────
stateKey + scope 定位一条状态    (id, version) 定位一行
新 state → old.status =           UPDATE → 旧版本标记过期
  'superseded'
supersedes_id → 指向前一版本      xmin / xmax → 可见性区间
validFrom / validUntil → 时间窗口 事务 ID 范围 → 可见性判断
查询只取 active                   查询只取当前快照可见的行
```

**相似点**：
- 旧值不删除，标记为不可见
- 新旧之间有显式链接（supersedesId / version chain）
- 时间维度（validFrom/validUntil）建模

**差异**：
- MVCC 的可见性由事务 ID 决定（并发控制），NMG 用 status = 'active'
- MVCC 有 vacuum（清理死元组），NMG 没有等效机制
- NMG 的 supersedesId 链是单向链表，MVCC 的 version chain 也是

**与 Event Sourcing 的相似**：
- HistoryRecord（不可变事件流）→ MemoryRecord（投影/状态）
- 新事件 → 新投影覆盖旧投影，事件本身保留
- 这就是标准的 CQRS/Event Sourcing 模式

**设计启发**：可以引入 `valid_time` 和 `transaction_time` 的双时态模型
（bitemporal），区分"事实发生时间"和"系统记录时间"。当前只有一个
validFrom/validUntil。

---
