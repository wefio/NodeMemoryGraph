# Store Cluster Split（store.ts 方法簇拆分）

**Status:** design proposal（待批准）
**Updated:** 2026-07-31
**Related:** [memory-graphs.md](memory-graphs.md), [stg-isolated-store.md](stg-isolated-store.md)

## 1. 背景与动机

`src/core/store.ts` 现有 4258 行（`NmgStore` 类 101–4225 行），是仓库最大单体文件。
已完成的拆分：rows.ts 抽取（2026-07-31 提交，-399 行纯函数）。剩余 4100 行方法体
按功能可清晰分为 4 簇，且运行时性能数据显示热点集中在检索簇（search.direct 占
~50% 总延迟）：

| 簇 | 方法数 | 外部引用代表 | 热点 |
| --- | --- | --- | --- |
| retrieval | 11 | search×41, searchContext×40 | ★★★ 最热 |
| writes | 9 | remember×169 | ★★ |
| maintenance | 30 | deleteMemory, pruneRetrievalTraces | ★ |
| graph | 15 | linkNodes×15, getRelations×7 | ★ |

拆分目标：每个文件 300–700 行，方法体零改动，API 面不变（外部调用方无感知）。

## 2. 上次尝试为何失败（2026-07-31 记录）

**方案**:自由函数 + `this: StoreDeps` 参数 + 65 个转发器。

**失败根因**:

1. **tsc 栈溢出**（`Maximum call stack size exceeded`）:转发器 `graphX.call(this, ...)`
   对 `this`（NmgStore）做 → StoreDeps 的**结构可赋值检查**，115 签名 × 116 方法
   交叉比较时 tsc 类型展开递归爆栈（`store: any` / `as any` 均不爆，证实根因）。
   用 `implements StoreDeps` 可绕开（只做一次声明检查），但属于非标准 workaround。
2. **脚本自动化不可靠**:多轮正则/括号配平 bug 损坏了 graph.ts，最终整体撤回。

**教训**:tsc 的 `this` 参数 + 接口结构赋值对大型类不友好；文件搬移必须每步
tsc + 测试验证，不可脚本盲改。

## 3. 本方案：官方 Mixin 模式（类表达式继承）

