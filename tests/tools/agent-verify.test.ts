import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
