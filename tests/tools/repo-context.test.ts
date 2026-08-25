import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  collectAgentContext,
  formatAgentContext,
  validateAgentContext,
} from "../../tools/repo-context.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-repo-context-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "fixture",
      version: "1.2.3",
      engines: { node: ">=22" },
      scripts: {
        check: "tsc --noEmit",
        "test:product": "node --test tests/product",
        "test:research": "node --test tests/research",
        "docs:check": "node docs-check.mjs",
      },
    }),
    "agent-context.yaml": [
      "version: 1",
      "routes:",
      "  - id: store",
      "    paths: [src/store/**]",
      "    owners: [docs/design/store.md]",
      "    tests: [tests/store/**]",
      "    verify:",
      "      blocking: [check, test:product]",
      "      advisory: [test:research]",
      "  - id: docs",
      "    paths: [docs/**]",
      "    owners: [docs/design/store.md]",
      "    tests: []",
      "    verify:",
      "      blocking: [docs:check]",
      "      advisory: []",
      "  - id: missing",
      "    paths: [src/missing/**]",
      "    owners: [docs/design/missing.md]",
      "    tests: []",
      "    verify:",
      "      blocking: [missing-script]",
      "      advisory: []",
      "",
    ].join("\n"),
    "docs/design/store.md": "# Store\n",
    "tests/guardrails/merge/guardrail.yaml": [
      "id: merge-v1",
      "status: active",
      "reason: Protect the merge contract during migration.",
      "review_after: 2026-10-01",
      "exit_criteria: Promote the stable behavior to a contract test.",
      "",
    ].join("\n"),
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("selects owners, tests, commands, and active guardrails for a scoped path", () => {
  const report = collectAgentContext(fixture(), ["src/store/rows.ts"]);
  assert.equal(report.project, "fixture");
  assert.equal(report.version, "1.2.3");
  assert.deepEqual(
    report.routes.map((route) => route.id),
    ["store"],
  );
  assert.deepEqual(report.routes[0].owners, ["docs/design/store.md"]);
  assert.deepEqual(report.routes[0].verify, {
    blocking: ["check", "test:product"],
    advisory: ["test:research"],
  });
  assert.deepEqual(report.guardrails, [
    {
      id: "merge-v1",
      status: "active",
      reviewAfter: "2026-10-01",
      reason: "Protect the merge contract during migration.",
      exitCriteria: "Promote the stable behavior to a contract test.",
      path: "tests/guardrails/merge/guardrail.yaml",
    },
  ]);
  assert.deepEqual(report.warnings, []);
});

test("reports unmatched scopes without loading every route", () => {
  const report = collectAgentContext(fixture(), ["unknown/file.ts"]);
  assert.deepEqual(report.routes, []);
  assert.ok(report.warnings.some((warning) => warning.includes("no route matched")));
});

test("accepts an absolute path inside the repository as a scope", () => {
  const root = fixture();
  const report = collectAgentContext(root, [join(root, "src", "store", "rows.ts")]);
  assert.deepEqual(report.scopes, ["src/store/rows.ts"]);
  assert.deepEqual(
    report.routes.map((route) => route.id),
    ["store"],
  );
});

test("validates only selected route owners and npm scripts", () => {
  const report = collectAgentContext(fixture(), ["src/missing/file.ts"]);
  assert.ok(report.warnings.includes("missing: missing owner docs/design/missing.md"));
  assert.ok(report.warnings.includes("missing: missing npm script missing-script"));
});

test("validates every declared route for CI without selecting a scope", () => {
  const warnings = validateAgentContext(fixture());
  assert.deepEqual(warnings, [
    "missing: missing owner docs/design/missing.md",
    "missing: missing npm script missing-script",
  ]);
});

test("active guardrails require a reason, review date, and exit criteria", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests", "guardrails", "merge", "guardrail.yaml"),
    "id: merge-v1\nstatus: active\n",
  );
  const warnings = validateAgentContext(root);
  assert.ok(warnings.includes("guardrail merge-v1: missing reason"));
  assert.ok(warnings.includes("guardrail merge-v1: missing review_after"));
  assert.ok(warnings.includes("guardrail merge-v1: missing exit_criteria"));
});

test("markdown output remains a concise navigation surface", () => {
  const report = collectAgentContext(fixture(), ["src/store/rows.ts"]);
  const text = formatAgentContext(report);
  assert.match(text, /## Route: store/);
  assert.match(text, /Blocking: npm run check, npm run test:product/);
  assert.match(text, /Advisory: npm run test:research/);
  assert.match(text, /## Active guardrails/);
  assert.doesNotMatch(text, /Route: missing/);
});

test("--changed routes every dirty path through the same context report", () => {
  const root = fixture();
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit(["init", "--quiet"]);
  runGit(["config", "user.email", "agent@example.invalid"]);
  runGit(["config", "user.name", "Agent Test"]);
  mkdirSync(join(root, "src", "store"), { recursive: true });
  writeFileSync(join(root, "src", "store", "rows.ts"), "export const row = 1;\n", {
    flag: "w",
  });
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n", { flag: "w" });

  const script = fileURLToPath(new URL("../../tools/repo-context.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--changed", "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { routes: Array<{ id: string }> };
  assert.deepEqual(
    report.routes.map((route) => route.id),
    ["store", "docs"],
  );
});
