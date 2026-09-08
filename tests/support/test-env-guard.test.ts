import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const testsRoot = join(root, "tests");
const guardFile = resolve(import.meta.filename);

/**
 * A test file that starts an NMG daemon — directly (`connectDaemon`), through the
 * MCP stdio transport, the packaged CLI, the tutorial script, or the pi
 * extension harness — inherits the developer environment. It must strip ambient
 * provider config so recall stays lexical and deterministic instead of calling a
 * live external embedding service. Single home: tests/helpers/test-env.ts.
 * Convention: docs/design/ci-cd-and-quality.md §2.
 */
const DAEMON_SPAWN_MARKERS = [
  "connectDaemon(",
  "StdioClientTransport",
  "bin/nmg.mjs",
  "tutorial-first-recall",
  "extensionHarness",
  "new NmgService(",
];

function testFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(path));
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

test("every daemon-spawning test strips ambient provider env", () => {
  const offenders: string[] = [];
  for (const file of testFiles(testsRoot)) {
    if (resolve(file) === guardFile) continue;
    const source = readFileSync(file, "utf8");
    if (!DAEMON_SPAWN_MARKERS.some((marker) => source.includes(marker))) continue;
    if (!/^\s*stripProviderEnv\(/mu.test(source)) {
      offenders.push(relative(root, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `call stripProviderEnv() from tests/helpers/test-env.ts at module scope in: ${offenders.join(", ")}`,
  );
});
