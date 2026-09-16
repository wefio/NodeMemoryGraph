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
    // Staged adoption: evals/ and scripts/ joined the lint surface in
    // docs/decisions/implemented/2026-09-16-ci-static-coverage.md and still carry
    // pre-existing findings there. Each firing rule is named on its own line and
    // reported at `warn`, so the gate can land without folding an unrelated
    // rewrite into it. Retire a line by fixing its findings, not by widening it:
    // switching a rule off for a directory removes the detection as well as the
    // finding.
    files: ["evals/**/*.ts", "evals/**/*.mjs", "scripts/**/*.ts", "scripts/**/*.mts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
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
