import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The surface this config describes is the set of directories `npm run lint` scans.
// Every `files:` block must be anchored inside one of them: a block anchored
// anywhere else never runs, so its intent silently disappears.
// tests/tools/eslint-config-coverage.test.ts holds both halves of that rule — each
// block is inside the scanned roots, and each block still matches a real file.
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // The repository is Node end to end, including the `.mjs` probes under evals/
      // and the scripts/ entry points. Declaring Node globals once here is what
      // keeps `process` / `console` / `fetch` from reading as undefined globals.
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
      }],
      "no-console": "warn",
    },
  },
  {
    // Tests, research harnesses, build scripts and repository tooling report through
    // stdout by design (TAP output, measurement progress, tool diagnostics).
    files: [
      "tests/**/*.ts",
      "evals/**/*.ts",
      "evals/**/*.mjs",
      "scripts/**/*.ts",
      "scripts/**/*.mts",
      "tools/**/*.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    // The liveness rules are advisory on the developer surfaces. "This value is never
    // read" is the judgement a static tool most often gets wrong about code that is
    // alive: the three unused bindings in tests/core/graph-cycles.test.ts were reported
    // as dead code when the real defect was a missing assertion, and a blocking gate
    // would have rewarded deleting the hint. On src/ they stay errors, because product
    // code is reviewed as such and the rules have been enforced there since the start.
    // tests/tools/eslint-config-coverage.test.ts pins these severities, so promoting a
    // rule to error is a deliberate edit rather than a drift.
    files: [
      "tests/**/*.ts",
      "evals/**/*.ts",
      "evals/**/*.mjs",
      "scripts/**/*.ts",
      "scripts/**/*.mts",
      "tools/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "no-useless-assignment": "warn",
    },
  },
  {
    files: ["src/cli/graph/assets/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        requestAnimationFrame: "readonly",
        window: "readonly",
      },
    },
  },
);
