import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
        "eval:retrieval": "node evals/retrieval/run.ts",
      },
    }),
    "agent-context.yaml": [
      "version: 1",
      "capabilities:",
      "  - id: retrieval-evaluation",
      "    aliases: [evidence-recall]",
      "    summary: Evaluate rank-aware memory evidence retrieval.",
      "    paths: [evals/retrieval]",
      "    entrypoints: [npm run eval:retrieval]",
      "    supports: [locomo, longmemeval, beam, personamem, halumem]",
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
      "  - id: evaluation",
      "    paths: [evals/**]",
      "    owners: [docs/design/store.md]",
      "    tests: []",
      "    verify:",
      "      blocking: [check]",
      "      advisory: []",
      "",
    ].join("\n"),
    "docs/design/store.md": "# Store\n",
    "src/store/rows.ts": "export const row = 1;\n",
    "evals/retrieval/run.ts": "export const run = true;\n",
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

test("route schema rejects duplicate ids and commands with conflicting classifications", () => {
  const root = fixture();
  writeFileSync(
    join(root, "agent-context.yaml"),
    [
      "version: 1",
      "routes:",
      "  - id: duplicate",
      "    paths: [src/**]",
      "    owners: []",
      "    tests: []",
      "    verify:",
      "      blocking: [check]",
      "      advisory: [check]",
      "  - id: duplicate",
      "    paths: [docs/**]",
      "    owners: []",
      "    tests: []",
      "    verify:",
      "      blocking: [docs:check]",
      "      advisory: []",
      "",
    ].join("\n"),
  );
  assert.throws(() => validateAgentContext(root), /duplicate route id: duplicate/);

  const text = readFileSync(join(root, "agent-context.yaml"), "utf8").replace(
    "  - id: duplicate\n    paths: [docs/**]",
    "  - id: documentation\n    paths: [docs/**]",
  );
  writeFileSync(join(root, "agent-context.yaml"), text);
  assert.throws(
    () => validateAgentContext(root),
    /duplicate: npm script check cannot be both blocking and advisory/,
  );
});

