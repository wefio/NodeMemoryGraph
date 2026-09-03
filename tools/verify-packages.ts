/**
 * Verify every tracked subpackage builds reproducibly from a clean install.
 *
 * Rationale: build outputs (dist/, lib/, generated sources) are excluded from
 * version control, so the only integrity check left is "a clean clone can
 * regenerate every artifact". Each subpackage carries its own package.json and
 * lockfile (e.g. dsh/dsh-nmg uses pnpm); this tool installs with the frozen
 * lockfile (which also fails when package.json drifted from the lock) and runs
 * its build script.
 *
 * The package list is explicit, not a glob over node_modules, so adding a
 * subpackage is a one-line, reviewable change.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

interface Subpackage {
  /** Directory relative to the repository root, containing package.json. */
  dir: string;
  /** Package manager used by this subpackage (its lockfile kind). */
  manager: "pnpm" | "npm";
}

// Explicit list of subpackages with their own lockfile + build lifecycle.
const SUBPACKAGES: Subpackage[] = [{ dir: "dsh/dsh-nmg", manager: "pnpm" }];

function run(command: string, args: string[], cwd: string): void {
  if (process.platform === "win32") {
    // .cmd shims cannot be spawned directly; route through the shell like the
    // rest of the repository tooling (see tools/verify-package.ts).
    const shellArgs = ["/d", "/s", "/c", `${command} ${args.map(quote).join(" ")}`];
    execFileSync(process.env.ComSpec ?? "cmd.exe", shellArgs, {
      cwd,
      stdio: "inherit",
      encoding: "utf8",
    });
    return;
  }
  execFileSync(command, args, { cwd, stdio: "inherit", encoding: "utf8" });
}

function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

let failures = 0;
for (const sub of SUBPACKAGES) {
  const dir = resolve(root, sub.dir);
  const manifestPath = resolve(dir, "package.json");
  if (!existsSync(manifestPath)) {
    process.stderr.write(`verify:packages — missing ${sub.dir}/package.json\n`);
    failures += 1;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  process.stdout.write(`\nverify:packages — ${sub.dir} (${sub.manager})\n`);
  try {
    const installArgs =
      sub.manager === "pnpm"
        ? ["install", "--frozen-lockfile"]
        : ["ci"];
    run(sub.manager, installArgs, dir);
    if (manifest.scripts?.build) {
      run(sub.manager, ["run", "build"], dir);
    } else {
      process.stdout.write(`  (no build script; install-only check)\n`);
    }
    process.stdout.write(`  ok\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(
      `verify:packages — ${sub.dir} failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

if (failures > 0) {
  process.stderr.write(`\nverify:packages — ${failures} subpackage(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nverify:packages ok: ${SUBPACKAGES.length} subpackage(s) build from clean install\n`);
}
