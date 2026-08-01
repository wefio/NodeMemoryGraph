# Store Cluster Split（store.ts 方法簇拆分）

**Status:** done（2026-08-01）
**Commits:** f3cd3b7（#private → protected）、5bcc4ef（守卫测试，红）、444983d（组装 + 98 测试）
**Related:** [memory-graphs.md](memory-graphs.md), [stg-isolated-store.md](stg-isolated-store.md)

## 1. 背景

`src/core/store.ts` 原 4258 行（`NmgStore` 类 101–4225 行），是仓库最大单体文件。
拆分后为 7 行组装点 + 5 个模块（基类 + 4 簇）。方法体零改动，外部 API 面不变。

```
src/core/store.ts             7 行   组装点
src/core/store/base.ts        1358 行 构造/close + 50 保留成员 + 4 个 stub
src/core/store/graph.ts       748 行  16 方法
src/core/store/retrieval.ts   787 行  11 方法（热区：search.direct 占 ~50% 总延迟）
src/core/store/writes.ts      246 行  9 方法
src/core/store/maintenance.ts 1238 行 29 方法
```

## 2. 为什么是这个方案（关键决策）

### 2.1 官方 Mixin 模式，而非自由函数

**上次失败方案**（2026-07-31）：自由函数 + `this: StoreDeps` 参数 + 65 个转发器。
根因：转发器 `graphX.call(this, ...)` 对 `this`（NmgStore）做 → StoreDeps 的
**结构可赋值检查**，115 签名 × 116 方法交叉比较时 tsc 类型展开递归爆栈
（`store: any` / `as any` 均不爆，证实根因）。

**本方案**：TypeScript Handbook 官方 mixin——泛型类表达式继承：

```ts
export function withRetrieval<TBase extends Constructor>(Base: TBase) {
  return class extends Base { /* 方法体原样，this. 直接可用 */ };
}

export class NmgStore
  extends withGraph(withRetrieval(withWrites(withMaintenance(NmgStoreBase)))) {}
```

`this` 类型自动正确（继承而非结构赋值），无转发器，方法体逐字节保留。

### 2.2 关键约束（均为实证）

| 约束 | 原因 |
| --- | --- |
| `Constructor` 必须 `new (...args: any[])` | `never[]` 触发 TS2545（mixin 构造器须 `...args: any[]` rest 透传） |
| 基类用 **stub**（签名 + `throw`）而非 `abstract` | 测试用 `node --experimental-strip-types` 直接跑源码，而 strip-types 不支持 abstract 方法（须 abstract class，不可实例化） |
| 字段 `#private` → `protected` | `#` 跨文件类不可访问；mixin 不能声明 protected 属性但可访问基类 protected 字段（Phase 0 已剥离 422 处） |
| 基类调簇方法处声明 stub，簇 mixin 覆盖 | 3 处：`recordActiveGraphUseInner`→recordUsage/trainRouter、`searchWithVector`→routeNodes、`redirectRelations`→linkNodes。stub 运行时不可达（mixin 永远覆盖） |
| mixin 链顺序 graph ⊃ retrieval ⊃ writes ⊃ maintenance ⊃ Base | 依赖图无环（graph→maintenance；retrieval→graph,maintenance；writes→maintenance,graph；maintenance→∅），跨簇调用走原型链 |
| 簇文件不 import store.ts / base.ts / 兄弟簇 | 模块图保持 DAG，只 import 类型/工具模块 |

### 2.3 方法分配（单一事实源：tests/core/store/cluster-dag.test.ts 的 CLUSTERS）

- **graph (16)**：linkNodes, getRelations, mergeNodes, splitNode, getNodeTransform,
  routeNodes, routeNodesByVector, trainRouter, edgeStability, nodeActivation,
  relationActivation, reconcileConsolidation, consolidationEvents,
  proposeTopologyChanges, topologyProposals, reviewTopologyProposal
- **retrieval (11)**：searchContext, searchContextWithSecondPass, getContext,
  residentKernel, recallCues, search, searchByVector, searchByVectorCandidates,
  searchHierarchyByVector, searchLeafBlocks, searchNodeFirst
- **writes (9)**：remember, rememberInner, addMemory, appendHistory, deriveMemory,
  recordRejectedWrite, recordUsage, archiveSession, getSessionArchive
- **maintenance (29)**：deleteMemory, setMemoryStorageState, retentionCandidates,
  promoteMemory, demoteMemory, expireShortTermMemories, memoryWriteEvents,
  getHistoryBySourceMessage, rebuildVectorIndex, rebuildLeafBlocks,
  rebuildDueLeafBlocks, dirtyLeafNodeIds, pendingIndexDelta, acknowledgeIndexDelta,
  beginEmbeddingIndex, completeEmbeddingIndex, failEmbeddingIndex,
  embeddingIndexHealth, contradictionNotes, recordRetrievalTrace, perfAggregates,
  retrievalTracesCount, pruneRetrievalTraces, retrievalTrace, recordActiveGraphUse,
  recordConsolidationEvent, rebalanceNode, rebalanceDueNodes, upsertNode
- **Base (50)**：构造/close + 16 外部 embedding API + routeLeafBlocksByVector +
  33 共享 protected helpers（requireNode、searchWithVector、markIndexDelta 等）

## 3. 测试

- `tests/core/store/cluster-dag.test.ts`（守卫，4 项）：簇文件只导出 `with<Cluster>`
  且定义簇方法、方法不在 store.ts/base.ts 残留、簇间无 import（DAG）、store.ts
  组装链存在。持续防护方法回滚/循环依赖。
- 簇行为测试 98 例：graph 22 / retrieval 21 / writes 15 / maintenance 40。

## 4. 验证

- 当前完整测试套件 479/479 全绿；其中簇拆分的 4 个结构守卫持续通过。
- tsc 0 错误（含 `--noUnusedLocals`）、eslint 0 警告、prettier 通过
- `npm run build`（dist）通过；dist 冒烟 + nmg CLI 端到端（remember/search/status）正常

## 5. 非目标

- 不改任何方法体逻辑（纯搬移）
- 不引入新依赖（无 mixin 库，纯 TS 官方模式）
- 不做转发器/自由函数/StoreDeps 接口（上次方案，弃用）
