# 零件货架

一次性脚本是回答一次性问题的正常方式。**把已经存在的零件再写一遍，不是。**

本页就是货架。每一条都做到**不打开实现就能从一次性脚本里调用**：它做什么、签名是什么、
能跑通的最小调用是什么。零件是库里的 import，**永远不是新的 CLI 子命令**——一次性需求不足以
支撑一个别人不会调用的表面。

控制平面的零件来自 `src/rcp/index.ts`；脚本辅助件来自 `tools/parts`。示例里的路径假设脚本
位于 `tools/` 下。

## 契约与路由

### `compileContractFile(path)`

读一份 `.rcp/contracts/*.yaml` 并编译。
`(path: string) => CompileContractResult` —— `{ ok, diagnostics, contract? }`

```ts
import { compileContractFile } from "../src/rcp/index.ts";

const compiled = compileContractFile(".rcp/contracts/repository-control-plane.yaml");
if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
const contract = compiled.contract!;
```

### `compileContract(source)`

同上，但源码文本已经在你手上。
`(source: { text: string; path: string }) => CompileContractResult`

```ts
const compiled = compileContract({ text: readFileSync(file, "utf8"), path: file });
```

### `readRouteDeclarations(root)`

读 `agent-context.yaml` 并返回其中的路由。`(root: string) => RouteDeclaration[]`

```ts
const routes = readRouteDeclarations(process.cwd());
```

### `selectRoutes(contract, declarations)`

只保留契约要求的那些路由声明。
`(contract: RepositoryContractIr, declarations: RouteDeclaration[]) => RouteDeclaration[]`

```ts
const selected = selectRoutes(contract, readRouteDeclarations(root));
```

### `planWorkOrder(input)`

契约 + 观察 + 路由 → 一个 WorkOrder，不执行任何东西。
`({ contract, observation, routes, operationKey?, executionTimeoutMs?, narrow? }) => WorkOrder`

```ts
const order = planWorkOrder({ contract, observation, routes: selected });
console.log(order.checks.length, order.authority);
```

## 验证

### `buildRouteVerificationPlan(routes)`

这些路由要求的检查。`(routes: RouteDeclaration[]) => VerificationPlan` —— `{ blocking, advisory }`

```ts
const plan = buildRouteVerificationPlan(selected);
console.log(plan.blocking.map((item) => item.command));
```

### `executeVerificationPlan(plan, options)`

执行计划。`(plan, { includeAdvisory?, dryRun?, run }) => Promise<VerificationRunResult>`
—— `{ ok, results }`

```ts
const run = await executeVerificationPlan(plan, {
  run: npmCommandRunner(root, true, 600_000),
});
if (!run.ok) console.error(run.results.filter((result) => !result.ok));
```

### `npmCommandRunner(root, quiet, timeoutMs)`

默认的 `CommandRunner`：把计划项当 npm 脚本跑。
`(root, quiet: boolean, timeoutMs: number) => CommandRunner`

### `runNpmScriptCheck(root, name, timeoutMs, streamOutput?)`

跑单个 npm 脚本并拿到结构化结果。
`(root, name, timeoutMs, streamOutput = false) => VerificationCheckResult`

```ts
const check = runNpmScriptCheck(root, "docs:check", 300_000);
console.log(check.ok, check.exitCode, outputTail(check.output ?? ""));
```

### `resolveRouteTestFiles(root, patterns)`

把路由的测试 glob 展开成真实文件。某个 pattern 匹配不到时返回 `[]`——是否算错误由调用方决定。
`(root: string, patterns: string[]) => string[]`

### `nodeTestCheckName(routeId)`

路由的测试被记录在哪个检查名下。
`(routeId: string) => string` —— `node-test:<routeId>`

### `testOutputPassed(output)`

判定 TAP 输出是否通过。**fail-closed**：计数器缺失、任何失败、cancelled、skipped、todo 一律返回 false。
`(output: string) => boolean`

