# The parts shelf

One-off scripts are the normal answer to a one-off question. Writing a second copy
of a part that already exists is not.

This page is the shelf. Every entry is meant to be **callable from a one-off script
without opening the implementation**: what it does, its signature, and the smallest
call that works. Parts are library imports, never a new CLI subcommand — a one-off
need does not justify a surface nobody else will call.

Control-plane parts come from `src/rcp/index.ts`; script helpers come from
`tools/parts`. Paths in the examples assume a script under `tools/`.

## Contract and routes

### `compileContractFile(path)`

Read a `.rcp/contracts/*.yaml` and compile it.
`(path: string) => CompileContractResult` — `{ ok, diagnostics, contract? }`

```ts
import { compileContractFile } from "../src/rcp/index.ts";

const compiled = compileContractFile(".rcp/contracts/repository-control-plane.yaml");
if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join("\n"));
const contract = compiled.contract!;
```

### `compileContract(source)`

Same, from text you already hold.
`(source: { text: string; path: string }) => CompileContractResult`

```ts
const compiled = compileContract({ text: readFileSync(file, "utf8"), path: file });
```

### `readRouteDeclarations(root)`

Read `agent-context.yaml` and return its routes. `(root: string) => RouteDeclaration[]`

```ts
const routes = readRouteDeclarations(process.cwd());
```

### `selectRoutes(contract, declarations)`

Keep the declarations the contract asks for.
`(contract: RepositoryContractIr, declarations: RouteDeclaration[]) => RouteDeclaration[]`

```ts
const selected = selectRoutes(contract, readRouteDeclarations(root));
```

### `planWorkOrder(input)`

Contract + observation + routes → a WorkOrder, without executing anything.
`({ contract, observation, routes, operationKey?, executionTimeoutMs?, narrow? }) => WorkOrder`

```ts
const order = planWorkOrder({ contract, observation, routes: selected });
console.log(order.checks.length, order.authority);
```

## Verification

### `buildRouteVerificationPlan(routes)`

The checks those routes require. `(routes: RouteDeclaration[]) => VerificationPlan`
— `{ blocking, advisory }`

```ts
const plan = buildRouteVerificationPlan(selected);
console.log(plan.blocking.map((item) => item.command));
```

### `executeVerificationPlan(plan, options)`

Run the plan. `(plan, { includeAdvisory?, dryRun?, run }) => Promise<VerificationRunResult>`
— `{ ok, results }`

```ts
const run = await executeVerificationPlan(plan, {
  run: npmCommandRunner(root, true, 600_000),
});
if (!run.ok) console.error(run.results.filter((result) => !result.ok));
```

### `npmCommandRunner(root, quiet, timeoutMs)`

The default `CommandRunner`: runs each plan item as an npm script.
`(root, quiet: boolean, timeoutMs: number) => CommandRunner`

### `runNpmScriptCheck(root, name, timeoutMs, streamOutput?)`

Run one npm script and get a structured result.
`(root, name, timeoutMs, streamOutput = false) => VerificationCheckResult`

```ts
const check = runNpmScriptCheck(root, "docs:check", 300_000);
console.log(check.ok, check.exitCode, outputTail(check.output ?? ""));
```

### `resolveRouteTestFiles(root, patterns)`

Expand a route's test globs into real files. Returns `[]` when a pattern matches
nothing — the caller decides whether that is an error.
`(root: string, patterns: string[]) => string[]`

### `nodeTestCheckName(routeId)`

The check name a route's tests are recorded under.
`(routeId: string) => string` — `node-test:<routeId>`

### `testOutputPassed(output)`

Decide whether TAP output passed. Fail-closed: a missing counter, any failure,
cancelled, skipped, or todo all return false.
`(output: string) => boolean`

```ts
if (!testOutputPassed(result.stdout)) throw new Error("tests did not pass");
```

### `outputTail(value, limit?)`

Last characters of output, or `undefined` when empty. `(value, limit = 8000) => string | undefined`

## Reconcile

### `reconcileOnce(request, providers)`

One full run: observe → plan → execute → write a receipt.
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
    verifier: new LocalNpmVerifierProvider(), // NarrowVerifierProvider for the narrow route
    receipts: new FileReceiptSink(".rcp/receipts"),
  },
);
// result.status · result.workOrder · result.receipt
```

`providers` requires `repository`, `policy`, `harness`, `verifier`, `receipts`;
`memory` and `forge` are optional. For the narrow route pass
`request.narrow` (a `NarrowPlanInput`) and swap in `NarrowVerifierProvider`;
`NARROW_SHARED_CHECKS` is the shared check set that always runs.

### `changedPaths(before, after)`

Paths that differ between two observations.
`(before: ObservedRepository, after: ObservedRepository) => string[]`

```ts
const provider = new LocalRepositoryProvider();
const before = await provider.observe({ root, contract });
// … change something …
const changed = changedPaths(before, await provider.observe({ root, contract }));
```

## Receipts

### `digestCanonical(value)`

Stable sha256 of any JSON value. `(value: unknown) => string`

### `receiptId(receipt)`

The receipt's own id, computed with the `receiptId` field excluded. `(receipt) => string`

### `validateReceipt(receipt)`

`(receipt: RepositoryReceipt) => { valid: boolean; errors: string[] }`

```ts
const { valid, errors } = validateReceipt(JSON.parse(readFileSync(path, "utf8")));
if (!valid) throw new Error(errors.join("\n"));
```

## Trusted external verifier

### `installTrusted(repository, revision, destination)`

Install a reviewed verifier at a fixed revision. `(repository, revision, destination) => Installation`

### `verifyTrusted(root, repository, revision)`

Re-check that the installed verifier still matches the reviewed revision.
`(root, repository, revision) => TrustedResult`

## Script helpers, from `tools/parts`

Parts used by one-off scripts and evals rather than by the product.

### `writeJsonAtomic(path, value)`

Write JSON so a reader sees either the previous file or the complete new one, never
a partial write. Creates the parent directory and leaves no temp file behind.
`(path: string, value: unknown) => void`

```ts
import { writeJsonAtomic } from "../../tools/parts/fs.ts";

