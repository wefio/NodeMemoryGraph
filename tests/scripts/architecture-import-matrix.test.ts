import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("architecture matrix counts direct declarations, dynamic and import-type references", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-import-matrix-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "--quiet");
    for (const dir of ["core", "integration", "cli", "lab"])
      mkdirSync(join(root, "src", dir), { recursive: true });
    writeFileSync(
      join(root, "src/core/main.ts"),
      'import type { X } from "../integration/types.ts";\nimport "../integration";\ntype Y = import("../cli/protocol.ts").Y;\nvoid import("../lab/x.ts");\n',
    );
    writeFileSync(join(root, "src/integration/types.ts"), "export type X = string;\n");
    writeFileSync(join(root, "src/cli/protocol.ts"), 'export { value } from "../core/value.ts";\n');
    writeFileSync(join(root, "src/core/value.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "src/lab/x.ts"), "export const x = 1;\n");
    git("add", "src");
    git(
      "-c",
      "user.name=Matrix Test",
      "-c",
      "user.email=matrix@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    const script = fileURLToPath(
      new URL("../../docs/experiments/architecture-import-matrix-2026-11-14.mjs", import.meta.url),
    );
    const run = () =>
      spawnSync(process.execPath, ["--experimental-strip-types", script, "--root", root], {
        encoding: "utf8",
      });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout) as {
      sourceFiles: number;
      crossGroupReferences: number;
      counts: Record<string, number>;
    };
    assert.equal(result.sourceFiles, 5);
    assert.equal(result.crossGroupReferences, 5);
    assert.deepEqual(result.counts, {
      "cli -> core": 1,
      "core -> cli": 1,
      "core -> integration": 2,
      "core -> lab": 1,
    });
    writeFileSync(join(root, "src/core/value.ts"), "export const value = 2;\n");
    const dirty = run();
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /src must match the measured revision/);
  } finally {
    removeTempDirectory(root);
  }
});
