import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  RECALL_LABELS,
  applyRecallLabels,
  appendRecallLabel,
  readRecallInstances,
  readRecallLabels,
  recallInstancesPath,
  recallLabelsPath,
  summarizeLabels,
  type RecallInstance,
  type RecallLabel,
} from "../src/lab/recall-instance.ts";

/**
 * Offline judge for the self-contained recall-instance corpus.
 *
 * Each instance is judged on RETRIEVAL relevance only — is the retrieval
 * on-target for its trigger — never on whether a downstream answer succeeded.
 * That is exactly what keeps an instance independent and lets a code-heavy
 * session still produce corpus. A model is supplied via NMG_JUDGE_* (same
 * provider pattern as the write-time supersession judge); without one the tool
 * reports corpus metadata + aggregate but cannot semantically label.
 */

export const LABEL_OPTIONS = RECALL_LABELS.join(" | ");

export function buildJudgementPrompt(instance: RecallInstance): string {
  const candidates = instance.candidates
    .map((candidate, index) => `[${index + 1}] ${candidate.statement}`)
    .join("\n");
  return [
    `You are labelling a RETRIEVAL-quality instance, not grading an answer.`,
    `A recall was triggered by this content:`,
    ``,
    `TRIGGER: ${instance.trigger}`,
    ``,
    `These memories were retrieved for that trigger:`,
    candidates.length ? candidates : `(none)`,
    ``,
    `Label the retrieval with exactly one of: ${LABEL_OPTIONS}.`,
    `- on_target: retrieved memory directly answers/concerns the trigger`,
    `- partial: some retrieved memories relevant, others off, or only partly cover it`,
    `- noise: retrieved memories are off-topic / irrelevant to the trigger`,
    `- misleading: a retrieved memory actively contradicts or would mislead on the trigger`,
    `- gap: the memory the trigger needed was NOT retrieved (nothing usable surfaced)`,
    ``,
    `Reply with a JSON object only: {"label":"<one of ${LABEL_OPTIONS}>"}`,
  ].join("\n");
}

/** Parse the model's reply defensively; anything unexpected -> null (leave unlabeled). */
export function parseLabel(raw: string): RecallLabel | null {
  const match = raw.match(/"label"\s*:\s*"([^"]+)"/u);
  const candidate = (match ? match[1] : raw.trim().toLowerCase()) as RecallLabel;
  return (RECALL_LABELS as readonly string[]).includes(candidate) ? candidate : null;
}

export type Classifier = (instance: RecallInstance) => Promise<RecallLabel | null>;

/** OpenAI-compatible relevance classifier configured from NMG_JUDGE_* env. */
export async function chatClassifier(
  baseUrl: string,
  model: string,
  apiKey?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Classifier> {
  return async (instance: RecallInstance): Promise<RecallLabel | null> => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You label retrieval-quality instances precisely." },
          { role: "user", content: buildJudgementPrompt(instance) },
        ],
        temperature: 0,
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseLabel(body.choices?.[0]?.message?.content ?? "");
  };
}

function aggregate(instances: RecallInstance[]): string {
  const summary = summarizeLabels(instances);
  const lines = [
    `total=${summary.total} labeled=${summary.labeled}`,
    ...RECALL_LABELS.map((label) => `  ${label}: ${summary.perLabel[label]}`),
    `precision=${summary.precision === null ? "n/a" : summary.precision.toFixed(3)}`,
    `gapRate=${summary.gapRate === null ? "n/a" : summary.gapRate.toFixed(3)}`,
  ];
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  let dir: string | undefined;
  let limit: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") dir = argv[++index];
    else if (argument === "--limit") limit = Number(argv[++index]);
    else if (argument === "--json") json = true;
  }
  if (!dir) {
    process.stderr.write("usage: recall-instance-judge --dir <dataDir> [--limit N] [--json]\n");
    return 2;
  }
  const directory = resolve(dir);
  const all = readRecallInstances(recallInstancesPath(directory));
  const existing = readRecallLabels(recallLabelsPath(directory));
  const instances = limit ? all.slice(0, limit) : all;
  const baseUrl = process.env.NMG_JUDGE_BASE_URL;
  const model = process.env.NMG_JUDGE_MODEL;
  const apiKey = process.env.NMG_JUDGE_API_KEY;
  const judged = new Set(existing.map((entry) => entry.activeGraphId));
  let newlyLabeled = 0;
  if (baseUrl && model) {
    const classify = await chatClassifier(baseUrl, model, apiKey);
    for (const instance of instances) {
      if (judged.has(instance.activeGraphId)) continue;
      const label = await classify(instance);
      if (label) {
        appendRecallLabel(directory, {
          activeGraphId: instance.activeGraphId,
          label,
          source: "judge",
          at: new Date().toISOString(),
        });
        judged.add(instance.activeGraphId);
        newlyLabeled += 1;
      }
    }
  }
  const final = applyRecallLabels(instances, readRecallLabels(recallLabelsPath(directory)));
  if (json) {
    process.stdout.write(
      JSON.stringify({ instances: final, summary: summarizeLabels(final), newlyLabeled }, null, 2),
    );
  } else {
    process.stdout.write(aggregate(final));
    if (!baseUrl || !model) {
      process.stdout.write("\n(set NMG_JUDGE_BASE_URL + NMG_JUDGE_MODEL to semantically label)");
    } else {
      process.stdout.write(`\nnewlyLabeled=${newlyLabeled}`);
    }
    process.stdout.write("\n");
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exitCode = code,
    (error) => {
      process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    },
  );
}

export { recallInstancesPath };
