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
 *
 * This is the one gate whose own setup can be the thing that is missing. It is
 * meant to run in a fresh worktree, where the dependency store may not exist
 * yet, and a missing build tool then surfaces as
 * `Cannot find module .../tsdown/dist/run.mjs` — which reads like broken code and
 * sends the reader to the wrong file. So the environment is checked, named, and
 * reported as an environment failure; the build verdict is reserved for a build
 * that had a working toolchain to fail with.
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

/** A build that cannot resolve its own tooling is an environment failure, not a code
 *  failure. Nothing else in this tool classifies a failure, so this one pattern is
 *  what keeps the two apart in the message a reader actually sees. */
const MODULE_RESOLUTION_FAILURE = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/u;

function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function invocation(command: string, args: string[]): { file: string; argv: string[] } {
  if (process.platform === "win32") {
    // .cmd shims cannot be spawned directly; route through the shell like the
    // rest of the repository tooling (see tools/verify-package.ts).
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      argv: ["/d", "/s", "/c", `${command} ${args.map(quote).join(" ")}`],
    };
  }
  return { file: command, argv: args };
}

/** Installs stream: they are long, and a reader wants to see progress. */
function run(command: string, args: string[], cwd: string): void {
  const { file, argv } = invocation(command, args);
  execFileSync(file, argv, { cwd, stdio: "inherit", encoding: "utf8" });
}

/** The build is captured, not streamed: its failure has to be classified before it is
 *  reported, and on success it has nothing to say that the verdict does not. */
function capture(command: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const { file, argv } = invocation(command, args);
  try {
    const output = execFileSync(file, argv, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`,
    };
  }
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
  const installed = existsSync(resolve(dir, "node_modules"));
  process.stdout.write(`\nverify:packages — ${sub.dir} (${sub.manager})\n`);
  if (!installed) {
    process.stdout.write(
      `  no node_modules in this worktree: installing first (an environment step, not the check)\n`,
    );
  }
  try {
    const installArgs = sub.manager === "pnpm" ? ["install", "--frozen-lockfile"] : ["ci"];
    run(sub.manager, installArgs, dir);
  } catch (error) {
    failures += 1;
    process.stderr.write(
      `verify:packages — ${sub.dir} failed to install: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    continue;
  }
  if (!manifest.scripts?.build) {
    process.stdout.write(`  (no build script; install-only check)\n  ok\n`);
    continue;
  }
  const build = capture(sub.manager, ["run", "build"], dir);
  if (!build.ok) {
    failures += 1;
    process.stderr.write(build.output);
    process.stderr.write(
      MODULE_RESOLUTION_FAILURE.test(build.output)
        ? `verify:packages — ${sub.dir}: the install reported success but the build cannot resolve its own tooling.\n` +
            `  This is an environment failure, not a build failure: this worktree's dependency store is incomplete,\n` +
            `  which a frozen-lockfile install can report as "Already up to date" while it only half-filled the store.\n` +
            `  Remove ${sub.dir}/node_modules and install again.\n`
        : `verify:packages — ${sub.dir} failed: the build exited non-zero with a working toolchain, so this is the\n` +
            `  build's own failure and the output above is the evidence.\n`,
    );
    continue;
  }
  process.stdout.write(`  ok\n`);
}

if (failures > 0) {
  process.stderr.write(`\nverify:packages — ${failures} subpackage(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\nverify:packages ok: ${SUBPACKAGES.length} subpackage(s) build from clean install\n`,
  );
}
