# 可复用部件清单

[English](parts.md) · [术语](parts.terms.yaml)

一次性问题通常用一次性脚本解决。已经存在的部件不应再写第二份。

本页是部件清单。每个条目都应能让人**无需打开实现即可从一次性脚本调用**：说明用途、签名和最小可用调用。部件是库导入，不是新的 CLI 子命令——一次性需求不足以证明需要一个没人会复用的命令入口。

控制面部件来自 `src/rcp/index.ts`；脚本辅助函数来自 `tools/parts`。示例路径假设脚本位于 `tools/` 下。

## Contract 与路由

### `compileContractFile(path)`

读取并编译 `.rcp/contracts/*.yaml`。
`(path: string) => CompileContractResult` — `{ ok, diagnostics, contract? }`

```ts
import { compileContractFile } from "../src/rcp/index.ts";

const compiled = compileContractFile(".rcp/contracts/repository-control-plane.yaml");
if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
const contract = compiled.contract!;
```

### `compileContract(source)`

同上，但读取已经持有的文本。
`(source: { text: string; path: string }) => CompileContractResult`

```ts
const compiled = compileContract({ text: readFileSync(file, "utf8"), path: file });
```

### `readRouteDeclarations(root)`

读取 `agent-context.yaml` 并返回其路由。`(root: string) => RouteDeclaration[]`

```ts
const routes = readRouteDeclarations(process.cwd());
```

### `selectRoutes(contract, declarations)`

保留契约要求的声明。
`(contract: RepositoryContractIr, declarations: RouteDeclaration[]) => RouteDeclaration[]`

```ts
const selected = selectRoutes(contract, readRouteDeclarations(root));
```

### `planWorkOrder(input)`

Contract + observation + routes → 一个 WorkOrder；不执行任何操作。
`({ contract, observation, routes, operationKey?, executionTimeoutMs?, narrow? }) => WorkOrder`

```ts
const order = planWorkOrder({ contract, observation, routes: selected });
console.log(order.checks.length, order.authority);
```

## 验证

### `buildRouteVerificationPlan(routes)`

这些路由要求的检查。`(routes: RouteDeclaration[]) => VerificationPlan` — `{ blocking, advisory }`

```ts
const plan = buildRouteVerificationPlan(selected);
console.log(plan.blocking.map((item) => item.command));
```

### `executeVerificationPlan(plan, options)`

执行该计划。`(plan, { includeAdvisory?, dryRun?, run }) => Promise<VerificationRunResult>` — `{ ok, results }`

```ts
const run = await executeVerificationPlan(plan, {
  run: npmCommandRunner(root, true, 600_000),
});
if (!run.ok) console.error(run.results.filter((result) => !result.ok));
```

### `npmCommandRunner(root, quiet, timeoutMs)`

默认 `CommandRunner`：将计划中的每一项作为 npm script 运行。
`(root, quiet: boolean, timeoutMs: number) => CommandRunner`

### `runNpmScriptCheck(root, name, timeoutMs, streamOutput?)`

运行一个 npm script 并返回结构化结果。
`(root, name, timeoutMs, streamOutput = false) => VerificationCheckResult`

```ts
const check = runNpmScriptCheck(root, "docs:check", 300_000);
console.log(check.ok, check.exitCode, outputTail(check.output ?? ""));
```

### `resolveRouteTestFiles(root, patterns)`

将路由的 test glob 展开为实际文件。模式没有匹配项时返回 `[]`——调用方决定这是否是错误。
`(root: string, patterns: string[]) => string[]`

### `nodeTestCheckName(routeId)`

路由测试所记录的检查名称。`(routeId: string) => string` — `node-test:<routeId>`

### `testOutputPassed(output)`

判断 TAP 输出是否通过。Fail-closed：缺少计数器、出现任何失败、取消、跳过或 todo 都返回 `false`。
`(output: string) => boolean`

```ts
if (!testOutputPassed(result.stdout)) throw new Error("tests did not pass");
```

### `outputTail(value, limit?)`

返回输出末尾字符；输出为空时返回 `undefined`。`(value, limit = 8000) => string | undefined`

## Reconcile

### `reconcileOnce(request, providers)`

