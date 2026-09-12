// Pi adaptation of the restricted out-of-order round: a thin surface, so that a normal session can
// drive one round. It binds to the round entry point that already exists (and is reviewed) instead
// of re-implementing the coordinator here — the adapter stays thin, and the shared layer keeps
// owning selection, attempts, fencing and acceptance.
//
// Deliberate properties:
//   - Off unless NMG_OOO_TOOLS=1. A tool in every session costs context, and this path is still an
//     experiment; the registry records the gate.
//   - `submit` never blocks the session. A live round takes minutes, and the CLI's own `submit`
//     waits for the terminal event, so this starts it detached with a log and the caller polls
//     `status` — which is exactly the cross-process property the design asks for.
//   - Missing inputs are refused by name rather than guessed.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type OooRoundAction = "submit" | "status" | "cancel";

export interface OooRoundParams {
  action: OooRoundAction;
  specPath?: string;
  runDir?: string;
  reason?: string;
  live?: boolean;
}

/** A hidden capability, so it is explicitly gated and registered. */
export function oooToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NMG_OOO_TOOLS === "1";
}

const CLI = "evals/ooo-execution/round-cli.ts";

/** The exact arguments for one action, or a refusal that names what is missing. */
export function roundArgv(params: OooRoundParams): string[] {
  if (!params.runDir)
    throw new Error("runDir is required: a round keeps its state in its own run directory");
  const base = ["--experimental-strip-types", CLI, params.action];
  if (params.action === "submit") {
    if (!params.specPath) throw new Error("submit requires specPath (the round spec JSON file)");
    const argv = [...base, params.specPath, "--run-dir", params.runDir];
    if (params.live) argv.push("--live");
    return argv;
  }
  if (params.action === "cancel") {
    if (!params.reason)
      throw new Error(
        "cancel requires reason: the decision is recorded in the round's store and survives a restart",
      );
    return [...base, "--run-dir", params.runDir, "--reason", params.reason];
  }
  return [...base, "--run-dir", params.runDir];
}

export interface StartedRound {
  pid: number | undefined;
  logPath: string;
}

/** Starts the round detached, so the session stays responsive while it runs. */
export function startRound(projectDir: string, params: OooRoundParams): StartedRound {
  const argv = roundArgv(params);
  const runDir = params.runDir!;
  mkdirSync(runDir, { recursive: true });
  const logPath = join(runDir, "cli.log");
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, argv, {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return { pid: child.pid, logPath };
}

export interface RoundReply {
  action: OooRoundAction;
  code: number;
  output: string;
}

/** Status and cancel are bounded: they read or write the run directory, they do not run a round. */
export async function shortRound(projectDir: string, params: OooRoundParams): Promise<RoundReply> {
  const argv = roundArgv(params);
  try {
    const { stdout, stderr } = await run(process.execPath, argv, {
      cwd: projectDir,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { action: params.action, code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
    return {
      action: params.action,
      code: failure.code ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message,
    };
  }
}

/** What a started round should be told: it is running elsewhere, and what to read afterwards. */
export function describeStart(params: OooRoundParams, started: StartedRound): string {
  return [
    `round ${params.action} started detached (pid ${started.pid ?? "unknown"})`,
    `run directory: ${params.runDir}`,
    `mode: ${params.live ? "live model calls (this spends tokens)" : "recorded answers (no model calls)"}`,
    `log: ${started.logPath}`,
    "the round owns its own state; poll it with action=status, stop it with action=cancel --reason",
  ].join("\n");
}
