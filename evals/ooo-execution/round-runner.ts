// S3: run a round described by a spec file, in a run directory that carries everything a
// later process needs to query or cancel it.
//
// The run directory is the round's durable surface. `submit` / `status` / `cancel` are the
// three entry points the bootstrap design asks for, and they map onto durable-agent shapes
// that already exist elsewhere (submit a run, query its state, cancel it) instead of onto a
// new hand-written round script.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BoardAdmission, type ProbePlan } from "./board-admission.ts";
import { verifyCandidate } from "./candidate.ts";
import { runCycle, type CycleOptions, type CycleResult, type CycleWorker } from "./cycle.ts";
import { RoundLog, readRoundLog, recordedWorker, terminalEvent } from "./round-log.ts";
import type { RoundSpec, SpecWorker } from "./round-spec.ts";

/** The plan the round runs under, written into the run directory so a *different* process can
 *  open the same store and cancel the same round. */
export const ROUND_PLAN: ProbePlan = [
  ["A", "", [], "isolated-artifact", "protocol-regression", null],
  ["B", "", [], "isolated-artifact", null, null],
  ["C", "", ["A", "B"], "isolated-artifact", null, null],
];

export interface RunRecord {
  specDigest: string;
  startedAt: string;
  finishedAt?: string;
  worker: SpecWorker;
  revision: string;
  verdicts?: Record<string, string>;
  accepted?: Record<string, string>;
  cancelled?: string;
  measurements?: CycleResult["measurements"];
  composed?: { verdict: string; files: string[] };
  rejections?: CycleResult["rejections"];
}

/** `runCycle` owns `<dir>/store.sqlite`; the runner reads the same file, never a copy. */
export const storePath = (runDir: string) => join(runDir, "store.sqlite");
export const logPath = (runDir: string) => join(runDir, "round.jsonl");
export const recordPath = (runDir: string) => join(runDir, "run.json");

export function specDigest(spec: RoundSpec): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

export function readRecord(runDir: string): RunRecord | null {
  if (!existsSync(recordPath(runDir))) return null;
  return JSON.parse(readFileSync(recordPath(runDir), "utf8")) as RunRecord;
}

/** The store the running round owns, opened by another process for `status` / `cancel`.
 *  Reading never creates one: a directory with no store has no round to report. */
export function openRoundStore(runDir: string): BoardAdmission {
  if (!existsSync(storePath(runDir))) throw new Error(`no round store in ${runDir}`);
  return new BoardAdmission(storePath(runDir), ROUND_PLAN, {});
}

/** The round's own store, created if this is the round's first moment. The runner needs it
 *  before `runCycle` starts, because that is the channel an operator's `cancel` arrives on. */
function ensureRoundStore(runDir: string): BoardAdmission {
  mkdirSync(runDir, { recursive: true });
  return new BoardAdmission(storePath(runDir), ROUND_PLAN, {});
}

export interface RoundInputs {
  repository: string;
  revision: string;
  baseline: Readonly<Record<string, string>>;
}

/** Resolves a spec's worker against the round's own inputs.
 *
 *  `pi` needs an explicit authorization at the call site: a spec file names a provider, but
 *  the provider boundary is not something a spec gets to cross on its own. */
export async function specWorker(
  spec: RoundSpec,
  inputs: RoundInputs,
  options: { live: boolean },
): Promise<CycleWorker> {
  const worker: SpecWorker = spec.worker;
  if (worker.kind === "replay") {
    // A recorded log may be archived outside the repository, so an absolute path is taken as
    // given; a relative one is resolved against the repository like every other spec path.
    const path = isAbsolute(worker.log) ? worker.log : join(inputs.repository, worker.log);
    return recordedWorker(readRoundLog(readFileSync(path, "utf8")));
  }
  if (!options.live)
    throw new Error(
      "refusing a live model round without --live: the spec names the provider, the operator " +
        "authorizes the spend",
    );
  const { executePiPatch } = await import("../../.pi/extensions/nmg/ooo-execution.ts");
  const checkTool = {
    label: "run_check",
    maxRuns: spec.checkRuns ?? 4,
    run: async (files: { path: string; content: string }[]) => {
      const result = await verifyCandidate({
        repository: inputs.repository,
        revision: inputs.revision,
        files: {
          ...inputs.baseline,
          ...Object.fromEntries(files.map((file) => [file.path, file.content])),
        },
        checks: [...spec.checks],
      });
      const failed = result.outcomes.find((outcome) => outcome.status !== "passed");
      return {
        verdict: result.verdict,
        log:
          result.outcomes.map((outcome) => `${outcome.label}=${outcome.status}`).join(", ") +
          (failed?.log ? ` | ${failed.log.slice(-2_000)}` : ""),
      };
    },
  };
  return async (_taskId, frozen) => {
    const run = await executePiPatch(frozen, worker.provider, worker.model, {
      check: checkTool,
    });
    const metrics = { tokens: run.tokens, turns: run.turns, checks: run.checks };
    return run.pushback
      ? { artifact: "", pushback: run.pushback, metrics }
      : { artifact: run.artifact, metrics };
  };
}

/** Reads the round's frozen baseline from the repository, at the spec's revision. */
export function readBaseline(
  spec: RoundSpec,
  repository: string,
): { revision: string; baseline: Record<string, string> } {
  const revision =
    spec.revision === "HEAD"
      ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim()
      : spec.revision;
  return {
    revision,
    baseline: Object.fromEntries(
      spec.baseline.map((path) => [path, readFileSync(join(repository, path), "utf8")]),
    ),
  };
}

