// Which tests in a layer answer differently on the same code?
//
// A flaky test is worse than a missing one: it teaches everyone to re-run until green, which
// also hides the real failures that arrive alongside it. The only way to know is to run the
// same suite several times and compare per-test outcomes, so this does exactly that.
//
// Each run writes a JUnit report; a case that fails in some runs but not all is flaky, a case
// that fails in every run is broken, and the rest are stable. Layers run through the same
// arguments as `tools/test-layers.ts`, so the unit layer is measured under its seal.
//
//   --layer <name>   repeatable; defaults to every layer
//   --runs <n>       repetitions per layer; defaults to 3
//   --json           print the observations instead of the table
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { LAYERS, partitionTests, testArgs, type TestLayer } from "./test-layers.ts";

interface Observation {
  file: string;
  name: string;
  failed: boolean;
}

interface Tally {
  file: string;
  name: string;
  runs: number;
  failed: number;
}

/** Where JUnit reports land; `coverage/` is already ignored by git. */
const REPORT_ROOT = "coverage/flake";

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

function unescape(value: string): string {
  return value.replace(/&(?:quot|apos|lt|gt|amp);/g, (match) => ENTITIES[match]);
}

function attribute(element: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(element);
  return match ? unescape(match[1]) : "";
}

/**
 * One `<testcase>` per case, with a `<failure>` or `<error>` child when it did not pass. The
 * reporter writes a flat list, so a small scanner is enough and avoids an XML dependency.
 */
export function parseJunit(xml: string): Observation[] {
  const observations: Observation[] = [];
  for (const chunk of xml.split("<testcase ").slice(1)) {
    const open = chunk.slice(0, chunk.indexOf(">") + 1);
    const selfClosing = open.endsWith("/>");
    const body = selfClosing ? "" : chunk.slice(open.length, chunk.indexOf("</testcase>"));
    const file = attribute(open, "file").split("\\").join("/");
    const name = attribute(open, "name");
    if (!file || !name) continue;
    const at = file.indexOf("tests/");
    observations.push({
      file: at >= 0 ? file.slice(at) : file,
      name,
      failed: /<(?:failure|error)\b/.test(body),
    });
  }
  return observations;
}

function tally(observations: Observation[]): Map<string, Tally> {
  const counts = new Map<string, Tally>();
  for (const observation of observations) {
    const key = `${observation.file}\u0000${observation.name}`;
    const current = counts.get(key) ?? {
      file: observation.file,
      name: observation.name,
      runs: 0,
      failed: 0,
    };
    current.runs += 1;
    if (observation.failed) current.failed += 1;
    counts.set(key, current);
  }
  return counts;
}

function runOnce(root: string, layer: TestLayer, run: number): Promise<Observation[]> {
  const directory = join(root, REPORT_ROOT);
  mkdirSync(directory, { recursive: true });
  const report = join(directory, `${layer}-${run}.xml`);
  const files = partitionTests(root).get(layer)!.files;
  // The reporter flags have to precede the file arguments, or Node keeps the default reporter.
  const args = testArgs(
    layer,
    ["--test-reporter=junit", `--test-reporter-destination=${report}`],
    files,
  );
  const child = spawn(process.execPath, args, { cwd: root, stdio: "ignore" });
  return new Promise((done) => {
    child.on("close", () => {
      const xml = readFileSync(report, "utf8");
      rmSync(report, { force: true });
      done(parseJunit(xml));
    });
  });
}

function parseArgs(argv: string[]): { layers: TestLayer[]; runs: number; json: boolean } {
  const layers: TestLayer[] = [];
  let runs = 3;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--layer") {
      const value = argv[index + 1] as TestLayer;
      if (!LAYERS.includes(value)) throw new Error(`--layer needs one of: ${LAYERS.join(", ")}`);
      layers.push(value);
      index += 1;
    } else if (flag === "--runs") {
      runs = Number(argv[index + 1]);
      if (!Number.isInteger(runs) || runs < 2)
        throw new Error("--runs needs an integer of 2 or more");
      index += 1;
    } else if (flag === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return { layers: layers.length > 0 ? layers : [...LAYERS], runs, json };
}

function report(layer: TestLayer, counts: Map<string, Tally>, runs: number): number {
  const all = [...counts.values()];
  const flaky = all.filter((tally) => tally.failed > 0 && tally.failed < tally.runs);
  const broken = all.filter((tally) => tally.failed === tally.runs);
  console.log(
    `${layer.padEnd(12)} runs ${runs}  tests ${String(all.length).padStart(4)}  ` +
      `flaky ${String(flaky.length).padStart(3)}  broken ${String(broken.length).padStart(2)}`,
  );
  for (const tally of [...broken, ...flaky].slice(0, 15)) {
    console.log(
      `    ${String(tally.failed).padStart(2)}/${tally.runs}  ${tally.file}  ::  ${tally.name}`,
    );
  }
  if (broken.length + flaky.length > 15)
    console.log(`    ... ${broken.length + flaky.length - 15} more`);
  return broken.length;
}

async function main(argv: string[]): Promise<number> {
  const root = resolve(process.cwd());
  const { layers, runs, json } = parseArgs(argv);
  let broken = 0;
  for (const layer of layers) {
    const observations: Observation[] = [];
    for (let run = 1; run <= runs; run += 1)
      observations.push(...(await runOnce(root, layer, run)));
    const counts = tally(observations);
    if (json) {
      console.log(
        JSON.stringify(
          [...counts.values()].filter((tally) => tally.failed > 0),
          null,
          2,
        ),
      );
      continue;
    }
    broken += report(layer, counts, runs);
  }
  if (json) return 0;
  // A deterministic failure is already visible in the suite; this run adds flakiness to the
  // picture, and a layer that never passed is not a flake finding.
  return broken > 0 ? 1 : 0;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tools/test-flake.ts")) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
