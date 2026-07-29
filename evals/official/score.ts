import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
  beamEventAlignmentPrompt,
  beamJudgePrompt,
  normalizedKendallTauB,
  personaMemCorrect,
} from "./protocol.ts";
import { buildSnapshot, writeSnapshot } from "./snapshot.ts";

type Benchmark = "beam" | "locomo" | "personamem";
interface Prediction {
  id: string;
  mode: string;
  category: string;
  question: string;
  reference: string;
  hypothesis: string;
  rubric?: string[];
  evidenceIds?: string[];
  retrievedEvidenceIds?: string[] | null;
  officialMetadata: Record<string, unknown>;
}

const root = resolve(import.meta.dirname, "../..");
const benchmark = parseBenchmark(process.argv[2]);
const runDirectory = resolve(process.argv[3] ?? "");
const report = JSON.parse(readFileSync(resolve(runDirectory, "report.json"), "utf8")) as {
  results: Prediction[];
  codeRevision?: string | null;
  sampleFingerprint?: string | null;
  benchmarkParameters?: unknown;
};
const scored =
  benchmark === "locomo"
    ? scoreLocomo(report.results)
    : benchmark === "personamem"
      ? scorePersonaMem(report.results)
      : await scoreBeam(report.results);
const output = {
  benchmark,
  protocol:
    benchmark === "beam" ? "official-protocol/deepseek-judge" : "official-protocol/deterministic",
  judgeModel: benchmark === "beam" ? "deepseek/deepseek-v4-flash" : null,
  leaderboardComparable: false,
  upstream: upstreamInfo(benchmark),
  ...summarize(scored),
  results: scored,
};
writeFileSync(resolve(runDirectory, "official-score.json"), `${JSON.stringify(output, null, 2)}\n`);
const snapshotPath = writeSnapshot(
  root,
  buildSnapshot({
    benchmark,
    protocol: output.protocol,
    judgeModel: output.judgeModel,
    upstream: output.upstream,
    byMode: output.byMode,
    codeRevision: report.codeRevision ?? null,
    sampleFingerprint: report.sampleFingerprint ?? null,
    parameters: report.benchmarkParameters ?? null,
  }),
);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.stderr.write(`snapshot: ${snapshotPath}\n`);

function scorePersonaMem(rows: Prediction[]) {
  return rows.map((row) => ({
    ...row,
    officialScore: personaMemCorrect(row.hypothesis, row.reference) ? 1 : 0,
  }));
}

function scoreLocomo(rows: Prediction[]) {
  const qas = rows.map((row) => ({
    answer: row.reference,
    category: Number(row.officialMetadata.category ?? row.category),
    evidence: row.evidenceIds ?? [],
    prediction: row.hypothesis,
    prediction_context: row.retrievedEvidenceIds ?? [],
  }));
  const python = resolve(root, ".benchmarks", "python", "Scripts", "python.exe");
  const bridge = resolve(import.meta.dirname, "locomo_score.py");
  const result = spawnSync(python, [bridge], {
    cwd: root,
    input: JSON.stringify({ qas }),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `LoCoMo official scorer failed. Run npm run benchmark:setup first.\n${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("\n{") + 1)) as {
    scores: number[];
    recalls: number[];
  };
  return rows.map((row, index) => ({
    ...row,
    officialScore: parsed.scores[index],
    retrievalRecall: row.retrievedEvidenceIds === null ? null : parsed.recalls[index],
  }));
}

async function scoreBeam(rows: Prediction[]) {
  const output = [];
  for (const row of rows) {
    const rubric = row.rubric ?? [];
    if (row.category === "event_ordering") {
      const candidateOrder = await alignBeamEvents(row, rubric);
      const tauNorm = normalizedKendallTauB(
        rubric.map((_, index) => index),
        candidateOrder,
      );
      output.push({
        ...row,
        officialScore: tauNorm,
        tauNorm,
        candidateOrder,
      });
      continue;
    }
    const scores = [];
    for (const item of rubric) scores.push(await judgeBeamRubric(row, item));
    output.push({
      ...row,
      officialScore:
        scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
      rubricScores: scores,
    });
  }
  return output;
}

async function alignBeamEvents(row: Prediction, rubric: string[]): Promise<number[]> {
  if (rubric.length === 0) return [];
  const systemItems = row.hypothesis
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (systemItems.length === 0) return [];
  const text = await runJudge(beamEventAlignmentPrompt(row.question, rubric, systemItems));
  const match = text.match(/\[[\s\S]*?\]/u);
  if (!match) throw new Error(`BEAM event-ordering judge returned invalid JSON: ${text}`);
  const parsed: unknown = JSON.parse(match[0]);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== systemItems.length ||
    !parsed.every(isEventAlignment)
  ) {
    throw new Error(`BEAM event-ordering judge returned invalid alignment: ${text}`);
  }
  let nextExtra = rubric.length;
  const usedReferences = new Set<number>();
  return parsed.map((item) => {
    const index = item.referenceIndex;
    if (index !== null && index >= 0 && index < rubric.length && !usedReferences.has(index)) {
      usedReferences.add(index);
      return index;
    }
    const extra = nextExtra;
    nextExtra += 1;
    return extra;
  });
}

function isEventAlignment(
  value: unknown,
): value is { referenceIndex: number | null; item: string } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.referenceIndex === null || Number.isInteger(item.referenceIndex)) &&
    typeof item.item === "string"
  );
}

async function judgeBeamRubric(row: Prediction, rubric: string): Promise<number> {
  const text = await runJudge(beamJudgePrompt(row.question, rubric, row.hypothesis));
  const match = text.match(/"score"\s*:\s*(1(?:\.0)?|0\.5|0(?:\.0)?)/u);
  if (!match) throw new Error(`BEAM judge returned invalid JSON: ${text}`);
  return Number(match[1]);
}

async function runJudge(prompt: string): Promise<string> {
  const client = createJudgeClient();
  try {
    await client.start();
    await client.setThinkingLevel("low");
    await client.promptAndWait(prompt, undefined, 300_000);
    return (await client.getLastAssistantText()) ?? "";
  } finally {
    await client.stop();
  }
}

function summarize<T extends Prediction & { officialScore: number }>(rows: T[]) {
  const byMode = Object.fromEntries(
    [...new Set(rows.map((row) => row.mode))].map((mode) => {
      const selected = rows.filter((row) => row.mode === mode);
      return [
        mode,
        {
          score: selected.reduce((sum, row) => sum + row.officialScore, 0) / selected.length,
          count: selected.length,
          byCategory: Object.fromEntries(
            [...new Set(selected.map((row) => row.category))].map((category) => {
              const categoryRows = selected.filter((row) => row.category === category);
              return [
                category,
                categoryRows.reduce((sum, row) => sum + row.officialScore, 0) / categoryRows.length,
              ];
            }),
          ),
        },
      ];
    }),
  );
  return { byMode };
}

function createJudgeClient(): RpcClient {
  return new RpcClient({
    cliPath: resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    cwd: root,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    args: [
      "--offline",
      "--approve",
      "--no-session",
      "--no-extensions",
      "--tools",
      "read",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--thinking",
      "off",
    ],
  });
}

function upstreamInfo(value: Benchmark) {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "upstreams.json"), "utf8"));
  const key = value === "beam" ? "BEAM" : value === "locomo" ? "LoCoMo" : "PersonaMem";
  return manifest[key];
}

function parseBenchmark(value: string | undefined): Benchmark {
  if (value === "beam" || value === "locomo" || value === "personamem") return value;
  throw new Error("Benchmark must be beam, locomo, or personamem");
}
