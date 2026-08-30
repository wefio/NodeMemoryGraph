import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-rcp-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "rcp-fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        check: 'node -e "process.exit(0)"',
        failing: 'node -e "process.exit(3)"',
      },
    }),
    "agent-context.yaml": [
      "version: 1",
      "routes:",
      "  - id: source",
      "    paths: [src/**]",
      "    owners: [docs/design.md]",
      "    tests: [tests/**]",
      "    verify:",
      "      blocking: [check]",
      "      advisory: []",
      "",
    ].join("\n"),
    "docs/design.md": "# Design\n",
    "src/value.ts": "export const value = 1;\n",
    "outside.txt": "outside\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "rcp@example.invalid"]);
  git(root, ["config", "user.name", "RCP Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

export function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git exited ${result.status}`);
  return result.stdout.trim();
}

export function contractText(overrides = ""): string {
  return [
    "apiVersion: repository.nmg.dev/v1alpha1",
    "kind: AgentChange",
    "metadata:",
    "  id: fixture-change",
    "spec:",
    "  intent: Update the fixture source",
    "  scope:",
    "    include: [src/**]",
    "    exclude: [src/generated/**]",
    "  preserve: [public API]",
    "  invariants: [do not modify outside scope]",
    "  verification:",
    "    routes: [source]",
    "    checks: [check]",
    "    forgeChecks: [product]",
    "  authority:",
    "    mode: apply",
    overrides,
    "",
  ].join("\n");
}
