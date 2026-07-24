import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsearchAnnIndex } from "../../src/core/ann.ts";

test("USearch ANN persists stable memory ID mappings", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-ann-"));
  try {
    const ann = new UsearchAnnIndex(join(directory, "test.usearch"));
    const built = ann.build("qwen-test", [
      { memoryId: "memory-a", vector: [1, 0, 0] },
      { memoryId: "memory-b", vector: [0, 1, 0] },
      { memoryId: "memory-c", vector: [0, 0, 1] },
    ]);
    assert.equal(built.count, 3);
    assert.equal(ann.search([0, 0.99, 0.01], 2)[0], "memory-b");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
