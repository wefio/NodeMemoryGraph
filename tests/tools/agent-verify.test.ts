import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildVerificationPlan,
  executeVerificationPlan,
  type VerificationCommandResult,
} from "../../tools/agent-verify.ts";
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
  assert.deepEqual(
    payload.results.map(({ command, status, reason }) => ({ command, status, reason })),
    [{ command: "docs:check", status: "skipped", reason: "dry run" }],
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
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { pass: "node -e \"\"" } }),
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
  assert.deepEqual(payload.report.routes.map((route) => route.id), ["fixture"]);
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
