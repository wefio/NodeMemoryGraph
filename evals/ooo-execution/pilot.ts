// The paid pilot: the same frozen work as one unit, as four units at one slot, and as four units at
// two slots, run against the configured model, with the arm order randomly drawn and every run
// recorded, including the ones that failed.
//
// What it measures is F1's three expectations on a real worker: whether a finer plan costs more wall
// time in the host, whether a slot actually buys overlap once a model - not a stub - is the worker,
// and whether the arms reach the same accepted work. The sample is small by construction and is
// reported as such; a difference the sample cannot resolve is a difference this script does not claim.
//
// Usage:
//   node --experimental-strip-types evals/ooo-execution/pilot.ts --live \
//     --out <results.json> [--family pipeline] [--reps 3,3,2] [--seed 1] [--runs-dir <dir>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { piWorker, runPlan, specFrom, type SpecFile } from "./plan-driver.ts";

const USAGE =
  "usage: pilot.ts --live --out <file> [--family <dir>] [--reps A,B,C] [--seed <n>] " +
  "[--runs-dir <dir>]\n" +
  "  --live      required: this calls the configured model (" +
  "PI_PROVIDER/PI_MODEL) and spends tokens\n" +
  "  --family    the fixture directory under evals/ooo-execution/fixtures (default: pipeline)\n" +
  "  --reps      runs per arm, in the order coarse,fine-1-slot,fine-2-slots (default: 3,3,2)\n" +
  "  --seed      seed for the arm order draw, so the order is reproducible (default: 1)\n" +
  "  --runs-dir  where each run's own result is written (default: --out's directory + /runs)\n" +
  "  --report    re-aggregate result files already recorded (comma-separated); no model call";

/** The pilot fixes the envelope's limits and never the arms' variables: the first model turn comes
 *  back aborted often enough that the host default of three turns spends the attempt on it. */
const PILOT_LIMITS = { turns: 6, reads: 3, timeoutMs: 120_000 } as const;

