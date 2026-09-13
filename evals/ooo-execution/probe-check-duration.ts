// Does the share of a round that out-of-order execution hides actually grow with the check's
// duration? That is the premise the design rests on, and it has never been measured — the in-round
// check in real rounds is ~1.9 s against ~56 s of worker time.
//
// What is real: the orchestrator, the board, the candidate worktree, the check processes, the
// acceptance rules and the frozen baseline. What is chosen rather than observed: the check's
// duration, and the workers' duration. A replay returns instantly, so an offline arm can never be
// overlapped at all — hence workers that do CPU-bounded work of a chosen duration. CPU-bound
// overlap is a LOWER bound for the real case: two CPU-bound activities contend for cores, while a
// model call mostly waits on the network.
//
// Zero model tokens: no provider is contacted.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FrozenPatchWork } from "../../src/integration/ooo-patch.ts";
import { compareModes } from "./round-compare.ts";
import { readRoundLog } from "../../src/integration/ooo-round-log.ts";
import { parseRoundSpec, type RoundSpec } from "./round-spec.ts";

const run = promisify(execFile);

/** Real CPU work for a chosen duration. Not a sleep: a sleep would not contend for anything. */
const busy = (ms: number): string =>
  `const end=Date.now()+${ms};let a=1;while(Date.now()<end){a=(a*16807)%2147483647;}if(a<=0)process.exit(3);`;

const BASELINE = ["evals/ooo-execution/cancellation.test.ts"];
const CASE_TOKEN = "cancelling a round kills";
const REPOSITORY = process.cwd();

function specObject(checkMs: number): Record<string, unknown> {
  return {
    revision: "HEAD",
    baseline: BASELINE,
    checks: [
      {
        label: "durational-check",
        command: process.execPath,
        args: ["-e", busy(checkMs)],
      },
    ],
    a: { instruction: "repair what the check exposes", editable: BASELINE },
    b: { instruction: "add the missing regressions", editable: BASELINE },
    worker: { kind: "replay", log: "unused-in-this-probe" },
    noChangeCases: { A: [{ name: "check-identity", token: CASE_TOKEN }] },
    admitted: {
      A: ["no-change-needed", "cannot-complete"],
      B: ["cannot-complete"],
      C: ["promote-candidate", "cannot-complete"],
    },
    budget: { perFile: 40_000, output: 40_000 },
    limits: { turns: 2, reads: 2, timeoutMs: 120_000 },
  };
}

/** The same accepted answers the comparison test uses: the probe studies scheduling, so the inputs
 *  must not differ between the arms or between the grid points. */
function answers(task: string, frozen: FrozenPatchWork): string {
  if (task === "A")
    return JSON.stringify({
      digest: frozen.digest,
      kind: "conclusion",
      conclusion: "no-change-needed",
      summary: "the check passes, so there is nothing to repair",
      evidence: "cited from the frozen suite",
      citations: [
        {
          case: "check-identity",
          test: "cancelling a round kills its running check and leaves no accepted work",
        },
      ],
    });
  if (task === "B")
    return JSON.stringify({
      digest: frozen.digest,
      files: [
        {
          path: BASELINE[0]!,
          content: `${frozen.work.files[BASELINE[0]!]}\ntest("compare added", () => {});\n`,
        },
      ],
    });
  return JSON.stringify({
    digest: frozen.digest,
    kind: "conclusion",
    conclusion: "promote-candidate",
    summary: "combined candidate verified by the host",
    evidence: "composed-check accept",
    citations: [],
  });
}

interface Window {
  label: string;
  fromMs: number;
  toMs: number;
}

/** The true question: how much of the round check was covered by the independent task running,
 *  as opposed to two host checks simply running at the same time. */
function coverage(logPath: string): {
  checks: Window[];
  checkCoveredByBMs: number;
} {
  const events = readRoundLog(readFileSync(logPath, "utf8"));
  const at = (event: { at?: string }) => (event.at ? Date.parse(event.at) : Number.NaN);
  const start = Math.min(
    ...events.map((event) => at(event as { at?: string })).filter(Number.isFinite),
  );
  const issued = new Map<string, number>();
  const checks: Window[] = [];
  let bFrom = Number.NaN;
  let bTo = Number.NaN;
  for (const event of events) {
    const time = at(event as { at?: string }) - start;
    if (event.kind === "check-issued") issued.set(event.ticket.label, time);
    if (event.kind === "check-result" && issued.has(event.label))
      checks.push({ label: event.label, fromMs: issued.get(event.label)!, toMs: time });
    if (event.kind === "claim" && event.taskId === "B") bFrom = time;
    if (event.kind === "artifact" && event.taskId === "B") bTo = time;
  }
  let covered = 0;
  for (const check of checks)
    covered = Math.max(
      covered,
      Math.max(0, Math.min(check.toMs, bTo) - Math.max(check.fromMs, bFrom)),
    );
  return { checks, checkCoveredByBMs: covered };
}