执行一次完整运行：observe → plan → execute → 写入 receipt。
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
    verifier: new LocalNpmVerifierProvider(), // 窄路由使用 NarrowVerifierProvider
    receipts: new FileReceiptSink(".rcp/receipts"),
  },
);
// result.status · result.workOrder · result.receipt
```

`providers` 必须包含 `repository`、`policy`、`harness`、`verifier`、`receipts`；`memory` 和 `forge` 可选。对于窄路由，传入 `request.narrow`（`NarrowPlanInput`），并切换为 `NarrowVerifierProvider`；`NARROW_SHARED_CHECKS` 是始终运行的共享检查集合。

### `changedPaths(before, after)`

返回两次 observation 之间发生变化的路径。
`(before: ObservedRepository, after: ObservedRepository) => string[]`

```ts
const provider = new LocalRepositoryProvider();
const before = await provider.observe({ root, contract });
// … change something …
const changed = changedPaths(before, await provider.observe({ root, contract }));
```

## Receipts

### `digestCanonical(value)`

对任意 JSON 值计算稳定的 sha256。`(value: unknown) => string`

### `receiptId(receipt)`

计算 receipt 自身的 ID，但计算时排除 `receiptId` 字段。`(receipt) => string`

### `validateReceipt(receipt)`

`(receipt: RepositoryReceipt) => { valid: boolean; errors: string[] }`

```ts
const { valid, errors } = validateReceipt(JSON.parse(readFileSync(path, "utf8")));
if (!valid) throw new Error(errors.join("\n"));
```

## 可信外部验证器

### `installTrusted(repository, revision, destination)`

在固定 revision 安装经过审阅的验证器。`(repository, revision, destination) => Installation`

### `verifyTrusted(root, repository, revision)`

重新检查已安装的验证器是否仍匹配已审阅的 revision。
`(root, repository, revision) => TrustedResult`

## 脚本辅助函数（来自 `tools/parts`）

这些部件供一次性脚本和 eval 使用，不属于产品代码。

### `writeJsonAtomic(path, value)`

以原子方式写入 JSON：读取者只会看到旧文件或完整的新文件，不会读到部分写入。创建父目录，且不留下临时文件。
`(path: string, value: unknown) => void`

```ts
import { writeJsonAtomic } from "../../tools/parts/fs.ts";

writeJsonAtomic("evals/controller-shadow/results/latest.json", artifact);
```

### `mapConcurrent(values, limit, worker)`

以最多 `limit` 个并发任务对 `values` 运行 `worker`，并保持输入顺序。
`<Input, Output>(values: readonly Input[], limit: number, worker: (value: Input) => Promise<Output>) => Promise<Output[]>`

```ts
import { mapConcurrent } from "../../tools/parts/async.ts";

const rows = await mapConcurrent(cases, 4, async (item) => runCase(item));
```

### `definedEnvironment(extra?)`

返回删除所有 undefined 值后的 `process.env`。`extra` 先展开，因此环境变量在冲突时优先。
`(extra?: Record<string, string>) => Record<string, string>`

```ts
import { definedEnvironment } from "../../tools/parts/env.ts";

const env = definedEnvironment(benchmarkCredentialEnvironment(root));
```

### 百分位函数族（来自 `tools/parts/stats.ts`）

百分位函数用不同名称保留各自约定，因为相同输入和 `q` 可能得到不同数字。每个百分位函数都先对输入副本排序；空序列时返回 `0`。`median` 取排序后的上中位秩；`mean` 是算术平均值。

| 部件 | 索引 | 输入 `[10,20,30,40,50]` 时 |
| --- | --- | --- |
| `percentileFloor(values, q)` | `min(n-1, floor(n*q))` | `q=0.6` → 40 |
| `percentileNearestRank(values, q)` | `max(0, ceil(n*q) - 1)` | `q=0.2` → 10 |
| `percentileScaled(values, q)` | `min(n-1, round((n-1)*q))` | `q=0.6` → 30 |
| `median(values)` | `floor(n/2)` | 30 |
| `mean(values)` | 算术平均值 | 30 |

```ts
import { mean, percentileNearestRank } from "../../tools/parts/stats.ts";

const p95 = percentileNearestRank(latencies, 0.95);
```

### 整数函数（来自 `tools/parts/numbers.ts`）

这些函数将严格数值校验与使用回退值的宽松解析分开。

| 部件 | 行为 |
| --- | --- |
| `requirePositiveInteger(value, label?)` | 严格；使用 `Number`，因此 `"12abc"` 会抛错，不会读取为 12 |
| `positiveIntegerOr(text, fallback)` | 宽松；使用 `parseInt`，输入缺失或无效时回退 |

```ts
import { positiveIntegerOr, requirePositiveInteger } from "../../tools/parts/numbers.ts";

const epochs = requirePositiveInteger(options.epochs ?? 40, "epochs");
const concurrency = positiveIntegerOr(process.env.NMG_BENCH_CONCURRENCY, 4);
```

## 没有合适部件时

本清单只列出当前存在的可调用部件，不是待开发辅助函数清单。若没有合适条目，请遵循 [script-reuse 工作流](../../skills/script-reuse/SKILL.md#when-a-part-is-missing)。

## 所有权边界

[script-reuse Skill](../../skills/script-reuse/SKILL.md#rules-about-parts) 规定何时添加部件，以及哪些判断必须留在部件之外。

## 如何保持本页准确

若本页引用的部件没有从 `src/rcp` 或 `tools/parts` 导出，`docs:check` 会失败。代码签名仍是权威来源；此处的示例仅供说明，并未执行：改名会使检查失败，签名变更不会。工作流程见 [script-reuse Skill](../../skills/script-reuse/SKILL.md)。