依据 [TypeScript Handbook — Mixins](https://www.typescriptlang.org/docs/handbook/mixins)
官方推荐形态：**泛型类表达式继承**。关键特性：

- mixin 是 `function withX<TBase extends Constructor>(Base: TBase) { return class extends Base {...} }`
- **`this` 类型自动正确**（子类 this 含基类全部成员，非结构赋值检查 → 不爆栈）
- 官方规则：*mixin 不能声明 private/protected 属性，但可用 ES2020 `#` 私有字段*；
  基类声明的 `protected` 字段子类可访问

### 3.1 形态

```ts
// src/core/store/retrieval.ts
import type { Constructor } from "./store-ctor.ts";export function withRetrieval<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    searchContext(query: string, options: SearchOptions = {}): MemoryContext {
      // 方法体原样，this.db / this.search(...) 直接可用
    }
    // ... 11 个方法
  };
}
```

```ts
// src/core/store.ts（组装，最后一步）
import { NmgStoreBase } from "./store/base.ts";
import { withGraph } from "./store/graph.ts";
import { withRetrieval } from "./store/retrieval.ts";
import { withWrites } from "./store/writes.ts";
import { withMaintenance } from "./store/maintenance.ts";

// 4 层 mixin 链，每层叠加方法
export class NmgStore
  extends withGraph(withRetrieval(withWrites(withMaintenance(NmgStoreBase)))) {}
```

```ts
// src/core/store/base.ts（基类，Phase 3 从 store.ts 抽出）
export class NmgStoreBase {
  protected db: DatabaseSync;      // 原 #db（protected 子类可访问）
  protected embedder: VectorEmbedder;
  protected router: Router;
  protected vectorCaches = new Map<string, Float32VectorCache>();
  constructor(...) { ... }
  close(): void { ... }
  // 外部 embedding API + 跨簇共享的 protected helpers 留在基类
}
```

### 3.2 关键决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 字段私有性 | `#private` → `protected` | `#` 跨文件类不可访问；protected 子类可见，外部仍不可见 |
| 方法可见性 | 全部 public（现状已是） | 外部 API 不变 |
| mixin 链顺序 | graph ⊃ retrieval ⊃ writes ⊃ maintenance ⊃ Base | 方法无重名冲突（4 簇方法名互斥），顺序仅影响构造链 |
| 构造器 | 只在 Base，mixin 不写构造器 | 官方规则：mixin 构造器须 `...args: any[]` rest 透传，规避 |
| 跨簇互调 | `this.requireNode(...)` 直接调用 | 运行时在最终类原型链上解析，类型自动正确 |
| 每簇文件 import | 只 import 类型/工具模块 | 零循环（簇不 import store.ts，type-only 例外） |

### 3.3 方法分配（与 cluster-dag 测试一致）

- **graph.ts (15)**: linkNodes, getRelations, mergeNodes, splitNode, getNodeTransform,
  routeNodes, routeNodesByVector, trainRouter, edgeStability, nodeActivation,
  relationActivation, reconcileConsolidation, consolidationEvents, proposeTopologyChanges,
  topologyProposals, reviewTopologyProposal
- **retrieval.ts (11)**: searchContext, searchContextWithSecondPass, getContext,
  residentKernel, recallCues, search, searchByVector, searchByVectorCandidates,
  searchHierarchyByVector, searchLeafBlocks, searchNodeFirst
- **writes.ts (9)**: remember, rememberInner, addMemory, appendHistory, deriveMemory,
  recordRejectedWrite, recordUsage, archiveSession, getSessionArchive
- **maintenance.ts (30)**: deleteMemory, setMemoryStorageState, retentionCandidates,
  promoteMemory, demoteMemory, expireShortTermMemories, memoryWriteEvents,
  getHistoryBySourceMessage, rebuildVectorIndex, rebuildLeafBlocks, rebuildDueLeafBlocks,
  dirtyLeafNodeIds, pendingIndexDelta, acknowledgeIndexDelta, beginEmbeddingIndex,
  completeEmbeddingIndex, failEmbeddingIndex, embeddingIndexHealth, contradictionNotes,
  recordRetrievalTrace, perfAggregates, retrievalTracesCount, pruneRetrievalTraces,
  retrievalTrace, recordActiveGraphUse, recordConsolidationEvent, rebalanceNode,
  rebalanceDueNodes, upsertNode, getNodeTransform
- **留在 Base（src/core/store/base.ts）**:构造/close + 外部 embedding API
  （embeddingDocuments 等 16 个）+ 跨簇共享的 protected helpers
  （requireNode、rememberInner、searchWithVector 等 33 个，无簇调用它们，
  簇通过 `this.` 调用）

## 4. 实施步骤（每步独立可提交）

| Phase | 内容 | 验收 |
| --- | --- | --- |
| 0 ✅ | `#` → `protected` 剥离（422 处，已提交 f3cd3b7） | tsc 0 错误，357 测试绿 |
| 1 | 建 `store-ctor.ts`（Constructor 类型）+ 守卫测试（红） | 守卫红（簇文件不存在，预期），lint/prettier 绿 |
| 2 | 4 簇并行（子 agent 各搬一簇 + 行为测试） | 每簇：tsc 绿、测试绿、方法体零改动 |
| 3 | 组装 extends 链（基类抽到 base.ts，删簇中方法于 store.ts） | 守卫全绿，tsc 绿，357 测试绿 |
| 4 | 提交（测试先行，实现后行） | 工作树干净 |

**Phase 2 关键约束**（上次教训）:

- 每个 agent 只读 `src/core/store.ts`、只写自己的簇文件，**不动 store.ts**
- 方法体逐字节保留（`git diff` 抽查）
- `this.` 前缀原样（mixin 里合法，不是上次的 `store.`）
- 组装由主进程手工做（禁脚本自动化），每步 tsc + 全量测试

**Phase 3 组装清单（2026-07-31 验证）**:

- 跨簇调用矩阵：graph → maintenance；retrieval → graph, maintenance；
  writes → maintenance, graph；maintenance → ∅（无环，mixin 链顺序已定）
- 簇内/簇外 base helper 调用占比 42–76%，全部走原型链，方法体零改动成立
- **3 个 base 保留方法调用簇方法**（抽 base.ts 时必须在基类声明 stub，
  子类 mixin 覆盖）：
  - `recordActiveGraphUseInner` (2158-2255) → recordUsage, trainRouter
  - `searchWithVector` (3318-3489) → routeNodes
  - `redirectRelations` (3980-4004) → linkNodes
  - 需声明的 stub 签名：`recordUsage(memoryIds: string[]): void`、
    `trainRouter(query, usefulNodeIds, learningRate = 0.2): void`、
    `routeNodes(query, limit = 5): NodeRoute[]`、
    `linkNodes(input): NodeRelation`
- **stub 而非 abstract**（2026-07-31 实证）：测试用 `node --experimental-strip-types`
  直接跑源码，而 strip-types **不支持** `abstract` 方法（除非整个类是
  `abstract class`，那样不能实例化）。改用「声明签名 + `throw new Error` 体」
  的 stub：类型上 base 方法可调用，运行时永远被簇 mixin 覆盖（stub 不可达），
  且完全兼容 strip-types（probe 已验证 `graphOp: 2` 正确输出）。
  官方约束「mixin 不能声明 private/protected properties」只针对**属性**；
  基类声明 protected 字段/方法、mixin 覆盖为 public（可见性加宽）合法。
- **`Constructor` 必须 `new (...args: any[])`**（TS2545 实证）：`never[]` 会在
  组装时报 "mixin class must have a constructor with a single rest parameter of
  type 'any[]'"。已修复 store-ctor.ts（Phase 1 误用 never[]）。
- **strip-types 全链路验证**（2026-07-31 probe）：泛型类表达式 mixin + stub 覆盖 +
  base 方法经 this 调 stub + 跨 mixin 原型链调用，`node --experimental-strip-types`
  直接跑源码全部正确（子 agent 测试模式的前提）。
- `NmgStoreBase` 零直接引用（全部 `new NmgStore`），abstract 无运行风险
- 基类保留 50 成员：16 外部 embedding API + routeLeafBlocksByVector +
  33 protected helpers（requireNode、searchWithVector、markIndexDelta 等）

## 5. 测试计划

**先写（Phase 1，红→绿）**:

1. `tests/core/store/cluster-dag.test.ts`（复用既有，已按 mixin 形态调整）:
   每簇文件存在且定义簇方法、簇不 import store.ts（无环）、store.ts 组装链存在
2. `tests/core/store/assembly-guard.test.ts`:每簇方法在 store.ts 已删除（无残留体）

**每簇（Phase 2）**:簇行为测试（agent 编写，复用上次已写并经 97 例验证的测试）

**最终（Phase 3）**:全量 357 + 守卫全绿 + tsc/eslint/prettier

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| mixin 顺序/构造问题 | 只有 Base 有构造器，mixin 无构造器；顺序固定 |
| protected 泄露 | 字段仅子类可见，外部 API 面不变（无新增 public） |
| tsc 爆栈复发 | 继承模式非结构赋值，官方背书；Phase 0 先验证 |
| 方法体搬移出错 | 每簇 tsc + 测试双验证，抽查 git diff |
| graph.ts 上次损坏 | Phase 2 禁脚本，agent 手写 + 主进程验收 |

## 7. 非目标

- 不改任何方法体逻辑（纯搬移）
- 不引入新依赖（无 mixin 库，纯 TS 官方模式）
- 不拆 Base 里的外部 embedding API（无簇调用，无收益）
- 不做转发器/自由函数/StoreDeps 接口（上次方案，弃用）