writeJsonAtomic("evals/controller-shadow/results/latest.json", artifact);
```

### `mapConcurrent(values, limit, worker)`

Run `worker` over `values`, at most `limit` at a time, keeping the input order.
`<Input, Output>(values: readonly Input[], limit: number, worker: (value: Input) => Promise<Output>) => Promise<Output[]>`

```ts
import { mapConcurrent } from "../../tools/parts/async.ts";

const rows = await mapConcurrent(cases, 4, async (item) => runCase(item));
```

### `definedEnvironment(extra?)`

`process.env` with undefined values dropped. `extra` is spread first, so the
environment wins on collision.
`(extra?: Record<string, string>) => Record<string, string>`

```ts
import { definedEnvironment } from "../../tools/parts/env.ts";

const env = definedEnvironment(benchmarkCredentialEnvironment(root));
```

### The percentile family, from `tools/parts/stats.ts`

Four conventions lived in the eval scripts and they **disagree on purpose**: the same
input and the same `q` give different numbers. So each got its own name instead of a
`method` flag, and the 11 local copies now import these. All of them sort a copy of
the input first and return `0` for an empty series.

| Part                               | Index                      | On `[10,20,30,40,50]` |
| ---------------------------------- | -------------------------- | --------------------- |
| `percentileFloor(values, q)`       | `min(n-1, floor(n*q))`     | `q=0.6` → 40          |
| `percentileNearestRank(values, q)` | `max(0, ceil(n*q) - 1)`    | `q=0.2` → 10          |
| `percentileScaled(values, q)`      | `min(n-1, round((n-1)*q))` | `q=0.6` → 30          |
| `median(values)`                   | `floor(n/2)`               | 30                    |
| `mean(values)`                     | arithmetic mean            | 30                    |

```ts
import { mean, percentileNearestRank } from "../../tools/parts/stats.ts";

const p95 = percentileNearestRank(latencies, 0.95);
```

### Integers, from `tools/parts/numbers.ts`

The eval scripts had three different helpers called `positiveInteger`. Two of them are
parts; the third — truncate a number, fall back when it is absent — has a single
caller and stays where it is.

| Part                                    | Behaviour                                                   |
| --------------------------------------- | ----------------------------------------------------------- |
| `requirePositiveInteger(value, label?)` | strict; `Number`, so `"12abc"` throws instead of reading 12 |
| `positiveIntegerOr(text, fallback)`     | lenient; `parseInt`, falls back on missing or invalid       |

```ts
import { positiveIntegerOr, requirePositiveInteger } from "../../tools/parts/numbers.ts";

const epochs = requirePositiveInteger(options.epochs ?? 40, "epochs");
const concurrency = positiveIntegerOr(process.env.NMG_BENCH_CONCURRENCY, 4);
```

## Still duplicated locally

Measured on 2026-09-09 by counting definitions that appear in two or more one-off
scripts under `tools/`, `scripts/`, and `evals/`:

| Family            | Local copies left | State                                                                                      |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `percentile`      | 0                 | migrated — every site kept its formula under its own name                                  |
| `mean`            | 1                 | `src/lab/controller-protocol.ts` keeps its own; product code must not import a script part |
| `positiveInteger` | 2                 | split into `requirePositiveInteger` / `positiveIntegerOr`; the truncating one has 1 caller |
| `ratio`           | 8                 | not looked at yet                                                                          |
| `parseArgs`       | 7                 | delete — `node:util` already has `parseArgs`                                               |
| `createClient`    | 5                 | **not a part**: all five wire different clients                                            |

Put one on the shelf when a **second** script needs it, and put it where both can
import it — not in `src/rcp`, unless it is about the control plane. A family whose
members disagree does not get merged into one name; it gets one name per meaning.

## What a part never carries

A part carries **assembly**, never **judgement**. Choosing narrow versus full, or
deciding whether a change is acceptable, stays in one reviewed place. See
`docs/decisions/proposed/2026-09-09-gates-assert-results-not-tools.md`.

## How this page stays honest

`docs:check` fails if this page names a part that neither `src/rcp` nor
`tools/parts` exports. The signatures in the code remain authoritative, and the
examples here are
illustrative rather than executed — a rename breaks the check, a signature change
does not. See `skills/script-reuse/SKILL.md` for the workflow.
