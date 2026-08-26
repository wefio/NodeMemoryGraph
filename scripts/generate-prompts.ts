import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { format, resolveConfig } from "prettier";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "src/prompts/nmg-prompts.yaml");
const outputPath = resolve(root, "src/prompts/nmg-prompts.generated.ts");
const prompts = parse(readFileSync(sourcePath, "utf8")) as Record<string, string>;
const prettierConfig = (await resolveConfig(outputPath)) ?? {};
const generated = await format(
  `// Generated from nmg-prompts.yaml by scripts/generate-prompts.ts. Do not edit.\nexport const GENERATED_NMG_PROMPTS = ${JSON.stringify(prompts, null, 2)} as const;\n`,
  { ...prettierConfig, parser: "typescript" },
);

if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== generated) {
    console.error("src/prompts/nmg-prompts.generated.ts is stale; run npm run prompts:generate");
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, generated, "utf8");
}
