import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { verifyCandidate } from "../../src/integration/ooo-candidate.ts";

const repository = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const check = (label: string, code: string) => ({
  label,
  command: process.execPath,
  args: ["-e", code],
});

test("contract: candidate files run against fixed checks inside an isolated worktree", async () => {
  const file = "src/integration/ooo-execution.ts";
  const frozen = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const result = await verifyCandidate({
    repository,
    revision,
    files: { [file]: frozen, "probe.txt": "candidate" },
    checks: [
      check(
        "sees candidate file",
        "require('node:fs').readFileSync('probe.txt','utf8')==='candidate'||process.exit(3)",
      ),
      check("needs no provider env", "process.env.NMG_JUDGE_API_KEY===undefined||process.exit(4)"),
    ],
  });
  assert.equal(result.verdict, "accept");
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["passed", "passed"],
  );
});

test("safety: a failing fixed check rejects, and a missing tool is undecidable rather than accepted", async () => {
  const file = "src/integration/ooo-execution.ts";
  const frozen = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const failed = await verifyCandidate({
    repository,
    revision,
    files: { [file]: frozen },
    checks: [check("fails", "process.exit(9)")],
  });
  assert.equal(failed.verdict, "reject");
  assert.equal(failed.outcomes[0]!.status, "failed");
  assert.equal(failed.outcomes[0]!.exitCode, 9);

  const missing = await verifyCandidate({
    repository,
    revision,
    files: { [file]: frozen },
    checks: [{ label: "absent tool", command: "definitely-not-a-tool-xyz", args: [] }],
  });
  assert.equal(missing.verdict, "undecidable");
});

test("safety: escaping paths and an unusable revision never reach a check", async () => {
  const file = "src/integration/ooo-execution.ts";
  const frozen = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const checks = [check("noop", "process.exit(0)")];
  for (const path of ["../escape.ts", "/abs.ts", "C:/abs.ts", "a\\b.ts", ""])
    await assert.rejects(
      verifyCandidate({ repository, revision, files: { [path]: "x" }, checks }),
      /relative/,
    );
  const unknown = await verifyCandidate({
    repository,
    revision: "0".repeat(40),
    files: { [file]: frozen },
    checks,
  });
  assert.equal(unknown.verdict, "undecidable");
});
