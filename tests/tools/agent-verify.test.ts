import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildVerificationPlan,
  discoverApplicableRcpContract,
  executeVerificationPlan,
  type VerificationCommandResult,
} from "../../tools/agent-verify.ts";
import { parseExecutedTestCount } from "../../src/rcp/providers.ts";
import type { AgentContextReport } from "../../tools/repo-context.ts";

function report(): AgentContextReport {
  return {
    project: "fixture",
    version: "1.0.0",
    root: "/fixture",
    scopes: ["src/store/rows.ts", "docs/guide.md"],
    git: { available: true, branch: "main", dirtyFiles: [] },
    engines: {},
    routes: [
      {
        id: "store",
        paths: ["src/store/**"],
        owners: [],
        tests: ["tests/store/**"],
        verify: {
          blocking: ["check", "test:product"],
          advisory: ["test:research"],
        },
      },
      {
        id: "docs",
        paths: ["docs/**"],
        owners: [],
        tests: [],
        verify: {
          blocking: ["docs:check", "check"],
          advisory: ["test:research"],
        },
      },
    ],
    availableRoutes: ["store", "docs"],
    guardrails: [],
    canonical: { design: "design.md", completion: "audit.md", todo: "todo.md" },
    state: { desiredRevision: "desired", observedRevision: "observed" },
    reconciliation: {
      status: "unknown",
      conditions: [],
      drifts: [],
    },
    warnings: [],
  };
}

test("verification plan deduplicates exact scripts and preserves route reasons", () => {
  const plan = buildVerificationPlan(report());
  assert.deepEqual(
    plan.blocking.map(({ command, routes }) => ({ command, routes })),
    [
      { command: "check", routes: ["store", "docs"] },
      { command: "test:product", routes: ["store"] },
      { command: "docs:check", routes: ["docs"] },
    ],
  );
  assert.deepEqual(
    plan.advisory.map(({ command, routes }) => ({ command, routes })),
    [{ command: "test:research", routes: ["store", "docs"] }],
  );
});

test("default execution runs every blocking check and leaves advisory work explicit", async () => {
  const seen: string[] = [];
  const results = await executeVerificationPlan(buildVerificationPlan(report()), {
    run: async (command): Promise<VerificationCommandResult> => {
      seen.push(command);
      return {
        command,
        classification: "blocking",
        routes: [],
        status: command === "test:product" ? "failed" : "passed",
        exitCode: command === "test:product" ? 1 : 0,
        durationMs: 1,
      };
    },
  });

  assert.deepEqual(seen, ["check", "test:product", "docs:check"]);
  assert.equal(results.ok, false);
  assert.equal(results.results.at(-1)?.command, "test:research");
  assert.equal(results.results.at(-1)?.status, "skipped");
  assert.equal(results.results.at(-1)?.reason, "advisory checks require --include-advisory");
});

test("advisory failures are reported without failing the blocking result", async () => {
  const results = await executeVerificationPlan(buildVerificationPlan(report()), {
    includeAdvisory: true,
    run: async (command, classification): Promise<VerificationCommandResult> => ({
      command,
      classification,
      routes: [],
      status: classification === "advisory" ? "failed" : "passed",
      exitCode: classification === "advisory" ? 1 : 0,
      durationMs: 1,
    }),
  });

  assert.equal(results.ok, true);
  assert.equal(
    results.results.find((result) => result.command === "test:research")?.status,
    "failed",
  );
});

