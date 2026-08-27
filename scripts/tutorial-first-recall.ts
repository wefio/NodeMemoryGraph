import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCli } from "../src/cli/main.ts";
import type { CompactSearchContext } from "../src/integration/search-projection.ts";

const nonInteractive = process.argv.includes("--non-interactive") || !process.stdin.isTTY;
const dataDirectory = mkdtempSync(join(tmpdir(), "nmg-first-recall-"));
const statement = "The user prefers concise technical answers.";

interface RememberResult {
  memory: { id: string; statement: string };
}

interface GetResult {
  results: Array<{ memory: { id: string; statement: string } }>;
}

async function invoke<T>(args: string[]): Promise<T> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--data-dir", dataDirectory], {
    stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
    stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
  });
  if (code !== 0) throw new Error(stderr.trim() || `nmg ${args.join(" ")} failed`);
  return JSON.parse(stdout) as T;
}

async function pause(): Promise<void> {
  if (nonInteractive) return;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  await prompt.question("Press Enter to continue... ");
  prompt.close();
}

function showCommand(args: string[]): void {
  console.log(`$ nmg ${args.join(" ")}`);
}

async function main(): Promise<void> {
  console.log("NMG first-recall tutorial");
  console.log(`Temporary store: ${dataDirectory}`);
  console.log("This walkthrough uses a private temporary SQLite store and no daemon.\n");

  console.log("Step 1/4: inspect an empty isolated store");
  const statusArgs = ["status", "--json"];
  showCommand(statusArgs);
  const status = await invoke<{ storage: { exists: boolean; loaded: boolean } }>(statusArgs);
  console.log(`Store exists: ${status.storage.exists}; loaded: ${status.storage.loaded}\n`);
  await pause();

  console.log("Step 2/4: remember one durable preference");
  const rememberArgs = [
    "remember",
    statement,
    "--node",
    "Response preferences",
    "--type",
    "preference",
    "--scope",
    "user=local",
    "--write-reason",
    "first-recall tutorial",
    "--json",
  ];
  showCommand(rememberArgs);
  const remembered = await invoke<RememberResult>(rememberArgs);
  console.log(`Saved memory: ${remembered.memory.id}\n`);
  await pause();

  console.log("Step 3/4: search compact headers");
  const searchArgs = [
    "search",
    "How should answers be written?",
    "--scope",
    "user=local",
    "--compact-json",
    "--no-perf",
  ];
  showCommand(searchArgs);
  const searched = await invoke<CompactSearchContext>(searchArgs);
  const candidate = searched.candidates.find((entry) => entry.id === remembered.memory.id);
  if (!candidate || !searched.activeGraphId) {
    throw new Error("the saved memory was not returned with an Active Graph");
  }
  console.log(`Candidate header: ${candidate.id} — ${candidate.preview}`);
  console.log(`Active Graph: ${searched.activeGraphId}\n`);
  await pause();

  console.log("Step 4/4: load exact evidence through the Active Graph");
  const getArgs = [
    "get",
    candidate.id,
    "--active-graph-id",
    searched.activeGraphId,
    "--json",
  ];
  showCommand(getArgs);
  const exact = await invoke<GetResult>(getArgs);
  const exactStatement = exact.results[0]?.memory.statement;
  if (exactStatement !== statement) throw new Error("exact evidence did not match the saved statement");
  console.log(`Exact evidence: ${exactStatement}`);
  console.log("\nThe header guided recall; get disclosed the lossless record and attributed that disclosure.");
}

try {
  await main();
} finally {
  rmSync(dataDirectory, { recursive: true, force: true });
  console.log("Tutorial complete; temporary data removed.");
}
