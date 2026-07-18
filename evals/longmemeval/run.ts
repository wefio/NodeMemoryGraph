import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";

type Role = "assistant" | "user";

interface Turn {
  role: Role;
  content: string;
}

interface LongMemExample {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: Turn[][];
}

type Mode = "nmg-oracle" | "no-memory" | "oracle";

const root = resolve(import.meta.dirname, "../..");
const dataDirectory = resolve(import.meta.dirname, "data");
const mode = parseMode(process.argv[2]);
const perType = positiveInteger(process.argv[3] ?? "1");
const sourceFile = mode === "oracle" || mode === "nmg-oracle"
  ? "longmemeval_oracle.json"
  : "longmemeval_s_cleaned.json";
const examples = JSON.parse(
  readFileSync(resolve(dataDirectory, sourceFile), "utf8"),
) as LongMemExample[];
const canonicalExamples = JSON.parse(
  readFileSync(
    resolve(dataDirectory, "longmemeval_s_cleaned.json"),
    "utf8",
  ),
) as LongMemExample[];
const selectedIds = stratifiedSample(canonicalExamples, perType)
  .map((example) => example.question_id);
const examplesById = new Map(
  examples.map((example) => [example.question_id, example]),
);
const selectedSample = selectedIds.map((id) => {
  const example = examplesById.get(id);
  if (!example) throw new Error(`${sourceFile} is missing question ${id}`);
  return example;
});
const sample = process.env.NMG_LONGMEM_QUESTION
  ? selectedSample.filter((example) => example.question_id === process.env.NMG_LONGMEM_QUESTION)
  : selectedSample;
if (sample.length === 0) {
  throw new Error("NMG_LONGMEM_QUESTION did not match the selected sample");
}
const runId = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = resolve(import.meta.dirname, "results", runId);
mkdirSync(outputDirectory, { recursive: true });

const results = await Promise.all(sample.map(runExample));
const report = {
  runId,
  mode,
  model: "deepseek/deepseek-v4-flash",
  sampleSize: results.length,
  passed: results.filter((result) => result.passed).length,
  accuracy: results.filter((result) => result.passed).length / results.length,
  results,
};

