import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("RCP core remains outside NMG Core, daemon and integration boundaries", () => {
  const files = walk(join(root, "src", "rcp"));
  for (const file of files) {
    const local = relative(root, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from\s+["']\.\.\/\.\.\/(?:cli|core|integration|lab)\//, local);
    assert.doesNotMatch(source, /\bNmgService\b|connectDaemon\s*\(/, local);
  }
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
