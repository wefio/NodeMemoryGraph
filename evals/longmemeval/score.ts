import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";

import { longMemEvalJudgePrompt } from "./official.ts";
import { buildSnapshot, writeSnapshot } from "../official/snapshot.ts";

interface Row {
  questionId: string;
  questionType: string;
  question: string;
  reference: string;
  hypothesis: string;
  mode: string;
}

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(process.argv[2] ?? "");
const report = JSON.parse(readFileSync(resolve(directory, "report.json"), "utf8")) as {
  results: Row[];
  codeRevision?: string | null;
  sampleFingerprint?: string | null;
};
const rows = [];
for (const row of report.results) {
  rows.push({ ...row, officialScore: await judge(row) });
}
const byMode = Object.fromEntries([...new Set(rows.map((row) => row.mode))].map((mode) => {
  const selected = rows.filter((row) => row.mode === mode);
  return [mode, {
    accuracy: selected.filter((row) => row.officialScore === 1).length / selected.length,
    total: selected.length,
  }];
}));
const output = {
  benchmark: "longmemeval",
  protocol: "official-protocol/deepseek-judge",
  judgeModel: "deepseek/deepseek-v4-flash",
  leaderboardComparable: false,
  upstream: JSON.parse(readFileSync(
    resolve(root, "evals/official/upstreams.json"), "utf8",
  )).LongMemEval,
  byMode,
  results: rows,
};
writeFileSync(resolve(directory, "official-score.json"), `${JSON.stringify(output, null, 2)}\n`);
const snapshotPath = writeSnapshot(root, buildSnapshot({
  benchmark: output.benchmark,
  protocol: output.protocol,
  judgeModel: output.judgeModel,
  upstream: output.upstream,
  byMode: output.byMode,
  codeRevision: report.codeRevision ?? null,
  sampleFingerprint: report.sampleFingerprint ?? null,
}));
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.stderr.write(`snapshot: ${snapshotPath}\n`);

async function judge(row: Row): Promise<number> {
  const client = new RpcClient({
    cliPath: resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    cwd: root,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: Object.fromEntries(Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    )),
    args: ["--offline", "--approve", "--no-session", "--no-extensions", "--tools", "read",
      "--model", "deepseek/deepseek-v4-flash", "--thinking", "off"],
  });
  try {
    await client.start();
    await client.setThinkingLevel("low");
    await client.promptAndWait(longMemEvalJudgePrompt(
      row.questionType, row.question, row.reference, row.hypothesis,
      row.questionId.includes("_abs"),
    ), undefined, 300_000);
    const response = ((await client.getLastAssistantText()) ?? "").trim().toLocaleLowerCase();
    if (/^yes\b/u.test(response)) return 1;
    if (/^no\b/u.test(response)) return 0;
    throw new Error(`LongMemEval judge returned neither yes nor no: ${response}`);
  } finally {
    await client.stop();
  }
}
