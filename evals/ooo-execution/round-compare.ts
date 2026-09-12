// S4: compare ordered execution with the out-of-order round on the same frozen plan.
//
// The comparison reports what it measured and does not presume a winner. Quality, wall time,
// tokens, host cost, failures and human intervention are all recorded, because a scheduling
// change can trade one against another: this design's claim is about acceptance semantics, and
// the honest question for a comparison is whether it is slower.
//
// Two kinds of comparison, and the difference matters:
//   - `replay` worker: the same recorded answers drive both modes, so the token columns are
//     equal by construction and what is being measured is *scheduling* — wall clock, host
//     checks, how much of the wait the out-of-order task covered.
//   - `pi` worker: real model calls in both modes, which is the only way to compare tokens and
//     cost. That spends money in both arms, so it is an explicit operator decision.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CycleResult, type CycleWorker, runCycle } from "./cycle.ts";
import { readRoundLog, terminalEvent } from "./round-log.ts";
import { cycleOptionsFor, readBaseline, specDigest, specWorker } from "./round-runner.ts";
import type { RoundSpec } from "./round-spec.ts";

export type Mode = "ooo" | "sequential";

export interface Arm {
  mode: Mode;
  run: number;
  wallMs: number;
  /** Host verification: the cost this design adds, and the term that dominates every round. */
  hostMs: number;
  hostChecks: number;
  /** The part of the external wait the independent task's own work covered (its claim-to-return
   *  window, not its later verification): zero for the control. */
  hiddenWaitMs: number;
  tokens: number;
  cacheRead: number;
  checks: number;
  verdicts: Record<string, string>;
  accepted: Record<string, string>;
  killed: number;
  survived: number;
  reopens: number;
  failures: number;
  cancelled?: string;
}

export interface Comparison {
  specDigest: string;
  worker: string;
  runs: number;
  arms: Arm[];
  /** True when every arm accepted the same tasks. A comparison with different verdicts is
   *  not a comparison: it is two different rounds, and the harness says so. */
  qualityParity: boolean;
  differences: string[];
}

function tokensOf(result: CycleResult): { tokens: number; cacheRead: number; checks: number } {
  let tokens = 0;
  let cacheRead = 0;
  let checks = 0;
  for (const metrics of Object.values(result.measurements.workers)) {
    tokens += metrics.tokens ?? 0;
    cacheRead += metrics.cacheRead ?? 0;
    checks += metrics.checks ?? 0;
  }
  return { tokens, cacheRead, checks };
}

function arm(mode: Mode, run: number, result: CycleResult, wallMs: number): Arm {
  const { tokens, cacheRead, checks } = tokensOf(result);
  const killed = Object.values(result.killed).flat().length;
  const survived = Object.values(result.survived).flat().length;
  return {
    mode,
    run,
    wallMs,
    hostMs: result.measurements.hostMs,
    hostChecks: result.measurements.hostChecks,
    hiddenWaitMs: result.measurements.hiddenWaitMs,
    tokens,
    cacheRead,
    checks,
    verdicts: result.verdicts,
    accepted: result.accepted,
    killed,
    survived,
    reopens: result.measurements.reopens.length,
    failures: result.rejections.length,
    ...(result.cancelled ? { cancelled: result.cancelled } : {}),
  };
}

/** Runs both modes `times` times over one spec and reports the measured differences.
 *
 *  Each arm gets its own run directory, so every arm keeps its own store, log and record: a
 *  failure sample is evidence, and the comparison has to be able to point at it. */