test("runner exceptions are attributed per command and do not stop later checks", async () => {
  const seen: string[] = [];
  const results = await executeVerificationPlan(buildVerificationPlan(report()), {
    run: async (command): Promise<VerificationCommandResult> => {
      seen.push(command);
      if (command === "check") throw new Error("runner exploded");
      return {
        command,
        classification: "blocking",
        routes: [],
        status: "passed",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.deepEqual(seen, ["check", "test:product", "docs:check"]);
  assert.equal(results.ok, false);
  assert.deepEqual(
    results.results.find((result) => result.command === "check"),
    {
      command: "check",
      classification: "blocking",
      routes: ["store", "docs"],
      status: "failed",
      durationMs: 0,
      errorKind: "runner",
      reason: "runner exploded",
      output: "runner exploded",
    },
  );
});

test("CLI dry-run emits a machine-readable plan without running checks", () => {
  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--root",
      root,
      "--scope",
      "docs/README.md",
      "--dry-run",
      "--json",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    results: VerificationCommandResult[];
  };
  assert.equal(payload.ok, true);
  // docs/README.md is cleanly owned by the documentation route, so the default
  // is narrow: the always-run shared invariants plus that route's own tests.
  assert.deepEqual(
    payload.results.map(({ command, status, reason }) => ({ command, status, reason })),
    [
      { command: "check", status: "skipped", reason: "dry run" },
      { command: "docs:check", status: "skipped", reason: "dry run" },
      { command: "format:check", status: "skipped", reason: "dry run" },
      { command: "lint", status: "skipped", reason: "dry run" },
      { command: "package:check", status: "skipped", reason: "dry run" },
      { command: "node --test (documentation)", status: "skipped", reason: "dry run" },
    ],
  );
});

test("CLI executes npm scripts through a cross-platform child process", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "owner.md"), "# Owner\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { pass: 'node -e "process.exit(0)"' },
    }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    [
      "version: 1",
      "routes:",
      "  - id: fixture",
      "    paths: [src/**]",
      "    owners: [docs/owner.md]",
      "    tests: []",
      "    verify:",
      "      blocking: [pass]",
      "      advisory: []",
      "",
    ].join("\n"),
  );

  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--scope", "src/file.ts", "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as { results: VerificationCommandResult[] };
  assert.equal(payload.results[0]?.status, "passed");
  const evidencePath = join(root, ".nmg", "verification", "latest.json");
  assert.equal(existsSync(evidencePath), true);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    schemaVersion: number;
    runId: string;
    startedAt: string;
    finishedAt: string;
    runtime: { node: string; platform: string };
    result: { ok: boolean };
  };
  assert.equal(evidence.schemaVersion, 1);
  assert.ok(evidence.runId);
  assert.ok(evidence.startedAt);
  assert.ok(evidence.finishedAt);
  assert.ok(evidence.runtime.node);
  assert.ok(evidence.runtime.platform);
  assert.equal(evidence.result.ok, true);
});

test("CLI fails closed when --changed cannot inspect a Git worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-no-git-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "owner.md"), "# Owner\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { pass: 'node -e ""' } }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    "version: 1\nroutes:\n  - id: fixture\n    paths: [src/**]\n    owners: [docs/owner.md]\n    tests: []\n    verify:\n      blocking: [pass]\n      advisory: []\n",
  );

  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--changed", "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--changed requires an available Git worktree/);
  assert.match(result.stderr, /not a git repository|git inspection failed/i);
});

