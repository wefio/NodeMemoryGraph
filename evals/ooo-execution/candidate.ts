import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
  /** The round was cancelled while this check ran. Recorded separately from a plain
   *  `undecidable` because it is a decision, not an inconclusive measurement. */
  aborted?: boolean;
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

/** Kills a check and everything it spawned.
 *
 *  `child.kill()` reaches the direct child only, so a check that spawns a test runner of its
 *  own leaves that grandchild running after the round is gone — an orphan process doing work
 *  for a round nobody is waiting for. Cancellation therefore kills the tree, and on Windows
 *  that is what `taskkill /T` is for. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or not ours to kill: the outcome stays undecidable either way.
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing left to kill.
    }
  }
}

interface RunResult {
  ok: boolean;
  undecidable: boolean;
  aborted?: boolean;
  exitCode: number | null;
  log: string;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal?.aborted)
      return resolve({
        ok: false,
        undecidable: true,
        aborted: true,
        exitCode: null,
        log: "cancelled before start",
      });
    // `spawn`, not `execFile`: the POSIX branch of the tree kill needs a detached process
    // group, which `execFile`'s options do not expose.
    const child = spawn(command, [...args], {
      cwd,
      env: checkEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: Error) =>
      finish({ ok: false, undecidable: true, exitCode: null, log: error.message }),
    );
    child.on("close", (code: number | null, killedBy: NodeJS.Signals | null) => {
      const log = output.slice(-MAX_LOG);
      if (code === 0 && !aborted && !timedOut)
        return finish({ ok: true, undecidable: false, exitCode: 0, log });
      // A signal, timeout, or missing tool is inconclusive, never a rejection.
      const undecidable = timedOut || aborted || killedBy !== null || code === null;
      finish({
        ok: false,
        undecidable,
        exitCode: code,
        log: log || (aborted ? "cancelled" : "no output"),
        ...(aborted ? { aborted: true } : {}),
      });
    });
  });
}

/** Git calls are never cancelled: cleanup has to run even when the round was cancelled,
 *  or the cancelled round leaks its worktree. */
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

/** Creates the candidate worktree, retrying a failure that is not a verdict.
 *
 *  Two verifications can legitimately run at once (the round's own check waits while the
 *  premise matrix measures mutants), and concurrent `git worktree add` calls in one
 *  repository intermittently fail on repository metadata. That failure is infrastructure,
 *  not evidence: one round recorded it as "the mutant is already detected" in 76 ms, which
 *  is a false premise reported as a measured one. The retry is bounded and its exhaustion
 *  is reported as `undecidable` rather than silently folded into either verdict. */
async function addWorktree(
  repository: string,
  worktree: string,
  revision: string,
): Promise<{ ok: boolean; exitCode: number | null; log: string }> {
  let last = await git(repository, ["worktree", "remove", "--force", worktree], 60_000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await git(repository, ["worktree", "add", "--detach", worktree, revision], 60_000);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  return last;
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
  /** Operator cancellation: in-flight checks are killed with their process tree. */
  signal?: AbortSignal;
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
    const added = await addWorktree(options.repository, worktree, options.revision);
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
      const result = await run(check.command, check.args, worktree, timeoutMs, options.signal);
      outcomes.push({
        label: check.label,
        status: result.ok ? "passed" : result.undecidable ? "undecidable" : "failed",
        exitCode: result.exitCode,
        log: result.log,
        ...(result.aborted ? { aborted: true } : {}),
      });
      if (result.aborted) break;
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
