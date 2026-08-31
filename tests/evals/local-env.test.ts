import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { benchmarkCredentialEnvironment, loadEnvironmentFile } from "../../evals/local-env.ts";

test("benchmark credential loader reads only allowed keys and process values win", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-benchmark-env-"));
  try {
    writeFileSync(
      join(directory, ".env"),
      [
        "DEEPSEEK_API_KEY=file-secret",
        "OPENCODE_API_KEY='opencode-secret'",
        "UNRELATED_SECRET=must-not-pass",
      ].join("\n"),
    );
    assert.deepEqual(
      benchmarkCredentialEnvironment(directory, { DEEPSEEK_API_KEY: "process-secret" }),
      {
        DEEPSEEK_API_KEY: "process-secret",
        OPENCODE_API_KEY: "opencode-secret",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generic environment loader expands prior values without executing commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-generic-env-"));
  const file = join(directory, "benchmark.env");
  try {
    writeFileSync(file, "BASE=http://127.0.0.1:8000\nENDPOINT=${BASE}/v1\n", "utf8");
    const loaded = loadEnvironmentFile(file, {});
    assert.equal(loaded.ENDPOINT, "http://127.0.0.1:8000/v1");
    writeFileSync(file, "UNSAFE=$(whoami)\n", "utf8");
    assert.throws(() => loadEnvironmentFile(file, {}), /unsupported command substitution/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