test("CLI accepts a positional scope without enabling changed-file discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-positional-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "docs", "owner.md"), "# Owner\n");
  writeFileSync(join(root, "src", "file.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { pass: 'node -e ""' } }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    "version: 1\nroutes:\n  - id: fixture\n    paths: [src/**]\n    owners: [docs/owner.md]\n    tests: []\n    verify:\n      blocking: [pass]\n      advisory: []\n",
  );

  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "src/file.ts", "--dry-run", "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    report: { scopes: string[]; routes: Array<{ id: string }> };
  };
  assert.deepEqual(payload.report.scopes, ["src/file.ts"]);
  assert.deepEqual(
    payload.report.routes.map((route) => route.id),
    ["fixture"],
  );
});

test("CLI automatically routes dirty Git files when called without scope arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-auto-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "docs", "owner.md"), "# Owner\n");
  writeFileSync(join(root, "src", "file.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { pass: 'node -e "process.exit(0)"' },
    }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    "version: 1\nroutes:\n  - id: fixture\n    paths: [src/**]\n    owners: [docs/owner.md]\n    tests: []\n    verify:\n      blocking: [pass]\n      advisory: []\n",
  );
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(git(["init", "--quiet"]).status, 0);

  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    report: { routes: Array<{ id: string }> };
    results: VerificationCommandResult[];
  };
  assert.deepEqual(
    payload.report.routes.map((route) => route.id),
    ["fixture"],
  );
  assert.equal(payload.results[0]?.status, "passed");

  const cleanResult = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--root",
      root,
      "--scope",
      "src/file.ts",
      "--require-clean",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(cleanResult.status, 0);
  assert.match(cleanResult.stderr, /--require-clean found \d+ dirty files/);
});

test("CLI automatically reconciles the unique RCP contract covering dirty scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-rcp-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".rcp", "contracts"), { recursive: true });
  writeFileSync(join(root, "docs", "owner.md"), "# Owner\n");
  writeFileSync(join(root, "src", "file.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { pass: 'node -e "process.exit(0)"' },
    }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    "version: 1\nroutes:\n  - id: fixture\n    paths: [src/**]\n    owners: [docs/owner.md]\n    tests: []\n    verify:\n      blocking: [pass]\n      advisory: []\n",
  );
  writeFileSync(
    join(root, ".rcp", "contracts", "fixture.yaml"),
    [
      "apiVersion: repository.nmg.dev/v1alpha1",
      "kind: AgentChange",
      "metadata:",
      "  id: fixture-change",
      "spec:",
      "  intent: Verify fixture changes",
      "  scope:",
      "    include: [src/**]",
      "    exclude: []",
      "  preserve: [owner remains authoritative]",
      "  invariants: [changes stay in scope]",
      "  verification:",
      "    routes: [fixture]",
      "    checks: [pass]",
      "    forgeChecks: []",
      "  authority:",
      "    mode: apply",
      "",
    ].join("\n"),
  );
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(git(["init", "--quiet"]).status, 0);
  assert.equal(git(["config", "user.email", "verify@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Verify Test"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "--quiet", "-m", "fixture"]).status, 0);
  writeFileSync(join(root, "src", "file.ts"), "export const value = 2;\n");

  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    rcp?: { status: string; contractId: string; receiptPath?: string };
  };
  assert.equal(payload.rcp?.status, "verified");
  assert.equal(payload.rcp?.contractId, "fixture-change");
  assert.ok(payload.rcp?.receiptPath);
  assert.equal(existsSync(payload.rcp!.receiptPath!), true);
  const receipt = JSON.parse(readFileSync(payload.rcp!.receiptPath!, "utf8")) as {
    gate: { mode: string; fullGateRun: boolean };
  };
  assert.equal(receipt.gate.mode, "full");
  assert.equal(receipt.gate.fullGateRun, true);

  const evidence = JSON.parse(
    readFileSync(join(root, ".nmg", "verification", "latest.json"), "utf8"),
  ) as { rcp?: { status: string; receiptPath?: string }; result?: { ok: boolean } };
  assert.equal(evidence.rcp?.status, "verified");
  assert.equal(evidence.result?.ok, true);
});

test("RCP auto-discovery refuses to choose between overlapping contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-rcp-ambiguous-"));
  const directory = join(root, ".rcp", "contracts");
  mkdirSync(directory, { recursive: true });
  const contract = (id: string) =>
    [
      "apiVersion: repository.nmg.dev/v1alpha1",
      "kind: AgentChange",
      "metadata:",
      `  id: ${id}`,
      "spec:",
      "  intent: Verify fixture changes",
      "  scope:",
      "    include: [src/**]",
      "    exclude: []",
      "  preserve: [owner remains authoritative]",
      "  invariants: [changes stay in scope]",
      "  verification:",
      "    routes: [fixture]",
      "    checks: [pass]",
      "    forgeChecks: []",
      "  authority:",
      "    mode: apply",
      "",
    ].join("\n");
  writeFileSync(join(directory, "first.yaml"), contract("first"));
  writeFileSync(join(directory, "second.yaml"), contract("second"));

  assert.throws(
    () => discoverApplicableRcpContract(root, ["src/file.ts"]),
    /multiple RCP contracts cover the selected scope: first, second/,
  );
});

test("CLI attributes command timeout and persists the failure", () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-timeout-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "owner.md"), "# Owner\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { slow: 'node -e "setTimeout(() => {}, 10000)"' },
    }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    "version: 1\nroutes:\n  - id: fixture\n    paths: [src/**]\n    owners: [docs/owner.md]\n    tests: []\n    verify:\n      blocking: [slow]\n      advisory: []\n",
  );

  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--root",
      root,
      "--scope",
      "src/file.ts",
      "--timeout-ms",
      "50",
      "--json",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as { results: VerificationCommandResult[] };
  assert.equal(payload.results[0]?.status, "failed");
  assert.equal(payload.results[0]?.errorKind, "timeout");
});

function narrowFixture(options: { failRouteTest?: boolean; routeTests?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-agent-verify-narrow-"));
  mkdirSync(join(root, "plugin"), { recursive: true });
  mkdirSync(join(root, "tests", "plugin"), { recursive: true });
  writeFileSync(join(root, "plugin", "index.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "tests", "plugin", "plugin.test.ts"),
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest("plugin ok", () => {\n  assert.equal(1, ${options.failRouteTest ? "2" : "1"});\n});\n`,
  );
  const ok = 'node -e "process.exit(0)"';
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: {
        check: ok,
        "docs:check": ok,
        "format:check": ok,
        lint: ok,
        "package:check": ok,
        "test:product": 'node -e "process.exit(1)"',
      },
    }),
  );
  writeFileSync(
    join(root, "agent-context.yaml"),
    `version: 1\nroutes:\n  - id: plugin\n    paths: [plugin/**]\n    owners: []\n    tests: [${options.routeTests ?? "tests/plugin/**"}]\n    verify:\n      blocking: [check, test:product]\n      advisory: []\n`,
  );
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(git(["init", "--quiet"]).status, 0);
  assert.equal(git(["config", "user.email", "verify@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Verify Test"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "--quiet", "-m", "fixture"]).status, 0);
  writeFileSync(join(root, "plugin", "index.ts"), "export const value = 2;\n");
  return root;
}

function runVerify(root: string, extra: string[] = []) {
  const script = fileURLToPath(new URL("../../tools/agent-verify.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, ...extra, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
}

test("narrow is the default and records an honest gate without test:product", () => {
  const result = runVerify(narrowFixture());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    rcp?: { status: string; receiptPath?: string };
    ok: boolean;
  };
  assert.equal(payload.rcp?.status, "verified");
  assert.equal(payload.ok, true);
  const receipt = JSON.parse(readFileSync(payload.rcp!.receiptPath!, "utf8")) as {
    gate: { mode: string; fullGateRun: boolean };
    checks: Array<{ name: string }>;
  };
  assert.equal(receipt.gate.mode, "narrow");
  assert.equal(receipt.gate.fullGateRun, false);
  const names = receipt.checks.map((check) => check.name);
  for (const shared of ["check", "docs:check", "format:check", "lint", "package:check"])
    assert.ok(names.includes(shared), `missing shared check ${shared}`);
  assert.ok(names.includes("node-test:plugin"));
  assert.ok(!names.includes("test:product"), "narrow must not run the whole suite");
});

test("--full forces the declared blocking set instead of narrowing", () => {
  const result = runVerify(narrowFixture(), ["--full"]);
  const payload = JSON.parse(result.stdout) as {
    results: VerificationCommandResult[];
    rcp?: unknown;
  };
  assert.ok(payload.results.some((entry) => entry.command === "test:product"));
  assert.equal(payload.rcp, undefined);
});

test("a failing route test fails the narrow gate instead of passing vacuously", () => {
  const result = runVerify(narrowFixture({ failRouteTest: true }));
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    rcp?: { status: string; receiptPath?: string };
    ok: boolean;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.rcp?.status, "failed");
  const receipt = JSON.parse(readFileSync(payload.rcp!.receiptPath!, "utf8")) as {
    checks: Array<{ name: string; status: string }>;
  };
  assert.equal(
    receipt.checks.find((check) => check.name === "node-test:plugin")?.status,
    "failed",
  );
});

test("route test patterns that match no files fail closed", () => {
  const result = runVerify(narrowFixture({ routeTests: "tests/nope/**" }));
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    rcp?: { status: string; receiptPath?: string };
  };
  assert.equal(payload.rcp?.status, "failed");
  const receipt = JSON.parse(readFileSync(payload.rcp!.receiptPath!, "utf8")) as {
    checks: Array<{ name: string; status: string; reason?: string }>;
  };
  const check = receipt.checks.find((entry) => entry.name === "node-test:plugin");
  assert.equal(check?.status, "failed");
  assert.match(check?.reason ?? "", /match no files/);
});

test("a route test run that executes no tests fails closed", () => {
  // node exits 0 and prints no summary when it skips the files (e.g. a nested
  // node:test context); the executed count must come from the summary, so an
  // absent summary is zero and must not be recorded as a pass.
  assert.equal(parseExecutedTestCount("# tests 12\n# pass 12\n"), 12);
  assert.equal(parseExecutedTestCount("ℹ tests 7\nℹ pass 7\n"), 7);
  assert.equal(
    parseExecutedTestCount(
      "Warning: node:test run() is being called recursively within a test file. skipping running files.\n",
    ),
    0,
  );
});