test("markdown output remains a concise navigation surface", () => {
  const report = collectAgentContext(fixture(), ["src/store/rows.ts"]);
  const text = formatAgentContext(report);
  assert.match(text, /## Route: store/);
  assert.match(text, /Blocking: npm run check, npm run test:product/);
  assert.match(text, /Advisory: npm run test:research/);
  assert.match(text, /## Active guardrails/);
  assert.match(text, /## Reconciliation/);
  assert.match(text, /Status: unknown/);
  assert.doesNotMatch(text, /Route: missing/);
});

test("lists declared repository capabilities without pretending they are routes", () => {
  const text = formatAgentContext(collectAgentContext(fixture()));
  assert.match(text, /## Available capabilities/);
  assert.match(text, /capability:retrieval-evaluation/);
  assert.match(text, /npm run eval:retrieval/);
  assert.match(text, /personamem, halumem/);
});

test("selects a capability by stable id or alias and routes through its owned paths", () => {
  const root = fixture();
  const byId = collectAgentContext(root, [], { capabilities: ["retrieval-evaluation"] });
  assert.deepEqual(
    byId.capabilities.map((capability) => capability.id),
    ["retrieval-evaluation"],
  );
  assert.deepEqual(byId.scopes, ["evals/retrieval"]);

  const byAlias = collectAgentContext(root, [], { capabilities: ["evidence-recall"] });
  assert.deepEqual(
    byAlias.capabilities.map((capability) => capability.id),
    ["retrieval-evaluation"],
  );
});

test("CLI accepts capability:id as a positional discovery target", () => {
  const root = fixture();
  const script = fileURLToPath(new URL("../../tools/repo-context.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--root",
      root,
      "capability:retrieval-evaluation",
      "--json",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    capabilities: Array<{ id: string }>;
    routes: Array<{ id: string }>;
  };
  assert.deepEqual(
    report.capabilities.map((capability) => capability.id),
    ["retrieval-evaluation"],
  );
  assert.deepEqual(
    report.routes.map((route) => route.id),
    ["evaluation"],
  );
});

test("capability declarations reject duplicate aliases", () => {
  const root = fixture();
  const path = join(root, "agent-context.yaml");
  const text = readFileSync(path, "utf8").replace(
    "routes:",
    [
      "  - id: another-capability",
      "    aliases: [evidence-recall]",
      "    summary: Conflicts with the first capability.",
      "    paths: [src/store]",
      "    entrypoints: [npm run missing-capability-script]",
      "    supports: []",
      "routes:",
    ].join("\n"),
  );
  writeFileSync(path, text);
  assert.throws(() => validateAgentContext(root), /duplicate capability name: evidence-recall/);
});

test("capability validation reports a missing npm entrypoint", () => {
  const root = fixture();
  const path = join(root, "agent-context.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "entrypoints: [npm run eval:retrieval]",
      "entrypoints: [npm run missing-capability-script]",
    ),
  );
  assert.ok(
    validateAgentContext(root).includes(
      "retrieval-evaluation: missing npm script missing-capability-script",
    ),
  );
});

function writeVerificationEvidence(
  root: string,
  report: ReturnType<typeof collectAgentContext>,
  status: "passed" | "failed" = "passed",
): void {
  const directory = join(root, ".nmg", "verification");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "latest.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "verification-fixture",
      finishedAt: "2026-08-27T00:00:00.000Z",
      report,
      result: {
        ok: status === "passed",
        results: ["check", "test:product"].map((command) => ({
          command,
          classification: "blocking",
          status,
        })),
      },
    }),
  );
}

test("reconciliation stays unknown until matching verification evidence exists", () => {
  const report = collectAgentContext(fixture(), ["src/store/rows.ts"]);
  assert.equal(report.reconciliation.status, "unknown");
  assert.equal(
    report.reconciliation.conditions.find((condition) => condition.type === "verification")?.status,
    "unknown",
  );
});

test("reconciliation converges only for the same desired and observed revisions", () => {
  const root = fixture();
  const before = collectAgentContext(root, ["src/store/rows.ts"]);
  writeVerificationEvidence(root, before);

  const verified = collectAgentContext(root, ["src/store/rows.ts"]);
  assert.equal(verified.reconciliation.status, "converged");
  assert.equal(verified.reconciliation.latestVerification?.runId, "verification-fixture");

  writeFileSync(join(root, "src", "store", "rows.ts"), "export const row = 2;\n");
  const changed = collectAgentContext(root, ["src/store/rows.ts"]);
  assert.equal(changed.reconciliation.status, "drifted");
  assert.ok(changed.reconciliation.drifts.some((drift) => drift.kind === "observed-state"));
});

test("matching failed blocking evidence is reported as verification drift", () => {
  const root = fixture();
  const before = collectAgentContext(root, ["src/store/rows.ts"]);
  writeVerificationEvidence(root, before, "failed");

  const report = collectAgentContext(root, ["src/store/rows.ts"]);
  assert.equal(report.reconciliation.status, "drifted");
  assert.ok(report.reconciliation.drifts.some((drift) => drift.kind === "verification"));
});

test("a commit-only HEAD change does not invalidate verified scoped content", () => {
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
  runGit(["add", "."]);
  runGit(["commit", "--quiet", "-m", "fixture"]);

  const before = collectAgentContext(root, ["src/store/rows.ts"]);
  writeVerificationEvidence(root, before);
  runGit(["commit", "--quiet", "--allow-empty", "-m", "metadata only"]);

  const after = collectAgentContext(root, ["src/store/rows.ts"]);
  assert.notEqual(after.git.head, before.git.head);
  assert.equal(after.reconciliation.status, "converged");
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
    ["store", "docs", "evaluation"],
  );
});

test("CLI accepts positional scopes so npm cannot consume the path option", () => {
  const root = fixture();
  const script = fileURLToPath(new URL("../../tools/repo-context.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "src/store/rows.ts", "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    scopes: string[];
    routes: Array<{ id: string }>;
  };
  assert.deepEqual(report.scopes, ["src/store/rows.ts"]);
  assert.deepEqual(
    report.routes.map((route) => route.id),
    ["store"],
  );
});

test("manual scope survives unavailable Git and reports the inspection failure", () => {
  const root = fixture();
  const script = fileURLToPath(new URL("../../tools/repo-context.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "src/store/rows.ts", "--json"],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    git: { available: boolean; error?: string };
    routes: Array<{ id: string }>;
    warnings: string[];
  };
  assert.equal(report.git.available, false);
  assert.match(report.git.error ?? "", /ENOENT|not found/i);
  assert.deepEqual(
    report.routes.map((route) => route.id),
    ["store"],
  );
});
