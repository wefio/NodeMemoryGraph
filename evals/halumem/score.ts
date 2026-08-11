import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { benchmarkCredentialEnvironment } from "../local-env.ts";

const root = resolve(import.meta.dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const python = resolve(
  args.python ??
    process.env.NMG_HALUMEM_PYTHON ??
    resolve(root, ".benchmarks/omni-venv/Scripts/python.exe"),
);
if (!existsSync(python)) throw new Error(`HaluMem Python environment not found: ${python}`);

const credentials = benchmarkCredentialEnvironment(root);
const apiKey = process.env.DEEPSEEK_API_KEY ?? credentials.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for the official HaluMem judge");

const input = resolve(
  args.input ?? resolve(root, ".benchmarks/halumem-nmg/results/nmg_eval_results.jsonl"),
);
const output = resolve(
  args.output ?? resolve(root, ".benchmarks/halumem-nmg/results/nmg_eval_stat_result.json"),
);
const upstream = resolve(args.upstream ?? resolve(root, ".benchmarks/official/HaluMem"));
const result = spawnSync(
  python,
  [
    resolve(import.meta.dirname, "score.py"),
    "--input",
    input,
    "--output",
    output,
    "--upstream",
    upstream,
    "--users",
    args.users ?? "1",
    "--workers",
    args.workers ?? "4",
  ],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com",
      OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: process.env.OPENAI_MODEL ?? "deepseek-chat",
      OPENAI_MAX_TOKENS: process.env.OPENAI_MAX_TOKENS ?? "1024",
      OPENAI_TEMPERATURE: process.env.OPENAI_TEMPERATURE ?? "0",
      OPENAI_TIMEOUT: process.env.OPENAI_TIMEOUT ?? "90",
      RETRY_TIMES: process.env.RETRY_TIMES ?? "3",
      WAIT_TIME_LOWER: process.env.WAIT_TIME_LOWER ?? "1",
      WAIT_TIME_UPPER: process.env.WAIT_TIME_UPPER ?? "10",
    },
  },
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(
    `HaluMem scorer exited with status=${String(result.status)} signal=${String(result.signal)}\n`,
  );
  process.exitCode = result.status ?? 1;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument near ${key ?? "end"}`);
    result[key.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return result;
}
