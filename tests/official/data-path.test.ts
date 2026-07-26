import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBenchmarkData } from "../../evals/official/data-path.ts";

test("benchmark data resolver prefers an explicit valid override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-data-path-"));
  const override = join(directory, "override.json");
  const fallback = join(directory, "fallback.json");
  writeFileSync(override, "{}");
  writeFileSync(fallback, "{}");
  try {
    assert.equal(resolveBenchmarkData("test", override, [fallback]), override);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("benchmark data resolver falls through to an official checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-data-path-"));
  const missing = join(directory, "missing.json");
  const official = join(directory, "official.json");
  writeFileSync(official, "{}");
  try {
    assert.equal(resolveBenchmarkData("test", undefined, [missing, official]), official);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("benchmark data resolver reports every checked location", () => {
  assert.throws(
    () => resolveBenchmarkData("LoCoMo", undefined, ["missing-a", "missing-b"]),
    /missing-a[\s\S]*missing-b[\s\S]*benchmark:setup/u,
  );
});
