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
      "no-console": "warn",
    },
  },
  {
    files: ["**/*.test.ts", "evals/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