export async function compareModes(options: {
  spec: RoundSpec;
  repository: string;
  outputDirectory: string;
  times: number;
  /** Injected by a test; the CLI resolves it from the spec like `submit` does. */
  workerFor?: (mode: Mode, runDirectory: string) => Promise<CycleWorker>;
}): Promise<Comparison> {
  const { revision, baseline } = readBaseline(options.spec, options.repository);
  const arms: Arm[] = [];
  const modes: Mode[] = ["ooo", "sequential"];
  for (let run = 1; run <= options.times; run += 1)
    for (const mode of modes) {
      const runDirectory = join(options.outputDirectory, `${mode}-${run}`);
      mkdirSync(runDirectory, { recursive: true });
      const worker = options.workerFor
        ? await options.workerFor(mode, runDirectory)
        : await specWorker(
            options.spec,
            { repository: options.repository, revision, baseline },
            {
              live: false,
            },
          );
      const started = Date.now();
      const result = await runCycle(
        cycleOptionsFor({
          spec: options.spec,
          repository: options.repository,
          revision,
          baseline,
          worker,
          runDirectory,
          mode,
        }),
      );
      arms.push(arm(mode, run, result, Date.now() - started));
    }
  // Compared by content, not by insertion order: the two modes accept in different orders, and
  // a parity check that called that a quality difference would be measuring the wrong thing.
  const canonical = (values: Record<string, string>) =>
    JSON.stringify(Object.fromEntries(Object.entries(values).sort()));
  const outcomes = new Set(
    arms.map((entry) => `${canonical(entry.accepted)}|${canonical(entry.verdicts)}`),
  );
  const comparison: Comparison = {
    specDigest: specDigest(options.spec),
    worker: options.spec.worker.kind,
    runs: options.times,
    arms,
    qualityParity: outcomes.size === 1,
    differences: [],
  };
  comparison.differences = describe(comparison);
  mkdirSync(options.outputDirectory, { recursive: true });
  writeFileSync(
    join(options.outputDirectory, "compare.json"),
    JSON.stringify(comparison, null, 2),
    "utf8",
  );
  return comparison;
}

/** The measured differences in words. Deliberately states both sides: a comparison that only
 *  reports the winner is not evidence. */
export function describe(comparison: Comparison): string[] {
  const lines: string[] = [];
  for (const mode of ["ooo", "sequential"] as const) {
    const arms = comparison.arms.filter((entry) => entry.mode === mode);
    if (!arms.length) continue;
    const sum = (pick: (entry: Arm) => number) =>
      arms.reduce((total, entry) => total + pick(entry), 0);
    const average = (pick: (entry: Arm) => number) => Math.round(sum(pick) / arms.length);
    // Quality first: a comparison whose arms disagree about quality is not a comparison.
    const verdicts = arms.map((entry) => JSON.stringify(entry.verdicts));
    const accepted = arms.map((entry) => JSON.stringify(entry.accepted));
    const unique = (values: string[]) => [...new Set(values)];
    lines.push(`${mode}: verdicts ${unique(verdicts).join(" | ")}`);
    lines.push(`${mode}: accepted ${unique(accepted).join(" | ")}`);
    lines.push(
      `${mode}: wall ${average((entry) => entry.wallMs)} ms, host ${sum((entry) => entry.hostMs)} ms ` +
        `over ${arms.reduce((total, entry) => total + entry.hostChecks, 0)} check(s), ` +
        `hidden wait ${average((entry) => entry.hiddenWaitMs)} ms, tokens ${sum((entry) => entry.tokens)}, ` +
        `cache read ${sum((entry) => entry.cacheRead)}, worker checks ${sum((entry) => entry.checks)}, ` +
        `killed ${sum((entry) => entry.killed)}, survived ${sum((entry) => entry.survived)}, ` +
        `failures ${sum((entry) => entry.failures)}, reopens ${sum((entry) => entry.reopens)}`,
    );
  }
  if (!comparison.qualityParity)
    lines.push(
      "quality differs between modes: the arms are not the same round and the timings are not comparable",
    );
  const ooo = comparison.arms.filter((entry) => entry.mode === "ooo");
  const sequential = comparison.arms.filter((entry) => entry.mode === "sequential");
  if (ooo.length && sequential.length) {
    const oooWall = ooo.reduce((total, entry) => total + entry.wallMs, 0) / ooo.length;
    const seqWall =
      sequential.reduce((total, entry) => total + entry.wallMs, 0) / sequential.length;
    const delta = Math.round(oooWall - seqWall);
    lines.push(
      `out-of-order minus sequential wall clock: ${delta} ms ` +
        `(${delta <= 0 ? "faster" : "slower"}) — reported, not treated as a result on its own`,
    );
  }
  return lines;
}

/** The recorded log of one arm, for a reader who wants the timeline behind a number. */
export function armLog(outputDirectory: string, mode: Mode, run: number) {
  const events = readRoundLog(
    readFileSync(join(outputDirectory, `${mode}-${run}`, "round.jsonl"), "utf8"),
  );
  return { events, terminal: terminalEvent(events) };
}