/** The round options a spec defines. One home for the mapping, so `submit` and the S4
 *  comparison cannot drift into running subtly different rounds from the same spec. */
export function cycleOptionsFor(options: {
  spec: RoundSpec;
  repository: string;
  revision: string;
  baseline: Readonly<Record<string, string>>;
  worker: CycleWorker;
  runDirectory: string;
  mode?: "ooo" | "sequential";
  signal?: AbortSignal;
  watchCancellation?: () => string | null;
}): CycleOptions {
  const { spec } = options;
  return {
    repository: options.repository,
    revision: options.revision,
    baseline: options.baseline,
    checks: spec.checks,
    worker: options.worker,
    mode: options.mode ?? "ooo",
    aInstruction: spec.a.instruction,
    bInstruction: spec.b.instruction,
    aEditable: spec.a.editable,
    bEditable: spec.b.editable,
    budget: spec.budget ?? { perFile: 24_000, output: 48_000 },
    limits: spec.limits ?? { turns: 10, reads: 6, timeoutMs: 240_000 },
    roundLog: new RoundLog(logPath(options.runDirectory)),
    databaseDir: options.runDirectory,
    ...(options.watchCancellation ? { watchCancellation: options.watchCancellation } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(spec.noChangeCases ? { noChangeCases: spec.noChangeCases } : {}),
    ...(spec.mutations ? { mutations: spec.mutations } : {}),
    ...(spec.visible ? { visible: spec.visible } : {}),
    ...(spec.admitted ? { admitted: spec.admitted } : {}),
    ...(spec.requires ? { requires: spec.requires } : {}),
    ...(spec.maxReopens === undefined ? {} : { maxReopens: spec.maxReopens }),
  };
}

/** Runs one round from its spec, writing the log and a durable record as it goes. The
 *  running round polls the store, so `cancelRun` from another process reaches it. */
export async function runSpecifiedRound(options: {
  spec: RoundSpec;
  runDir: string;
  repository: string;
  /** Resolved once by the caller (or injected by a test). */
  worker: CycleWorker;
  revision: string;
  baseline: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<CycleResult> {
  const existing = readRecord(options.runDir);
  if (existing?.finishedAt)
    throw new Error(`${options.runDir} already holds a finished round; use a new run directory`);
  mkdirSync(options.runDir, { recursive: true });
  const started: RunRecord = {
    specDigest: specDigest(options.spec),
    startedAt: new Date().toISOString(),
    worker: options.spec.worker,
    revision: options.revision,
  };
  writeFileSync(recordPath(options.runDir), JSON.stringify(started, null, 2), "utf8");
  const store = ensureRoundStore(options.runDir);
  try {
    const result = await runCycle(
      cycleOptionsFor({
        spec: options.spec,
        repository: options.repository,
        revision: options.revision,
        baseline: options.baseline,
        worker: options.worker,
        runDirectory: options.runDir,
        watchCancellation: () => store.cancelled(),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    writeFileSync(
      recordPath(options.runDir),
      JSON.stringify(
        {
          ...started,
          finishedAt: new Date().toISOString(),
          verdicts: result.verdicts,
          accepted: result.accepted,
          composed: { verdict: result.composed.verdict, files: [...result.composed.files] },
          measurements: result.measurements,
          rejections: result.rejections,
          ...(result.cancelled ? { cancelled: result.cancelled } : {}),
        } satisfies RunRecord,
        null,
        2,
      ),
      "utf8",
    );
    return result;
  } finally {
    store.close();
  }
}

/** `status` for a run directory: the durable record, plus the store's own view, so a round
 *  cancelled by another process is reported even before its process writes anything. */
export function describeRun(runDir: string): string {
  const record = readRecord(runDir);
  const lines: string[] = [`run directory: ${runDir}`];
  if (!record) lines.push("state: no run recorded here");
  else {
    lines.push(`worker: ${record.worker.kind}`);
    lines.push(`revision: ${record.revision.slice(0, 12)}`);
    lines.push(`started: ${record.startedAt}`);
    lines.push(record.finishedAt ? `finished: ${record.finishedAt}` : "state: not finished");
    if (record.cancelled) lines.push(`cancelled: ${record.cancelled}`);
    if (record.verdicts) lines.push(`verdicts: ${JSON.stringify(record.verdicts)}`);
    if (record.accepted) lines.push(`accepted: ${JSON.stringify(record.accepted)}`);
    if (record.measurements)
      lines.push(
        `measurements: host ${record.measurements.hostMs} ms over ` +
          `${record.measurements.hostChecks} check(s), hidden wait ` +
          `${record.measurements.hiddenWaitMs} ms, reopens ${record.measurements.reopens.length}`,
      );
  }
  if (existsSync(logPath(runDir))) {
    const events = readRoundLog(readFileSync(logPath(runDir), "utf8"));
    lines.push(`log events: ${events.length}`);
    const terminal = terminalEvent(events);
    if (terminal) lines.push(`log terminal: ${JSON.stringify(terminal.verdicts)}`);
  }
  if (existsSync(storePath(runDir))) {
    const store = openRoundStore(runDir);
    try {
      lines.push(`coordinator cancelled: ${store.cancelled() ?? "no"}`);
      lines.push(`coordinator accepted: ${JSON.stringify(store.accepted())}`);
    } finally {
      store.close();
    }
  }
  return lines.join("\n");
}

/** Records the operator's cancellation in the round's own store. The running round polls that
 *  store, so this reaches a round this process does not own. */
export function cancelRun(runDir: string, reason: string): string {
  const store = openRoundStore(runDir);
  try {
    store.cancel(reason);
    return store.cancelled() ?? reason;
  } finally {
    store.close();
  }
}