function flags(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const value = argv[index + 1];
    // A flag with no value of its own is a switch: `--live --out x` must not read `--out` as one.
    if (value === undefined || value.startsWith("--")) {
      parsed[flag.slice(2)] = "true";
      continue;
    }
    parsed[flag.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

/** A deterministic draw, so a reader can re-run the same arm order. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

const values = flags(process.argv.slice(2));
const out = values["out"];
if (!out) throw new Error(`--out is required\n${USAGE}`);
const family = values["family"] ?? "pipeline";

/** `--report a.json,b.json` re-derives the aggregate from runs already recorded - no model call, and
 *  the only way to combine two sittings. The runs are the evidence; this refuses a set that was not
 *  produced by the same instrument. */
const reportOnly = values["report"]
  ? [values["report"]]
      .flatMap((paths) => paths.split(","))
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
      .map((path) => resolve(path))
  : undefined;
if (reportOnly && !reportOnly.length) throw new Error(`--report needs at least one file\n${USAGE}`);
if (!reportOnly && !process.argv.includes("--live"))
  throw new Error(`refusing a paid run without --live\n${USAGE}`);
const provider = reportOnly ? "" : (process.env.PI_PROVIDER ?? "");
const model = reportOnly ? "" : (process.env.PI_MODEL ?? "");
if (!reportOnly && (!provider || !model))
  throw new Error(
    "Set PI_PROVIDER and PI_MODEL: the pilot's model is an input, not a default\n" + USAGE,
  );
const reps = (values["reps"] ?? "3,3,2")
  .split(",")
  .map((value) => Number(value.trim()));
if (reps.length !== 3 || reps.some((count) => !Number.isSafeInteger(count) || count < 1))
  throw new Error(`--reps wants three positive integers, one per arm\n${USAGE}`);
const seed = Number(values["seed"] ?? 1);
if (!Number.isSafeInteger(seed)) throw new Error(`--seed wants an integer\n${USAGE}`);
const runsDir = values["runs-dir"] ?? resolve(out, "..", "runs");
mkdirSync(runsDir, { recursive: true });

const directory = resolve("evals/ooo-execution/fixtures", family);
const read = (name: string): SpecFile => {
  const file = JSON.parse(readFileSync(resolve(directory, name), "utf8")) as SpecFile;
  if (file.worker.kind !== "canned")
    throw new Error(`${name}: the pilot supplies the worker, so the spec must not name one`);
  return { ...file, worker: { kind: "pi", provider, model }, limits: { ...PILOT_LIMITS } };
};

/** A = the whole task in one unit, B = the same work in four units, C = B with two slots. */
const ARMS = [
  { arm: "A", plan: "coarse (1 unit)", slots: 1, spec: "coarse.spec.json" },
  { arm: "B", plan: "fine (4 units)", slots: 1, spec: "fine.spec.json" },
  { arm: "C", plan: "fine (4 units)", slots: 2, spec: "fine.spec.json" },
] as const;
const specs = new Map<string, SpecFile>(
  [...new Set(ARMS.map((arm) => arm.spec))].map((name) => [name, read(name)]),
);

const schedule = shuffled(
  ARMS.flatMap((arm, index) =>
    Array.from({ length: reps[index]! }, (_, rep) => ({ ...arm, rep: rep + 1 })),
  ),
  seed,
);

interface Recorded {
  arm: string;
  plan: string;
  rep: number;
  slotsRequested: number;
  slotsUsed: number;
  slotRefusal?: string;
  wallMs: number;
  hostMs: number;
  tokens: number;
  units: number;
  accepted: number;
  parent?: string;
  verdicts: Record<string, number>;
  incomplete: readonly string[];
}

const recorded: Recorded[] = [];
let recordedProvider = provider;
let recordedModel = model;
let recordedFamily = family;
if (reportOnly) {
  const previous = reportOnly.map(
    (file) =>
      JSON.parse(readFileSync(file, "utf8")) as {
        provider: string;
        model: string;
        family: string;
        limits: unknown;
        runs: Recorded[];
      },
  );
  const first = previous[0]!;
  for (const [index, file] of reportOnly.entries()) {
    const one = previous[index]!;
    if (
      one.provider !== first.provider ||
      one.model !== first.model ||
      one.family !== first.family ||
      JSON.stringify(one.limits) !== JSON.stringify(first.limits)
    )
      throw new Error(
        `${file}: recorded by ${one.provider}/${one.model} on ${one.family} with other limits, ` +
          `while ${reportOnly[0]} used ${first.provider}/${first.model}; merging them would put two ` +
          "instruments in one table",
      );
    recorded.push(...one.runs);
  }
  if (!recorded.length) throw new Error("the result files hold no runs");
  if (values["family"] !== undefined && values["family"] !== first.family)
    throw new Error(
      `--family ${values["family"]} does not match the recorded family ${first.family}`,
    );
  recordedProvider = first.provider;
  recordedModel = first.model;
  recordedFamily = first.family;
} else await runArms();

/** The per-arm view of a set of runs. Kept separate from the running so the same aggregation can be
 *  re-derived from runs that were recorded in more than one sitting - the evidence is the runs, and
 *  an aggregate that cannot be recomputed from them is not evidence. */
function aggregate(runs: readonly Recorded[], planned: readonly number[]) {
  return ARMS.map((arm, index) => {
    const own = runs.filter((entry) => entry.arm === arm.arm);
    const wall = own.map((entry) => entry.wallMs).sort((left, right) => left - right);
    return {
      arm: arm.arm,
      plan: arm.plan,
      slots: arm.slots,
      planned: planned[index] ?? own.length,
      runs: own.length,
      acceptedUnits: own.map((entry) => entry.accepted),
      parents: own.map((entry) => entry.parent ?? null),
      slotsUsed: own.map((entry) => entry.slotsUsed),
      completeRuns: own.filter((entry) => entry.incomplete.length === 0).length,
      wallMsTotal: wall.reduce((sum, ms) => sum + ms, 0),
      wallMsMedian: wall.length ? wall[Math.floor(wall.length / 2)]! : null,
      hostMsTotal: own.reduce((sum, entry) => sum + entry.hostMs, 0),
      tokensTotal: own.reduce((sum, entry) => sum + entry.tokens, 0),
      unitsTotal: own.reduce((sum, entry) => sum + entry.units, 0),
      failures: own.flatMap((entry) => entry.incomplete),
    };
  });
}

const report = {
  measuredAt: new Date().toISOString(),
  provider: recordedProvider,
  model: recordedModel,
  family: recordedFamily,
  limits: PILOT_LIMITS,
  reps: reportOnly ? [] : reps,
  seed,
  order: schedule.map((step) => `${step.arm}${step.rep}`),
  mergedFrom: reportOnly,
  arms: aggregate(recorded, reportOnly ? [] : reps),
  runs: recorded,
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
for (const arm of report.arms)
  process.stdout.write(
    `${arm.arm} ${arm.plan} @${arm.slots}: ${arm.runs} runs (${arm.completeRuns} complete), ` +
      `accepted ${arm.acceptedUnits.join("/")}, parents ${arm.parents.join("/")}, ` +
      `wall ${arm.wallMsTotal}ms (median ${String(arm.wallMsMedian)}), host ${arm.hostMsTotal}ms, ` +
      `tokens ${arm.tokensTotal}, slots used ${arm.slotsUsed.join("/")}\n`,
  );
process.stdout.write(`results: ${out}${reportOnly ? "" : `\nper-run: ${runsDir}`}\n`);

async function runArms(): Promise<void> {
  for (const [index, step] of schedule.entries()) {
  process.stdout.write(
    `[${index + 1}/${schedule.length}] arm ${step.arm} rep ${step.rep} (${step.plan}, ` +
      `${step.slots} slot${step.slots === 1 ? "" : "s"})\n`,
  );
  const startedAt = Date.now();
  const run = await runPlan(
    specFrom(specs.get(step.spec)!, piWorker({ provider, model }, true), step.slots),
  );
  const verdicts: Record<string, number> = {};
  for (const unit of run.units) verdicts[unit.verdict] = (verdicts[unit.verdict] ?? 0) + 1;
  const one: Recorded = {
    arm: step.arm,
    plan: step.plan,
    rep: step.rep,
    slotsRequested: run.slotsRequested,
    slotsUsed: run.slotsUsed,
    ...(run.slotRefusal ? { slotRefusal: run.slotRefusal } : {}),
    wallMs: run.wallMs,
    hostMs: run.hostMs,
    tokens: run.tokens,
    units: run.units.length,
    accepted: Object.keys(run.accepted).length,
    ...(run.parent ? { parent: run.parent.verdict } : {}),
    verdicts,
    incomplete: run.incomplete,
  };
  recorded.push(one);
  writeFileSync(
    resolve(runsDir, `${step.arm}-${step.rep}-${startedAt}.json`),
    `${JSON.stringify(one, null, 2)}\n`,
  );
  process.stdout.write(
    `  wall ${one.wallMs}ms, host ${one.hostMs}ms, tokens ${one.tokens}, slots ${one.slotsUsed}/` +
      `${one.slotsRequested}, verdicts ${JSON.stringify(verdicts)}, parent ${String(one.parent)}` +
      `${one.incomplete.length ? `, incomplete ${JSON.stringify(one.incomplete)}` : ""}\n`,
  );
  }
  if (recorded.length !== reps.reduce((sum, count) => sum + count, 0))
    throw new Error(`planned ${reps.join("+")} runs and recorded ${recorded.length}`);
}

