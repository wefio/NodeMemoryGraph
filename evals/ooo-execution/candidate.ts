import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface CandidateCheck {
  label: string;
  command: string;
  args: readonly string[];
}

export interface CheckOutcome {
  label: string;
  status: "passed" | "failed" | "undecidable";
  exitCode: number | null;
  log: string;
}

export interface CandidateResult {
  verdict: "accept" | "reject" | "undecidable";
  outcomes: CheckOutcome[];
  worktree: string;
}

const MAX_LOG = 4_000;

/** Only PATH-like variables pass to candidate checks: provider credentials and
 *  NODE_OPTIONS preload hooks from the host environment must not leak in. */
function checkEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "PATHEXT"];
  return Object.fromEntries(
    allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]),
  );
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; undecidable: boolean; exitCode: number | null; log: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 1_000_000, env: checkEnvironment() },
      (error, stdout, stderr) => {
        const log = (stdout + stderr).slice(-MAX_LOG);
        if (!error) return resolve({ ok: true, undecidable: false, exitCode: 0, log });
        const exitCode = typeof error.code === "number" ? error.code : null;
        // A signal, timeout, or missing tool is inconclusive, never a rejection.
        const undecidable = (error as { killed?: boolean }).killed === true || exitCode === null;
        resolve({ ok: false, undecidable, exitCode, log });
      },
    );
  });
}

function git(repository: string, args: readonly string[], timeoutMs: number) {
  return run("git", args, repository, timeoutMs);
}

function safeRelative(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    !path.includes("\\") &&
    path.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}

/** Applies candidate files into an isolated git worktree of the frozen revision
 *  and runs the host's fixed checks there. Runs candidate code: this bounds
 *  accidental damage and absent context, not a hostile-code sandbox. */
export async function verifyCandidate(options: {
  repository: string;
  files: Readonly<Record<string, string>>;
  revision: string;
  checks: readonly CandidateCheck[];
  timeoutMs?: number;
}): Promise<CandidateResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const paths = Object.keys(options.files);
  if (!paths.length || paths.some((path) => !safeRelative(path)))
    throw new Error("candidate paths must be relative and non-empty");
  if (!options.checks.length) throw new Error("no fixed checks supplied");

  const parent = await mkdtemp(join(tmpdir(), "nmg-candidate-"));
  const worktree = join(parent, "worktree");
  const outcomes: CheckOutcome[] = [];
  try {
    const added = await git(
      options.repository,
      ["worktree", "add", "--detach", worktree, options.revision],
      60_000,
    );
    if (!added.ok)
      return {
        verdict: "undecidable",
        outcomes: [
          { label: "worktree", status: "undecidable", exitCode: added.exitCode, log: added.log },
        ],
        worktree,
      };
    await symlink(
      join(options.repository, "node_modules"),
      join(worktree, "node_modules"),
      "junction",
    );
    for (const [path, content] of Object.entries(options.files)) {
      const target = join(worktree, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    for (const check of options.checks) {
      const result = await run(check.command, check.args, worktree, timeoutMs);
      outcomes.push({
        label: check.label,
        status: result.ok ? "passed" : result.undecidable ? "undecidable" : "failed",
        exitCode: result.exitCode,
        log: result.log,
      });
    }
  } finally {
    await git(options.repository, ["worktree", "remove", "--force", worktree], 60_000);
    await rm(parent, { recursive: true, force: true });
  }
  const verdict = outcomes.some((outcome) => outcome.status === "failed")
    ? "reject"
    : outcomes.some((outcome) => outcome.status === "undecidable")
      ? "undecidable"
      : "accept";
  return { verdict, outcomes, worktree };
}