```ts
if (!testOutputPassed(result.stdout)) throw new Error("tests did not pass");
```

### `outputTail(value, limit?)`

输出的尾部若干字符，空则 `undefined`。`(value, limit = 8000) => string | undefined`

## Reconcile

### `reconcileOnce(request, providers)`

一次完整运行：观察 → 计划 → 执行 → 写收据。
`(request: ReconcileRequest, providers: ControlPlaneProviders) => Promise<ReconciliationResult>`

```ts
import {
  compileContractFile,
  readRouteDeclarations,
  reconcileOnce,
  DefaultPolicyProvider,
  ExternalWorkspaceHarnessProvider,
  FileReceiptSink,
  LocalNpmVerifierProvider,
  LocalRepositoryProvider,
  NarrowVerifierProvider,
} from "../src/rcp/index.ts";

const contract = compileContractFile(contractPath).contract!;
const result = await reconcileOnce(
  { root, contract, routes: readRouteDeclarations(root), requestedMode: "plan" },
  {
    repository: new LocalRepositoryProvider(),
    policy: new DefaultPolicyProvider(),
    harness: new ExternalWorkspaceHarnessProvider(),
    verifier: new LocalNpmVerifierProvider(), // 窄路线换成 NarrowVerifierProvider
    receipts: new FileReceiptSink(".rcp/receipts"),
  },
);
// result.status · result.workOrder · result.receipt
```

`providers` 必填 `repository`、`policy`、`harness`、`verifier`、`receipts`；
`memory` 与 `forge` 可选。走窄路线时传 `request.narrow`（`NarrowPlanInput`）并把 verifier 换成
`NarrowVerifierProvider`；`NARROW_SHARED_CHECKS` 是窄路线里永远要跑的共享检查集。

### `changedPaths(before, after)`

两次观察之间发生变化的路径。
`(before: ObservedRepository, after: ObservedRepository) => string[]`

```ts
const provider = new LocalRepositoryProvider();
const before = await provider.observe({ root, contract });
// …改点东西…
const changed = changedPaths(before, await provider.observe({ root, contract }));
```

## 收据

### `digestCanonical(value)`

任意 JSON 值的稳定 sha256。`(value: unknown) => string`

### `receiptId(receipt)`

收据自身的 id，计算时排除 `receiptId` 字段。`(receipt) => string`

### `validateReceipt(receipt)`

`(receipt: RepositoryReceipt) => { valid: boolean; errors: string[] }`

```ts
const { valid, errors } = validateReceipt(JSON.parse(readFileSync(path, "utf8")));
if (!valid) throw new Error(errors.join("\n"));
```

## 外部验证器（trusted）

### `installTrusted(repository, revision, destination)`

在固定 revision 上安装一个已审阅的验证器。`(repository, revision, destination) => Installation`

### `verifyTrusted(root, repository, revision)`

复核已安装的验证器是否仍与审阅过的 revision 一致。
`(root, repository, revision) => TrustedResult`

## 脚本辅助件，来自 `tools/parts`

供一次性脚本与 evals 使用、而非产品使用的零件。

### `writeJsonAtomic(path, value)`

写 JSON，使读者看到的要么是旧文件、要么是完整的新文件，绝不会读到半截写入。自动创建父目录，
不留临时文件。`(path: string, value: unknown) => void`

```ts
import { writeJsonAtomic } from "../../tools/parts/fs.ts";

writeJsonAtomic("evals/controller-shadow/results/latest.json", artifact);
```

### `mapConcurrent(values, limit, worker)`

并发运行 `worker` 处理 `values`，最多 `limit` 个在飞，结果顺序与输入一致。
`<Input, Output>(values: readonly Input[], limit: number, worker: (value: Input) => Promise<Output>) => Promise<Output[]>`

```ts
import { mapConcurrent } from "../../tools/parts/async.ts";

const rows = await mapConcurrent(cases, 4, async (item) => runCase(item));
```

### `definedEnvironment(extra?)`

