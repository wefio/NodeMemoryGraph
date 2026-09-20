import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
  /** Where the checks ran. A command check runs in the workspace its caller prepared; a data check
   *  runs over the data and has none. */
  workspace?: string;
}

/** One check's answer, in the check's own words. */
export interface DataCheckResult {
  status: "passed" | "failed" | "undecidable";
  log?: string;
}

/** A check whose input is data and whose output is a verdict.
 *
 *  The host creates nothing for a check of this kind: no directory, no worktree, no link. There is
 *  therefore nothing to prepare, nothing to clean up, and nothing a killed run leaves behind. A check
 *  that must run in a workspace says so by being a command check, and its caller prepares that
 *  workspace and hands it over - the host does not prepare an environment on a caller's behalf. */
export interface DataCheck {
  label: string;
  verify(input: {
    /** What the candidate changed: the unit's work. */
    files: Readonly<Record<string, string>>;
    /** The frozen view the candidate was built on, which is also where its own checks live. */
    frozen: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<DataCheckResult> | DataCheckResult;
}

/** The verdict rule both kinds of check share, so that they cannot disagree by accident. */
function verdictOf(outcomes: readonly CheckOutcome[]): CandidateResult["verdict"] {
  return outcomes.some((outcome) => outcome.status === "failed")
    ? "reject"
    : outcomes.some((outcome) => outcome.status === "undecidable")
      ? "undecidable"
      : "accept";
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

function safeRelative(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    !path.includes("\\") &&
    path.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}

/** Runs the caller's fixed checks against candidate files in the workspace the caller prepared.
 *
 *  Writes candidate files and nothing else: no directory, no worktree, no `node_modules` link, and no
 *  cleanup. Which working tree the checks run in, and whether it is clean, is the caller's business -
 *  a check that finds its environment wrong reports that, and tidying up after it is not this
 *  function's job. Runs candidate code: this bounds accidental damage and absent context, not a
 *  hostile-code sandbox. */
export async function verifyCandidate(options: {
  /** An existing directory the caller prepared at the revision under test. */
  workspace: string;
  files: Readonly<Record<string, string>>;
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

  const outcomes: CheckOutcome[] = [];
  for (const [path, content] of Object.entries(options.files)) {
    const target = join(options.workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  for (const check of options.checks) {
    const result = await run(
      check.command,
      check.args,
      options.workspace,
      timeoutMs,
      options.signal,
    );
    outcomes.push({
      label: check.label,
      status: result.ok ? "passed" : result.undecidable ? "undecidable" : "failed",
      exitCode: result.exitCode,
      log: result.log,
      ...(result.aborted ? { aborted: true } : {}),
    });
    if (result.aborted) break;
  }
  return { verdict: verdictOf(outcomes), outcomes, workspace: options.workspace };
}

/** Runs the caller's data checks over a candidate and the frozen view it was built on.
 *
 *  Nothing is created and nothing is written: a data check is a function over the data, so two
 *  candidates cannot see each other's leftovers and an interrupted run has nothing to leak. */
export async function verifyDataChecks(options: {
  files: Readonly<Record<string, string>>;
  frozen: Readonly<Record<string, string>>;
  checks: readonly DataCheck[];
  signal?: AbortSignal;
}): Promise<CandidateResult> {
  if (!options.checks.length) throw new Error("no data checks supplied");
  const outcomes: CheckOutcome[] = [];
  for (const check of options.checks) {
    if (options.signal?.aborted) {
      outcomes.push({
        label: check.label,
        status: "undecidable",
        exitCode: null,
        log: "cancelled before start",
        aborted: true,
      });
      break;
    }
    let answer: DataCheckResult;
    try {
      answer = await check.verify({
        files: options.files,
        frozen: options.frozen,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // A check that throws has not answered, and that is inconclusive rather than a rejection: the
      // candidate is not on trial for the check's own defect.
      answer = {
        status: "undecidable",
        log: error instanceof Error ? error.message : String(error),
      };
    }
    outcomes.push({
      label: check.label,
      status: answer.status,
      exitCode: null,
      log: (answer.log ?? "").slice(-MAX_LOG),
    });
  }
  return { verdict: verdictOf(outcomes), outcomes };
}