writeFileSync(
  resolve(outputDirectory, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function runExample(example: LongMemExample) {
  const startedAt = performance.now();
  const nmgDirectory = resolve(outputDirectory, "nmg", example.question_id);
  let remembered = 0;
  if (mode === "nmg-oracle") {
    mkdirSync(nmgDirectory, { recursive: true });
    remembered = await ingestEvidence(example, nmgDirectory);
  }

  const answerClient = createClient(
    mode === "nmg-oracle" ? nmgDirectory : undefined,
  );
  let hypothesis = "";
  try {
    await answerClient.start();
    await answerClient.setThinkingLevel("low");
    await answerClient.promptAndWait(answerPrompt(example), undefined, 180_000);
    hypothesis = (await answerClient.getLastAssistantText())?.trim() ?? "";
  } finally {
    await answerClient.stop();
  }

  const judgement = await judgeAnswer(example, hypothesis);

  return {
    questionId: example.question_id,
    questionType: benchmarkType(example),
    question: example.question,
    reference: example.answer,
    hypothesis,
    judgement,
    passed: judgementPassed(judgement),
    remembered,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function ingestEvidence(
  example: LongMemExample,
  nmgDirectory: string,
): Promise<number> {
  let remembered = 0;
  for (let index = 0; index < example.haystack_sessions.length; index += 1) {
    const client = createClient(nmgDirectory);
    try {
      await client.start();
      await client.setThinkingLevel("low");
      const events = await client.promptAndWait(
        ingestionPrompt(
          example.haystack_sessions[index],
          example.haystack_dates[index] ?? "unknown date",
        ),
        undefined,
        180_000,
      );
      remembered += events.filter(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "nmg_remember" &&
          !event.isError,
      ).length;
    } finally {
      await client.stop();
    }
  }
  return remembered;
}

async function judgeAnswer(
  example: LongMemExample,
  hypothesis: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = createClient();
    try {
      await client.start();
      await client.setThinkingLevel("low");
      await client.promptAndWait(
        judgePrompt(example, hypothesis),
        undefined,
        180_000,
      );
      const judgement = (await client.getLastAssistantText())?.trim() ?? "";
      if (judgement) return judgement;
    } finally {
      await client.stop();
    }
  }
  return "FAIL - Judge returned no response after two attempts.";
}

function answerPrompt(example: LongMemExample): string {
  const history = mode === "oracle"
    ? `\nRelevant conversation history:\n${formatHistory(example)}\n`
    : "\nNo conversation history is available.\n";
  return [
    "Answer the question concisely using only information available to you.",
    "If the requested past information is unavailable, say that you do not know.",
    "For a recommendation question, use remembered preferences to generate useful",
    "new recommendations. The exact recommended resources need not have appeared",
    "in the past conversation; do not confuse preference recall with item recall.",
    history,
    `Question date: ${example.question_date}`,
    `Question: ${example.question}`,
  ].join("\n");
}

function ingestionPrompt(session: Turn[], date: string): string {
  return [
    "The following is a past conversation session being imported into NMG.",
    "Use nmg_remember as many times as needed to preserve durable user facts,",
    "preferences, constraints, timestamped events, updates, and useful assistant",
    "statements. Assistant statements are conversational evidence, not verified truth.",
    "Store separately countable entities and pending actions as separate memories.",
    "For example, an item to return and its replacement to pick up are two actions.",
    "For each user-stated memory, pass evidence as the shortest exact quote from",
    "the user turn that supports it; do not replace evidence with a paraphrase.",
    "Preserve the date and narrow scope. Do not answer the conversation itself.",
    `Session date: ${date}`,
    session.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
    "After all useful memories are stored, answer only INGESTED.",
  ].join("\n");
}

function judgePrompt(example: LongMemExample, hypothesis: string): string {
  return [
    "Judge whether the candidate answer is semantically correct given the reference.",
    "Accept concise paraphrases and equivalent answers.",
    "Treat the reference answer as authoritative. If it contains a concrete answer,",
    "a candidate saying unknown or unavailable MUST fail. Only accept unknown when",
    "the reference itself explicitly says the information was never provided.",
    "Respond with exactly PASS or FAIL followed by one short reason.",
    `Question: ${example.question}`,
    `Reference answer: ${example.answer}`,
    `Candidate answer: ${hypothesis}`,
  ].join("\n");
}

function judgementPassed(judgement: string): boolean {
  const verdicts = judgement.split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(PASS|FAIL)\b/i);
    return match ? [match[1]!.toUpperCase()] : [];
  });
  return verdicts.at(-1) === "PASS";
}

function formatHistory(example: LongMemExample): string {
  return example.haystack_sessions.map((session, index) => {
    const turns = session
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n");
    return `[${example.haystack_dates[index] ?? "unknown date"}]\n${turns}`;
  }).join("\n\n");
}

function stratifiedSample(
  examples: LongMemExample[],
  count: number,
): LongMemExample[] {
  const grouped = new Map<string, LongMemExample[]>();
  for (const example of examples) {
    const type = benchmarkType(example);
    const group = grouped.get(type) ?? [];
    group.push(example);
    grouped.set(type, group);
  }
  return [...grouped.keys()].sort().flatMap(
    (type) => grouped.get(type)!.slice(0, count),
  );
}

function benchmarkType(example: LongMemExample): string {
  return example.question_id.endsWith("_abs")
    ? "abstention"
    : example.question_type;
}

function createClient(nmgDirectory?: string): RpcClient {
  return new RpcClient({
    cliPath: resolve(
      root,
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
    cwd: root,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: {
      ...definedEnvironment(),
      ...(nmgDirectory ? { NMG_DATA_DIR: nmgDirectory } : {}),
    },
    args: [
      "--offline",
      "--approve",
      "--no-session",
      ...(nmgDirectory
        ? ["--extension", resolve(root, ".pi/extensions/nmg/index.ts")]
        : []),
    ],
  });
}

function parseMode(value: string | undefined): Mode {
  if (value === undefined || value === "no-memory") return "no-memory";
  if (value === "oracle") return "oracle";
  if (value === "nmg-oracle") return "nmg-oracle";
  throw new Error(
    `Unknown mode: ${value}. Use no-memory, oracle, or nmg-oracle.`,
  );
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive sample count, received: ${value}`);
  }
  return parsed;
}

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