`process.env` 去掉 undefined 值。`extra` 先展开，所以同名时环境变量胜出。
`(extra?: Record<string, string>) => Record<string, string>`

```ts
import { definedEnvironment } from "../../tools/parts/env.ts";

const env = definedEnvironment(benchmarkCredentialEnvironment(root));
```

### 百分位家族，来自 `tools/parts/stats.ts`

eval 脚本里曾有四种约定，它们**故意不一致**：同样的输入、同样的 `q`，结果不同。所以每个获得
自己的名字，而不是加一个 `method` 参数；那 11 处本地副本现在都 import 这里。它们都会先复制
一份再排序，空序列返回 `0`。

| 零件                               | 下标公式                   | 在 `[10,20,30,40,50]` 上 |
| ---------------------------------- | -------------------------- | ------------------------ |
| `percentileFloor(values, q)`       | `min(n-1, floor(n*q))`     | `q=0.6` → 40             |
| `percentileNearestRank(values, q)` | `max(0, ceil(n*q) - 1)`    | `q=0.2` → 10             |
| `percentileScaled(values, q)`      | `min(n-1, round((n-1)*q))` | `q=0.6` → 30             |
| `median(values)`                   | `floor(n/2)`               | 30                       |
| `mean(values)`                     | 算术平均                   | 30                       |

```ts
import { mean, percentileNearestRank } from "../../tools/parts/stats.ts";

const p95 = percentileNearestRank(latencies, 0.95);
```

### 整数，来自 `tools/parts/numbers.ts`

eval 脚本里有三个都叫 `positiveInteger` 的辅助函数。其中两个是零件；第三个——把数字截断、
缺失时用 fallback——只有一个调用者，留在原地。

| 零件                                    | 行为                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `requirePositiveInteger(value, label?)` | 严格；用 `Number`，所以 `"12abc"` 报错而不是被读成 12 |
| `positiveIntegerOr(text, fallback)`     | 宽松；用 `parseInt`，缺失或非法时用 fallback          |

```ts
import { positiveIntegerOr, requirePositiveInteger } from "../../tools/parts/numbers.ts";

const epochs = requirePositiveInteger(options.epochs ?? 40, "epochs");
const concurrency = positiveIntegerOr(process.env.NMG_BENCH_CONCURRENCY, 4);
```

## 还在本地重复的

2026-09-09 统计：在 `tools/`、`scripts/`、`evals/` 下，同一个定义出现在两个或更多一次性脚本里的次数。

| 家族              | 剩余本地副本 | 状态                                                                         |
| ----------------- | ------------ | ---------------------------------------------------------------------------- |
| `percentile`      | 0            | 已迁移——每处用自己的名字保留自己的公式                                       |
| `mean`            | 1            | `src/lab/controller-protocol.ts` 自带；产品代码不能反向依赖                  |
| `positiveInteger` | 2            | 拆成 `requirePositiveInteger` / `positiveIntegerOr`；截断那支只有 1 个消费者 |
| `ratio`           | 8            | 还没看                                                                       |
| `parseArgs`       | 7            | 删——`node:util` 自带 `parseArgs`                                             |
| `createClient`    | 5            | **不做零件**：五处接的客户端各不相同                                         |

当**第二个**脚本需要它时上架，放在两个脚本都能 import 的地方——不要放进 `src/rcp`，
除非它与控制平面有关。成员语义不一致的家族不合并成一个名字，而是一种含义一个名字。

## 零件永远不携带什么

零件只携带**装配**，从不携带**判断**。窄还是全量、改动是否可以接受，只能留在一处被审查的
地方。见 `docs/decisions/proposed/2026-09-09-gates-assert-results-not-tools.md`。

## 本页如何保持诚实

如果本页提到的某个零件 `src/rcp` 与 `tools/parts` 都不再导出，`docs:check` 会失败。代码里的
签名仍是权威，本页的示例是示意而非执行——**改名会被检查拦住，签名变更不会**。工作流见
`skills/script-reuse/SKILL.md`。
