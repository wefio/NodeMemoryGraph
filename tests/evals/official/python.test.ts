import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  officialPythonExecutable,
  probePython,
} from "../../../evals/official/python.ts";

test("official Python uses one explicit override without a fallback chain", () => {
  assert.equal(
    officialPythonExecutable("C:/repo", { NMG_BENCHMARK_PYTHON: "C:/Python/python.exe" }, "win32"),
    resolve("C:/Python/python.exe"),
  );
  assert.match(officialPythonExecutable("C:/repo", {}, "win32"), /Scripts[\\/]python\.exe$/u);
  assert.match(officialPythonExecutable("/repo", {}, "linux"), /bin[\\/]python$/u);
});

test("official Python probe distinguishes an executable runtime from an unavailable one", () => {
  assert.equal(probePython(process.execPath).available, true);
  const missing = probePython(resolve("definitely-missing-python"));
  assert.equal(missing.available, false);
  assert.ok(missing.error);
});
