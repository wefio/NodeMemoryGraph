import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      scripts: { check: "tsc --noEmit", test: "node --test" },
    }),
    "agent-context.yaml": [
      "version: 1",
      "routes:",
      "  - id: store",
      "    paths: [src/store/**]",
      "    owners: [docs/design/store.md]",
      "    tests: [tests/store/**]",
      "    verify: [check, test]",
      "  - id: missing",
      "    paths: [src/missing/**]",
      "    owners: [docs/design/missing.md]",
      "    tests: []",
      "    verify: [missing-script]",
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
  assert.match(text, /npm run check, npm run test/);
  assert.match(text, /## Active guardrails/);
  assert.doesNotMatch(text, /Route: missing/);
});
