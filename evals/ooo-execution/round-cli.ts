// S3 entry point: submit / status / cancel a round from a spec file.
//
//   node --experimental-strip-types evals/ooo-execution/round-cli.ts submit <spec.json> --run-dir <dir>
//   node --experimental-strip-types evals/ooo-execution/round-cli.ts status --run-dir <dir>
//   node --experimental-strip-types evals/ooo-execution/round-cli.ts cancel --run-dir <dir> --reason <text>
//
// `submit` runs in the foreground and reports what it did. `status` and `cancel` read or write
// the round's own durable state, so they work from other processes and across restarts — which
// is the point of the stage: a supported round is repeated without editing a research script.
import { readFileSync } from "node:fs";
import { parseRoundSpec } from "./round-spec.ts";
import {
  cancelRun,
  describeRun,
  readBaseline,
  runSpecifiedRound,
  specWorker,
} from "./round-runner.ts";

const USAGE = `usage:
  round-cli.ts submit <spec.json> --run-dir <dir> [--live]
  round-cli.ts status --run-dir <dir>
  round-cli.ts cancel --run-dir <dir> --reason <text>`;

/** A tiny flag reader: unknown flags are refused rather than ignored. */
function flags(argv: readonly string[], allowed: readonly string[]) {
  const values: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.includes(name)) throw new Error(`unknown flag: ${token}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) values[name] = true;
    else {
      values[name] = next;
      index += 1;
    }
  }
  return values;
}

function required(values: Record<string, string | true>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

async function submit(argv: readonly string[], repository: string) {
  const [specPath, ...rest] = argv;
  if (!specPath || specPath.startsWith("--")) throw new Error(USAGE);
  const values = flags(rest, ["run-dir", "live"]);
  const runDir = required(values, "run-dir");
  const spec = parseRoundSpec(JSON.parse(readFileSync(specPath, "utf8")));
  const { revision, baseline } = readBaseline(spec, repository);
  const worker = await specWorker(
    spec,
    { repository, revision, baseline },
    {
      spec,
      live: values.live === true,
    },
  );
  console.log(`submitting ${specPath} into ${runDir} (worker ${spec.worker.kind})`);
  const result = await runSpecifiedRound({ spec, runDir, repository, worker, revision, baseline });
  console.log(describeRun(runDir));
  console.log(
    `verdicts: ${JSON.stringify(result.verdicts)} accepted: ${JSON.stringify(result.accepted)}`,
  );
  // A round that accepted nothing, or was cancelled, is not a success exit.
  const accepted = Object.keys(result.accepted).length;
  if (result.cancelled || !accepted) process.exitCode = 1;
}

function status(argv: readonly string[]) {
  const values = flags(argv, ["run-dir"]);
  console.log(describeRun(required(values, "run-dir")));
}

function cancel(argv: readonly string[]) {
  const values = flags(argv, ["run-dir", "reason"]);
  const reason = required(values, "reason");
  const stored = cancelRun(required(values, "run-dir"), reason);
  console.log(`cancellation recorded: ${stored}`);
}

const [command, ...rest] = process.argv.slice(2);
const repository = process.cwd();
try {
  if (command === "submit") await submit(rest, repository);
  else if (command === "status") status(rest);
  else if (command === "cancel") cancel(rest);
  else throw new Error(USAGE);
} catch (error) {
  console.error(`round-cli: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
