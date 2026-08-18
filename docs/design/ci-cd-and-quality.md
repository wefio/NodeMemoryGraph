# 代码质量与 CI/CD

**Created:** 2026-07-20

当前只有 `tsc --noEmit` 和 `node --test`。补上业界通用的几个即可。

---

## 1. ESLint

```powershell
npm install -D eslint @eslint/js typescript-eslint
```

**`eslint.config.js`：**

```javascript
import tseslint from "typescript-eslint";
import js from "@eslint/js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": "warn",
    },
  },
  {
    files: ["**/*.test.ts", "evals/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
```

**`package.json`：**

```json
"lint": "eslint src/ .pi/extensions/",
"lint:fix": "eslint --fix src/ .pi/extensions/"
```

---

## 2. Prettier

```powershell
npm install -D prettier
```

**`.prettierrc.json`：**

```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "trailingComma": "all",
  "semi": true,
  "singleQuote": false
}
```

```json
"format": "prettier --write 'src/**/*.ts' '.pi/**/*.ts'",
"format:check": "prettier --check 'src/**/*.ts' '.pi/**/*.ts'"
```

---

## 3. 测试覆盖率

Node.js 22 内置了覆盖率，不需要额外装包：

```json
"test:coverage": "node --experimental-strip-types --experimental-test-coverage --test src/core/*.test.ts .pi/extensions/nmg/index.test.ts"
```

或者用 c8（报告更丰富）：

```powershell
npm install -D c8
```

```json
"test:coverage": "c8 node --experimental-strip-types --test src/core/*.test.ts .pi/extensions/nmg/index.test.ts"
```

---

## 4. GitHub Actions

**`.github/workflows/ci.yml`：**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: ["22", "23"]

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - run: npm ci

      - name: Type check
        run: npm run check

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check

      - name: Unit tests
        run: npm test

      - name: Coverage
        run: npm run test:coverage

      - name: Audit
        run: npm audit --production --audit-level=high
```

如果想把需要 LLM 的 eval 也放 CI，单独开一个 workflow 用 `workflow_dispatch` 手动触发：

```yaml
# .github/workflows/eval.yml
name: Eval

on:
  workflow_dispatch:

jobs:
  eval:
    runs-on: ubuntu-latest
    env:
      DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run eval:agents
      - run: npm run eval:quality
      - run: npm run eval:adaptive
```

---

## 5. 汇总

| 工具 | 干什么 | 装不装 |
|---|---|---|
| ESLint | 未使用变量、错误 async 用法、死代码 | 装 |
| Prettier | 格式化一致 | 装 |
| c8 / node coverage | 测试覆盖率 | 装 |
| GitHub Actions | CI 自动跑 | 装 |
| CodeQL (GitHub 内置) | 安全扫描 | 免费，开 |
| Dependabot (GitHub 内置) | 依赖更新 | 免费，开 |

就这些。不需要额外的东西。
