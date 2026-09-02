---
name: complexity-reduction
description: Reduce cyclomatic complexity in NMG code (CodeFactor Complex Method, or local tools/complexity-gate.ts). Use when a method is flagged as too complex, or before committing code that grows a method's branching.
---

# Complexity reduction

Cyclomatic complexity counts linearly independent paths through a method: every
`if`, `else if`, `for`, `while`, `case`, `catch`, `&&`, `||`, and `?:` adds one.
High complexity means many paths to test and maintain. CodeFactor enforces a
threshold on the PR diff; the local
[`complexity:gate`](../../package.json) does the same before push.

## When to use

- CodeFactor reports `Complex Method` on your PR.
- `npm run complexity:gate` fails (a changed method grew, or a new method
  exceeds the cap).
- You are about to add branching to an already-large method.

## Diagnose first

Identify which methods are over the threshold and whether you introduced them:

```text
npx eslint --rule '{"complexity": ["error", 15]}' <file>       # per-method complexity
git show <base>:<file> | npx eslint --stdin --stdin-filename <file> \
  --rule '{"complexity": ["error", 15]}'                       # baseline (was it already complex?)
```

If a flagged method is **unchanged from the baseline** it is pre-existing debt,
but CodeFactor still requires it under the threshold when the file is in the
diff — reduce it anyway (it is a reviewable improvement, not a no-op).

## The four techniques (in order of value)

### 1. Guard clauses (fail fast, keep the main path linear)

Replace nested `if` trees with early returns. This is the single biggest win.

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

### 2. Composed functions (extract one thing per function)

If a function does multiple things — often signalled by comment blocks like
`// Step 2: ...` — extract each into a small helper. The caller becomes
orchestration; each helper has few branches.

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

### 3. Lookup tables instead of switch/if chains

Replace bulky `switch` or long `if/else` with a `Record`/`Map` keyed by the
discriminant. Removes the branching entirely.

```ts
// Before
if (kind === 'grep') return grepHitPaths(v, a)
if (kind === 'read') return readHitPaths(v, a)
return []

// After (when the branches are data-driven)
const EXTRACTORS = { grep: grepHitPaths, read: readHitPaths }
return EXTRACTORS[kind] ? EXTRACTORS[kind](v, a) : []
```

### 4. Modern language features (optional chaining, nullish coalescing)

`value && value.x` and `value ? value.x : default` are branches. Prefer
`value?.x` and `value ?? default` where the semantics match — they read as one
expression, not a decision.

```ts
// Before
const v = result && result.isError ? undefined : result && result.value
const args = (exec && exec.arguments) || {}

// After
const v = result && !result.isError ? result.value : undefined   // keep the guard
const args = exec?.arguments ?? {}
```

(Do not force this where the original `&&`/`||` has different semantics — guard
clauses and extraction are the reliable wins; this is a readability polish.)

## Worked example (NMG dsh-nmg scope observer)

A real fix reduced `collectScopePaths` from **37 → below threshold**:

1. **Guard clauses**: tool-name check and FileIndex-service check became early
   returns before any extraction logic.
2. **Composed functions**: the body was split into
   `extractHitPaths` (dispatch) → `grepHitPaths` / `readHitPaths` (per-tool
   extraction). The recorder loop stayed in the caller.
3. The per-tool helpers each kept their defensive `typeof` checks, so behavior
   was unchanged — only the branch count per function dropped.

## Verify

```text
npx eslint --rule '{"complexity": ["error", 15]}' <changed-file>   # every method ≤ 15
npm run complexity:gate                                             # diff-aware gate
npm run check                                                       # types
```

Run the file's tests after the refactor — the extraction must not change
behavior. If CodeFactor still flags a method, check whether it is a **different**
method than the one you fixed (it re-scans the whole diff file).