interface Point {
  checkMs: number;
  workerMs: number;
  oooWallMs: number;
  sequentialWallMs: number;
  hiddenWaitMs: number;
  hiddenShare: number;
  hostMs: number;
  /** What the harness reports as hidden, versus how much of a check the independent task really
   *  covered. When these differ, the harness number is host-check concurrency, not wait hiding. */
  checkCoveredByBMs: number;
  checkCount: number;
  verdicts: string;
}

function parseFlags(argv: readonly string[]): { out: string; checks: number[]; workers: number[] } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} needs a value (never default to a guess)`);
    values.set(flag, value);
    i += 1;
  }
  const out = values.get("--out");
  if (!out) throw new Error("--out <dir> is required: the probe records what it measured");
  const numbers = (flag: string, fallback: number[]) =>
    values.has(flag) ? values.get(flag)!.split(",").map(Number) : fallback;
  return {
    out,
    checks: numbers("--check-ms", [0, 2_000, 8_000, 40_000]),
    workers: numbers("--worker-ms", [2_000, 8_000]),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const { out, checks, workers } = parseFlags(argv);
  if (!BASELINE.every((file) => file.length > 0)) throw new Error("baseline is empty");
  const points: Point[] = [];
  {
    const grid: Array<{ checkMs: number; workerMs: number }> = [
      { checkMs: 0, workerMs: 0 },
      ...checks.flatMap((checkMs) => workers.map((workerMs) => ({ checkMs, workerMs }))),
    ];
    for (const { checkMs, workerMs } of grid) {
      const directory = join(out, `check-${checkMs}-worker-${workerMs}`);
      mkdirSync(directory, { recursive: true });
      const spec: RoundSpec = parseRoundSpec(specObject(checkMs));
      const comparison = await compareModes({
        spec,
        repository: REPOSITORY,
        outputDirectory: directory,
        times: 1,
        workerFor: async () => async (task: string, frozen: FrozenPatchWork) => {
          if (task === "B" && workerMs > 0) await run(process.execPath, ["-e", busy(workerMs)]);
          return answers(task, frozen);
        },
      });
      // Refuse to compare incomparable arms, exactly as the product comparison does.
      if (!comparison.qualityParity)
        throw new Error(
          `check=${checkMs} worker=${workerMs}: the arms disagree, so their times are not comparable: ${JSON.stringify(comparison.differences)}`,
        );
      const ooo = comparison.arms.find((entry) => entry.mode === "ooo")!;
      const sequential = comparison.arms.find((entry) => entry.mode === "sequential")!;
      if (ooo.hostChecks < 1) throw new Error("the check never ran, so nothing was measured");
      if (sequential.hiddenWaitMs !== 0)
        throw new Error("the control must not hide a wait; its hidden wait is non-zero");
      points.push({
        checkMs,
        workerMs,
        oooWallMs: ooo.wallMs,
        sequentialWallMs: sequential.wallMs,
        hiddenWaitMs: ooo.hiddenWaitMs,
        hiddenShare: ooo.hiddenWaitMs / sequential.wallMs,
        hostMs: ooo.hostMs,
        checkCoveredByBMs: coverage(join(directory, "ooo-1", "round.jsonl")).checkCoveredByBMs,
        checkCount: coverage(join(directory, "ooo-1", "round.jsonl")).checks.length,
        verdicts: Object.entries(ooo.verdicts)
          .sort()
          .map(([task, verdict]) => `${task}:${verdict}`)
          .join(" "),
      });
    }
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "check-duration.json"), JSON.stringify({ points }, null, 2), "utf8");
  process.stdout.write(
    [
      "check ms | worker ms | ooo wall ms | sequential wall ms | ooo-seq ms | harness hidden ms | covered by B ms | checks",
      ...points.map(
        (p) =>
          `${String(p.checkMs).padStart(8)} | ${String(p.workerMs).padStart(9)} | ${String(p.oooWallMs).padStart(11)} | ${String(p.sequentialWallMs).padStart(18)} | ${String(p.oooWallMs - p.sequentialWallMs).padStart(10)} | ${String(p.hiddenWaitMs).padStart(17)} | ${String(p.checkCoveredByBMs).padStart(15)} | ${String(p.checkCount).padStart(6)}`,
      ),
      "",
      `verdicts identical across the grid: ${new Set(points.map((p) => p.verdicts)).size === 1}`,
    ].join("\n") + "\n",
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
