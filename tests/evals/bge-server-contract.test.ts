import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const gpuPython = resolve(repoRoot, ".benchmarks", "bge-venv", "Scripts", "python.exe");
const python = existsSync(gpuPython)
  ? gpuPython
  : process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

test("BGE has one Python service entrypoint with explicit device policy", () => {
  const canonical = resolve(repoRoot, "evals", "omnimemeval", "bge_server.py");
  const obsolete = resolve(repoRoot, "evals", "omnimemeval", "bge-server.py");

  assert.equal(existsSync(canonical), true);
  assert.equal(existsSync(obsolete), false);

  const result = spawnSync(
    python,
    [
      "-c",
      [
        "from evals.omnimemeval.bge_server import select_device",
        "assert select_device(None, True) == 'cuda'",
        "assert select_device(None, False) == 'cpu'",
        "assert select_device('cpu', True) == 'cpu'",
        "assert select_device('cuda', True) == 'cuda'",
        "try:",
        "    select_device('cuda', False)",
        "except RuntimeError:",
        "    pass",
        "else:",
        "    raise AssertionError('explicit cuda must not silently fall back')",
      ].join("\n"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("retrieval benchmark no longer routes through a shell launcher", () => {
  assert.equal(existsSync(resolve(repoRoot, "evals", "retrieval", "bench.sh")), false);
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts["eval:retrieval"], /evals\/retrieval\/run\.ts/u);
  assert.doesNotMatch(packageJson.scripts["eval:retrieval"], /\.sh\b/u);
});
