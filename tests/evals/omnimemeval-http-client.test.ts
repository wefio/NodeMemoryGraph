import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { officialPythonExecutable, probePython } from "../../evals/official/python.ts";

const root = resolve(import.meta.dirname, "../..");
const python = officialPythonExecutable(root);

test("OmniMemEval HTTP transport contract and safety", { timeout: 30_000 }, (t) => {
  const availability = probePython(python);
  if (!availability.available) {
    t.skip(`benchmark Python unavailable: ${availability.error}`);
    return;
  }
  const result = spawnSync(python, ["tests/evals/omnimemeval-http-client-contract.py"], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran [1-9]\d* tests/);
});
