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
  type RecallLabelEntry,
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

/** Reading view for the agent-as-judge: one block per instance with the
 *  trigger, candidates, and the label already on record (if any). */
export function formatInstanceList(
  instances: RecallInstance[],
  labels: RecallLabelEntry[],
): string {
  const byGraph = new Map(labels.map((entry) => [entry.activeGraphId, entry.label]));
  return instances
    .map((instance, index) => {
      const candidates = instance.candidates
        .map(
          (candidate, position) =>
            `      [${position + 1}] ${candidate.statement.replace(/\s+/gu, " ").slice(0, 160)}`,
        )
        .join("\n");
      return [
        `#${index + 1} graph=${instance.activeGraphId} label=${byGraph.get(instance.activeGraphId) ?? "-"} kind=${instance.kind}`,
        `   trigger=${JSON.stringify(instance.trigger)}`,
        candidates,
      ].join("\n");
    })
    .join("\n");
}

/** Record one agent judgement. Invalid labels are rejected, never guessed. */
export function recordLabel(directory: string, graphId: string, label: string): boolean {
  if (!(RECALL_LABELS as readonly string[]).includes(label)) return false;
  appendRecallLabel(directory, {
    activeGraphId: graphId,
    label: label as RecallLabel,
    source: "judge",
    at: new Date().toISOString(),
  });
  return true;
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

interface JudgeCliOptions {
  dir?: string;
  limit?: number;
  json?: boolean;
  list?: boolean;
  set?: string[];
}

function parseArgs(argv: string[]): JudgeCliOptions {
  const options: JudgeCliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") options.dir = argv[++index];
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (argument === "--json") options.json = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--set") (options.set ??= []).push(argv[++index] ?? "");
  }
  return options;
}

/** Judge every not-yet-labelled instance via the configured model; returns the
 *  number newly labelled. No-op (returns 0) without NMG_JUDGE_BASE_URL/MODEL. */
async function labelBatch(
  directory: string,
  instances: RecallInstance[],
  judged: Set<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const baseUrl = env.NMG_JUDGE_BASE_URL;
  const model = env.NMG_JUDGE_MODEL;
  if (!baseUrl || !model) return 0;
  const classify = await chatClassifier(baseUrl, model, env.NMG_JUDGE_API_KEY);
  let newlyLabeled = 0;
  for (const instance of instances) {
    if (judged.has(instance.activeGraphId)) continue;
    const label = await classify(instance);
    if (!label) continue;
    appendRecallLabel(directory, {
      activeGraphId: instance.activeGraphId,
      label,
      source: "judge",
      at: new Date().toISOString(),
    });
    judged.add(instance.activeGraphId);
    newlyLabeled += 1;
  }
  return newlyLabeled;
}

function applyExplicitLabels(directory: string, specs: string[]): number {
  const known = new Set(
    readRecallInstances(recallInstancesPath(directory)).map(
      (instance) => instance.activeGraphId,
    ),
  );
  let written = 0;
  for (const spec of specs) {
    const split = spec.indexOf("=");
    const graphId = split > 0 ? spec.slice(0, split) : "";
    const label = split > 0 ? spec.slice(split + 1) : "";
    if (!graphId || !known.has(graphId)) {
      process.stderr.write(`skip ${spec}: unknown instance\n`);
      continue;
    }
    if (!recordLabel(directory, graphId, label)) {
      process.stderr.write(`skip ${spec}: invalid label\n`);
      continue;
    }
    written += 1;
  }
  return written;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options.dir) {
    process.stderr.write(
      "usage: recall-instance-judge --dir <dataDir> [--list] [--set <graphId>=<label>]... [--limit N] [--json]\n",
    );
    return 2;
  }
  const directory = resolve(options.dir);
  if (options.set?.length) {
    const written = applyExplicitLabels(directory, options.set);
    process.stdout.write(`labeled=${written}\n`);
    if (!options.list) return 0;
  }
  if (options.list) {
    const all = readRecallInstances(recallInstancesPath(directory));
    const labels = readRecallLabels(recallLabelsPath(directory));
    process.stdout.write(`${formatInstanceList(all, labels)}\n`);
    return 0;
  }
  const all = readRecallInstances(recallInstancesPath(directory));
  const existing = readRecallLabels(recallLabelsPath(directory));
  const instances = options.limit ? all.slice(0, options.limit) : all;
  const judged = new Set(existing.map((entry) => entry.activeGraphId));
  const newlyLabeled = await labelBatch(directory, instances, judged);
  const final = applyRecallLabels(instances, readRecallLabels(recallLabelsPath(directory)));
  const hadModel = Boolean(process.env.NMG_JUDGE_BASE_URL && process.env.NMG_JUDGE_MODEL);
  if (options.json) {
    process.stdout.write(
      JSON.stringify({ instances: final, summary: summarizeLabels(final), newlyLabeled }, null, 2),
    );
  } else {
    process.stdout.write(aggregate(final));
    process.stdout.write(
      hadModel ? `\nnewlyLabeled=${newlyLabeled}\n` : "\n(set NMG_JUDGE_BASE_URL + NMG_JUDGE_MODEL to semantically label)\n",
    );
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
