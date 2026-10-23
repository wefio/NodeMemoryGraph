---
name: complexity-reduction
description: 降低 NMG 代码的圈复杂度（CodeFactor Complex Method，或本地 `tools/complexity-gate.ts`）。方法被标记为过于复杂，或提交前要给分支已很多的方法增加分支时使用。
---

# 降低圈复杂度

[English](SKILL.md) · [使用的术语](SKILL.terms.yaml)

圈复杂度统计方法中线性独立的执行路径：每个 `if`、`else if`、`for`、`while`、`case`、`catch`、`&&`、`||` 和 `?:` 都会增加一。复杂度高意味着需要测试和维护的路径更多。CodeFactor 会对 PR diff 执行阈值检查；本地 [`complexity:gate`](../../package.json) 会在 push 前做同类检查。

## 何时使用

- CodeFactor 在 PR 上报告 `Complex Method`。
- `npm run complexity:gate` 失败（被修改的方法复杂度增加，或新方法超过上限）。
- 准备给一个已经很大的方法增加分支。

## 先诊断

找出哪些方法超过阈值，以及它们是否由本次改动引入：

```text
npx eslint --no-config-lookup --format json \
  --rule '{"complexity": ["error", 15]}' <file>                 # 每方法复杂度

git show <base>:<file> | npx eslint --no-config-lookup --format json \
  --stdin --stdin-filename <file> --rule '{"complexity": ["error", 15]}'   # 基线（此前是否已超限？）
```

仅加规则的运行必须传 `--no-config-lookup`（ESLint 9 否则会把仓库配置合并进
来），并用 `--format json`（文本格式不稳定、难以解析）。

### 基线陷阱：在 main 上 gate 是自引用的

`complexity:gate` 的基线默认取与 `origin/main` 的 merge base。在功能分支上
这是正确的，但**在 main 本身 merge base 就是 HEAD**，于是每个超限都读作
"unchanged from baseline"，gate 永远报 ok。在 main 上审计或在合并之后，要
对照实际已落地的状态度量：

```text
git fetch origin
npm run complexity:gate -- --base origin/main
```

gate 失败时会点名本 skill；当文件进入 diff 时，CodeFactor 对与基线相比未变
化的方法也执行同样阈值——仍应降低。

如果被标记的方法与基线相比**没有变化**，它是既有债务；但当该文件进入 diff 时，CodeFactor 仍要求它低于阈值——仍应降低复杂度（这是可审查的改进，不是无效改动）。

## 四种技巧（按价值排序）

### 1. Guard clause（守卫子句，快速失败，让主路径线性）

用提前返回代替嵌套 `if` 树。这通常是收益最大的单项改动。

```ts
// Before — arrow anti-pattern (deep nesting)
function collect(exec, result) {
  const name = exec && exec.name
  if (name) {
    const fileIndex = ctx.get('fileIndex')
    if (fileIndex && typeof fileIndex.addScopePath === 'function') {
      // ... work
    }
  }
}

// After — linear flow
function collect(exec, result) {
  const name = exec && exec.name
  if (!name) return
  const fileIndex = ctx.get('fileIndex')
  if (!fileIndex || typeof fileIndex.addScopePath !== 'function') return
  // ... work at one nesting level
}
```

### 2. 组合函数（每个函数只提取一件事）

如果函数执行多项工作——常可从 `// Step 2: ...` 这类注释块看出来——将每项工作提取到小型 helper。调用方负责编排；每个 helper 的分支都较少。

```ts
// Before: one function with grep + read extraction + recording
function observe(exec, result) { /* 20+ branches */ }

// After: orchestration + helpers
function observe(exec, result) {
  if (!isObservable(exec)) return
  const index = ctx.get('fileIndex')
  if (!index) return
  for (const path of extractPaths(exec, result)) index.addScopePath(path)
}
function isObservable(exec) { /* 1 branch */ }
function extractPaths(exec, result) { /* dispatches to per-tool helpers */ }
function grepHitPaths(value, args) { /* one tool's extraction */ }
function readHitPaths(value, args) { /* the other */ }
```

### 3. 用查找表代替 switch/if 链

将庞大的 `switch` 或长 `if/else` 链替换为以判别值为 key 的 `Record`/`Map`。这样可以完全移除分支。

```ts
// Before
if (kind === 'grep') return grepHitPaths(v, a)
if (kind === 'read') return readHitPaths(v, a)
return []

// After (when the branches are data-driven)
const EXTRACTORS = { grep: grepHitPaths, read: readHitPaths }
return EXTRACTORS[kind] ? EXTRACTORS[kind](v, a) : []
```

### 4. 现代语言特性（可选链、空值合并）

`value && value.x` 和 `value ? value.x : default` 都构成分支。语义相符时优先使用 `value?.x` 和 `value ?? default`——它们读起来是一个表达式，而不是一次决策。

```ts
// Before
const v = result && result.isError ? undefined : result && result.value
const args = (exec && exec.arguments) || {}

// After
const v = result && !result.isError ? result.value : undefined   // keep the guard
const args = exec?.arguments ?? {}
```

（原始 `&&`/`||` 语义不同的地方不要强行替换——守卫子句和提取函数是可靠的改进；这一步只是可读性润色。）

## 示例（NMG dsh-nmg scope observer）

一次真实修复将 `collectScopePaths` 从 **37 降至阈值以下**：

1. **Guard clause：** 工具名称检查和 FileIndex service 检查改为提前返回，置于任何提取逻辑之前。
2. **组合函数：** 将函数体拆为 `extractHitPaths`（dispatch）→ `grepHitPaths` / `readHitPaths`（各工具的提取逻辑）。记录器循环仍留在调用方。
3. 各工具 helper 都保留防御性的 `typeof` 检查，因此行为不变——只减少每个函数中的分支数。

## 验证

```text
npx eslint --rule '{"complexity": ["error", 15]}' <changed-file>   # every method ≤ 15
npm run complexity:gate                                             # diff-aware gate
npm run check                                                       # types
```

重构后运行该文件的测试——提取逻辑不得改变行为。如果 CodeFactor 仍标记某方法，检查它是否与已修复的方法**不同**（CodeFactor 会重新扫描整个 diff 文件）。