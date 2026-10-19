# 可组合测试运行时与行为片段

[English](composable-test-runtime.md) · [术语](composable-test-runtime.terms.yaml)

**权威范围：**[CI 与质量](../ci-cd-and-quality.zh-CN.md#可组合测试运行时)。

## 资源与回收

Cordis 本身只出现在 `tests/support/cordis-adapter.ts`。该文件只导出
`createTestRuntime()`，返回可组合 effect 与幂等 `dispose()` 的最小生命周期对象；它不导入 NMG
Core、CLI 或 daemon。需要文件系统、SQLite 和 daemon 的集成测试再由
`tests/support/test-runtime.ts` 组合 NMG 专用资源：

```text
TestRuntime
├── testWorkspace
├── testDatabase
└── testDaemon
```

测试通过 `withTestRuntime(...)` 或显式 `dispose()` 获取 RAII 式回收。插件依赖必须显式：database 要求 workspace，daemon 要求 database；缺少依赖时失败，不偷偷创建隐含全局状态。daemon 在进程内使用真实 HTTP JSON-RPC handler，因此能验证协议，同时不会遗留后台进程。

测试资源按断言需观察的边界分为四类，按需取得最轻且隔离的资源（[决策](../../decisions/implemented/2026-09-24-resource-matched-test-fixtures.md)）：

| 断言边界 | 测试资源 | 可省的准备工作 |
| --- | --- | --- |
| 纯数据或决策 | 进程内输入 | 工作区、数据库和外部进程 |
| 单个 SQLite 连接的读写 | 每项独立的 `:memory:` store | 临时数据库文件及其清理 |
| 重开、旧库迁移、WAL、独立连接或路径 | 每项唯一的文件数据库或工作区 | 与断言无关的额外文件和服务 |
| CLI、Git、HTTP、daemon lease 或跨进程共享 | 断言这些边界时使用实际进程、端口及所需工作区 | 不参与断言的重复启动和检查 |

观察文件或跨进程语义的测试保留真实边界；只断言控制平面策略、receipt 或 harness 编排时，可以注入固定的 `RepositoryProvider` 观察值，另由真实 Git 集成测试覆盖发现、dirty 范围、提交和 forge 绑定。集成 `testDatabase()` 使用真实文件路径供 daemon 共享。真实 Git fixture 保留 `init/add/commit`，提交身份只传给 `commit`，避免每项再启动两次 `git config`。资源类别只决定 fixture 和可安全减少的准备工作，不改变 Safety/Contract/Guardrail 分类、阻塞地位或 narrow/full 验证范围；后两者由既有 route 与验证契约决定。

该层精确锁定 `@deepseek-ai/cordis@4.0.1` 作为 **devDependency**，只借用插件 effect/fiber 生命周期。NMG Core、daemon、Pi adapter 和发布包均不依赖 Cordis；不引入其 loader、HMR 或配置系统。Cordis adapter 与 NMG fixture composition 分离，未来若替换框架只需修改生命周期 adapter。

依赖 Node 显式 GC 的堆增长检查只在 `global.gc` 可用时执行；不可用时通过 `node:test` 的 skip 报告未执行，不用恒真断言代替。`tests/core/robustness.test.ts` 的 HA 无 NaN 压力检查与堆增长检查是两个具名用例，缺少 GC 不跳过前者。显式入口为 `node --expose-gc --experimental-strip-types --test tests/core/robustness.test.ts`；该见证不声明所有分配模式都无泄漏。取舍由[执行结果报告决策](../../decisions/implemented/2026-10-13-runnable-suites-and-executed-checks.zh-CN.md)拥有。

## 行为片段

行为组合不属于资源生命周期层。场景构造留在消费者本地；`tests/support/task-board-behavior.ts` 的 `claimAndDeliver` 作用于调用者已有的 entry 引用，组合领取与交付。交付和保留期测试显式传入身份、digest、租期及 `now`，取得实际交付快照。时间输入只控制这两个动作，不代表创建、最终处理或整个测试都使用可注入时钟。

两个动作是独立写入，不保证原子性；交付失败保留成功的领取，异常直接传播。需要观察两步之间状态或单独验证拒绝动作时，测试直接调用 store API。

`tests/support/node-graph-behavior.ts` 的 `linkNodePath(store, nodeIds, relationType)` 在已有节点上按输入顺序连接相邻 ID，返回每次 `linkNodes` 的实际快照。空路径或单节点路径返回空数组且不写入。重复端点、显式回边及重复边的重连结果均保留；函数不创建节点、排序、去重、自动闭环或套用 memory-chain 的 DAG 限制。各边独立写入并使用产品时钟；后续边失败时异常原样传播，成功前缀仍可观察，不补事务或回滚。场景创建、关系元数据写入、幂等／evidence 合并判定及逐边中间观察留在消费者。

既有具名声明、断言与资源生命周期保留，不引入 DSL 或生成器；[行为组合决策](../../decisions/implemented/2026-10-12-deliverable-tests-compose-behavior.zh-CN.md)拥有取舍。
