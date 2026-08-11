import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { benchmarkCredentialEnvironment } from "../../evals/local-env.ts";

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
