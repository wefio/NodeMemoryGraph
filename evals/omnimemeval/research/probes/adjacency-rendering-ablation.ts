// Does adjacency order matter to the reader, or only the recalled content?
//
// The zero-LLM arms showed session adjacency rescues evidence the ranking never
// reaches, and that about half of those rescued turns begin with a pronoun and
// cannot be read without their neighbour. That is a claim about presentation,
// so it needs an answer-stage measurement: same candidate set, different
// placement, official LoCoMo prompts.
//
// Arms, all with identical text and identical record count:
//   page      the recorded top-20 page only
//   tail      page, then the appended session neighbours in activation order
//   anchored  page, with each appended neighbour placed immediately after the
//             page record it is adjacent to, in session order
//
// Only the second and third differ in placement, so their paired result is the
// order effect; the first only says whether appending helps at all.
//
// Usage:
//   node --experimental-strip-types evals/omnimemeval/research/probes/adjacency-rendering-ablation.ts \
//     --scope regression --limit 5 --dry-run
//   node --experimental-strip-types evals/omnimemeval/research/probes/adjacency-rendering-ablation.ts \
//     --scope regression --workers 4 --out evals/locomo/results/adjacency-rendering-<runId>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";

export type Candidate = { id?: string; content?: string; statement?: string; score?: number };
export type Turn = {
  sid: string;
  si: number;
  i: number;
  speaker?: string;
  raw: string;
  text: string;
  date?: string;
};
export type Arm = "page" | "tail" | "anchored" | "anchored-bracketed" | "placebo";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "and",
  "or",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "why",
  "when",
  "where",
  "that",
  "this",
  "it",
  "its",
  "his",
  "her",
  "their",
  "has",
  "have",
  "had",
]);

export const normalize = (value: string): string =>
  value.toLowerCase().replace(/\s+/gu, " ").trim();

export const queryTerms = (question: string): Set<string> =>
  new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9']+/u)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );

/** Appended neighbours for a page, using the product's activation gate:
 * activation = 1/(1+distance) + (shares a query term ? 1 : 0) + 0.5*importance,
 * kept at >= 0.5, capped at `maxMembers`. */
export function appendedNeighbours(
  page: readonly Turn[],
  sessionTurns: ReadonlyMap<number, readonly Turn[]>,
  question: string,
  options: { importance?: number; maxMembers?: number } = {},
): Array<{ turn: Turn; anchor: Turn; score: number }> {
  const importance = options.importance ?? 0.5;
  const maxMembers = options.maxMembers ?? 20;
  const terms = queryTerms(question);
  const inPage = new Set(page.map((turn) => turn.sid));
  const bySession = new Map<number, number[]>();
  for (const turn of page) {
    const list = bySession.get(turn.si) ?? [];
    list.push(turn.i);
    bySession.set(turn.si, list);
  }
  const candidates: Array<{ turn: Turn; anchor: Turn; score: number }> = [];
  for (const [sessionIndex, hits] of bySession) {
    for (const turn of sessionTurns.get(sessionIndex) ?? []) {
      if (inPage.has(turn.sid)) continue;
      let anchor = page[0]!;
      let distance = Number.POSITIVE_INFINITY;
      for (const hit of hits) {
        const gap = Math.abs(hit - turn.i);
        if (gap < distance) {
          distance = gap;
          anchor = page.find((entry) => entry.si === sessionIndex && entry.i === hit) ?? anchor;
        }
      }
      const overlaps = [...terms].some((word) => turn.text.includes(word));
      const score = 1 / (1 + distance) + (overlaps ? 1 : 0) + 0.5 * importance;
      if (score >= 0.5) candidates.push({ turn, anchor, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.turn.sid.localeCompare(b.turn.sid));
  return candidates.slice(0, maxMembers);
}

/** Render one arm. Every arm carries the same records; only placement differs
 * between `tail` and `anchored`. */
export function renderArm(
  arm: Arm,
  page: readonly Turn[],
  appended: ReadonlyArray<{ turn: Turn; anchor: Turn; score: number }>,
  placebo: readonly Turn[] = [],
): string[] {
  // Every arm carries the same date prefix; only placement differs between tail and anchored.
  const line = (turn: Turn) => (turn.date ? `[${turn.date}] ${turn.raw}` : turn.raw);
  if (arm === "page") return page.map(line);
  if (arm === "tail") return [...page.map(line), ...appended.map((entry) => line(entry.turn))];
  // Control: the same number of extra records, drawn from sessions the page did
  // not touch, so "more context" is separated from "these neighbours".
  if (arm === "placebo") return [...page.map(line), ...placebo.map(line)];
  const byAnchor = new Map<string, Turn[]>();
  for (const entry of appended) {
    const list = byAnchor.get(entry.anchor.sid) ?? [];
    list.push(entry.turn);
    byAnchor.set(entry.anchor.sid, list);
  }
  const groups: string[][] = [];
  for (const turn of page) {
    const attached = (byAnchor.get(turn.sid) ?? []).sort((a, b) => a.si - b.si || a.i - b.i);
    groups.push([line(turn), ...attached.map((neighbour) => line(neighbour))]);
  }
  if (arm === "anchored") return groups.flat();
  // Explicit relation marker: the same placement, with each group of related
  // lines wrapped in braces so a reader can see which records belong together.
  // A page record without neighbours stays a single line.
  return groups.flatMap((group) => (group.length > 1 ? ["{", ...group, "}"] : group));
}

function readJudgeSystem(path: string): string {
  // JUDGE_SYSTEM_PROMPT is an implicitly concatenated string, not a triple-quoted one.
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("JUDGE_SYSTEM_PROMPT = (");
  if (start < 0) throw new Error("JUDGE_SYSTEM_PROMPT not found");
  const end = text.indexOf(")", start);
  return [...text.slice(start, end).matchAll(/"([^"]*)"/gu)].map((match) => match[1]).join("");
}

function readPrompt(path: string, name: string): string {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(`${name} = """`);
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const bodyStart = text.indexOf('"""', start) + 3;
  const end = text.indexOf('"""', bodyStart);
  if (end < 0) throw new Error(`${name} is not a closed triple-quoted string`);
  return text.slice(bodyStart, end);
}

type Args = {
  informativeOnly: boolean;
  raw: string;
  scope: "regression" | "multi";
  limit: number;
  out: string;
  envFile: string;
  workers: number;
  dryRun: boolean;
};

function readCli(): Args {
  const { values } = parseArgs({
    options: {
      raw: {
        type: "string",
        default:
          "evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/raw-candidates.jsonl",
      },
      scope: { type: "string", default: "regression" },
      limit: { type: "string", default: "0" },
      out: { type: "string" },
      "env-file": { type: "string", default: ".env.nmg-locomo-reader" },
      workers: { type: "string", default: "4" },
      "dry-run": { type: "boolean", default: false },
      "informative-only": { type: "boolean", default: false },
    },
  });
  const scope = values.scope === "multi" ? "multi" : "regression";
  const limit = Number(values.limit ?? "0");
  const workers = Number(values.workers ?? "4");
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("--limit must be a non-negative integer");
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    throw new Error("--workers must be between 1 and 16");
  }
  const out =
    values.out ??
    `evals/locomo/results/adjacency-rendering-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}`;
  return {
    raw: values.raw!,
    scope,
    limit,
    out,
    envFile: values["env-file"]!,
    workers,
    dryRun: values["dry-run"] === true,
    informativeOnly: values["informative-only"] === true,
  };
}

async function main(): Promise<void> {
  const args = readCli();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const env = loadEnvironmentFile(resolve(root, args.envFile));
  const dataPath = env.NMG_LOCOMO_DATA;
  if (!dataPath) throw new Error(`${args.envFile} must set NMG_LOCOMO_DATA`);
  const promptsPath = resolve(root, ".benchmarks/official/OmniMemEval/scripts/utils/prompts.py");
  const answerPrompt = readPrompt(promptsPath, "LOCOMO_ANSWER_PROMPT");

  const cases = loadLocomo(dataPath);
  const recorded = new Map<string, Candidate[]>();
  for (const line of readFileSync(resolve(root, args.raw), "utf8").trim().split("\n")) {
    const row = JSON.parse(line) as { id: string; raw?: { A?: Candidate[] } };
    recorded.set(row.id, row.raw?.A ?? []);
  }

  const scoped = cases.filter((item) => {
    if (!recorded.has(item.id)) return false;
    const category = Number(item.officialMetadata.category);
    return args.scope === "multi" ? category === 1 : [2, 4].includes(category);
  });
  const informative = args.informativeOnly
    ? scoped.filter((item) => rescuesLabelledEvidence(item, recorded.get(item.id)!))
    : scoped;
  const selected = args.limit > 0 ? informative.slice(0, args.limit) : informative;
  console.log(
    JSON.stringify(
      { scope: args.scope, scoped: scoped.length, informative: informative.length },
      null,
      2,
    ),
  );
  if (selected.length === 0) throw new Error("no questions in scope");

  const outDir = resolve(root, args.out);
  mkdirSync(outDir, { recursive: true });
  console.log(
    JSON.stringify(
      {
        scope: args.scope,
        questions: selected.length,
        arms: ["page", "tail", "anchored", "anchored-bracketed", "placebo"],
        out: outDir,
      },
      null,
      2,
    ),
  );
  if (args.dryRun) {
    const first = selected[0]!;
    const prepared = prepare(first, recorded.get(first.id)!, answerPrompt);
    for (const arm of prepared.arms) {
      console.log(`--- ${arm.arm} (${arm.lines.length} lines)\n${arm.render.slice(-600)}`);
    }
    return;
  }
  const judgePrompt = readPrompt(promptsPath, "JUDGE_PROMPT");
  const judgeSystem = readJudgeSystem(promptsPath);
  const rowsPath = resolve(outDir, "rows.jsonl");
  const rows: Array<Record<string, unknown>> = [];
  const existing = new Set<string>();
  try {
    // Resume: previous answers stay in the summary, not just in the skip set.
    for (const line of readFileSync(rowsPath, "utf8").trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      rows.push(row);
      existing.add(String(row.id));
    }
  } catch {
    // first run
  }
  const queue = selected.filter((item) => {
    const prior = rows.find((row) => row.id === item.id);
    if (!prior) return true;
    // Revisit a row only when an arm it should carry is still absent.
    const answers = (prior.answers as Record<string, string>) ?? {};
    return ["page", "tail", "anchored", "anchored-bracketed", "placebo"].some(
      (arm) => answers[arm] === undefined,
    );
  });
  const totals = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 };
  let done = 0;
  await Promise.all(
    Array.from({ length: args.workers }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const prepared = prepare(item, recorded.get(item.id)!, answerPrompt);
        // Incremental arms: an existing row keeps its answers, and only the arms
        // it does not carry are requested. Adding one rendering therefore costs
        // one arm instead of re-running all five.
        const prior = rows.find((row) => row.id === item.id);
        const answers: Record<string, string> = {
          ...((prior?.answers as Record<string, string> | undefined) ?? {}),
        };
        const labels: Record<string, string> = {
          ...((prior?.labels as Record<string, string> | undefined) ?? {}),
        };
        const missing = prepared.arms.filter((arm) => answers[arm.arm] === undefined);
        const answered = await Promise.all(
          missing.map(async (arm) => ({
            arm: arm.arm,
            answer: await answerOnce(env, arm.render, totals),
          })),
        );
        for (const row of answered) answers[row.arm] = row.answer;
        const unjudged = Object.keys(answers).filter((arm) => labels[arm] === undefined);
        const judged = await Promise.all(
          unjudged.map(async (arm) => ({
            arm,
            label: await judgeOnce(env, judgeSystem, judgePrompt, item, answers[arm] ?? "", totals),
          })),
        );
        for (const row of judged) labels[row.arm] = row.label;
        const record = {
          id: item.id,
          category: Number(item.officialMetadata.category),
          pageRecords: prepared.arms[0]!.lines.length,
          appendedRecords: prepared.arms[1]!.lines.length - prepared.arms[0]!.lines.length,
          answers,
          labels,
        };
        const at = rows.findIndex((row) => row.id === item.id);
        if (at >= 0) rows[at] = record;
        else rows.push(record);
        writeFileSync(rowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
        done += 1;
        if (done % 10 === 0) process.stderr.write(`answered ${done}/${done + queue.length}\n`);
      }
    }),
  );
  writeFileSync(
    resolve(outDir, "summary.json"),
    `${JSON.stringify({ args, totals, summary: summarise(rows) }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify({ out: outDir, rows: rows.length, totals, summary: summarise(rows) }, null, 2),
  );
}

type Totals = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
};

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

type ChatPayload = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
};

/** One attempt: returns the content, or the status when the caller should retry. */
async function chatAttempt(
  key: string,
  baseUrl: string,
  model: string,
  body: Record<string, unknown>,
): Promise<{ status: number; content?: string; payload?: ChatPayload; retryAfter?: string }> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "x-opencode-session": `locomo-reader-${process.pid}`,
    },
    body: JSON.stringify({ model, ...body, thinking: { type: "disabled" } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (isRetryableStatus(response.status)) {
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after") ?? undefined,
    };
  }
  if (!response.ok) {
    const bodyText = (await response.text()).slice(0, 300);
    throw new Error(`chat ${response.status}: ${bodyText}`);
  }
  const payload = (await response.json()) as ChatPayload;
  return {
    status: response.status,
    content: (payload.choices?.[0]?.message?.content ?? "").trim(),
    payload,
  };
}

async function callChat(
  env: Record<string, string | undefined>,
  baseUrl: string,
  model: string,
  body: Record<string, unknown>,
  totals: Totals,
): Promise<string> {
  const key = env.ANSWER_API_KEY;
  if (!key) throw new Error("ANSWER_API_KEY missing");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await chatAttempt(key, baseUrl, model, body);
    if (result.payload) {
      totals.calls += 1;
      totals.promptTokens += result.payload.usage?.prompt_tokens ?? 0;
      totals.completionTokens += result.payload.usage?.completion_tokens ?? 0;
      totals.cacheHitTokens += result.payload.usage?.prompt_cache_hit_tokens ?? 0;
      return result.content ?? "";
    }
    const hint = Number(result.retryAfter ?? "0");
    const delay =
      Number.isFinite(hint) && hint > 0 ? hint * 1_000 : Math.min(30_000, 1_000 * 2 ** attempt);
    await new Promise((wait) => setTimeout(wait, delay));
  }
  throw new Error("chat retries exhausted");
}

async function answerOnce(
  env: Record<string, string | undefined>,
  prompt: string,
  totals: Totals,
): Promise<string> {
  const baseUrl = env.ANSWER_BASE_URL ?? "";
  const model = env.ANSWER_MODEL ?? "";
  if (!baseUrl || !model) throw new Error("ANSWER_BASE_URL/ANSWER_MODEL missing");
  return callChat(
    env,
    baseUrl,
    model,
    { messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 200 },
    totals,
  );
}

async function judgeOnce(
  env: Record<string, string | undefined>,
  system: string,
  template: string,
  item: ReturnType<typeof loadLocomo>[number],
  answer: string,
  totals: Totals,
): Promise<string> {
  const baseUrl = env.JUDGE_BASE_URL ?? env.ANSWER_BASE_URL ?? "";
  const model = env.JUDGE_MODEL ?? env.ANSWER_MODEL ?? "";
  const prompt = template
    .replace("{question}", item.question)
    .replace("{golden_answer}", item.reference)
    .replace("{response}", answer);
  const raw = await callChat(
    env,
    baseUrl,
    model,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 60,
    },
    totals,
  );
  const match = /CORRECT|WRONG/u.exec(raw.toUpperCase());
  return match ? match[0] : "UNPARSED";
}

function exactPairedP(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  const choose = (total: number, k: number): number => {
    let value = 1;
    for (let i = 0; i < k; i += 1) value = (value * (total - i)) / (i + 1);
    return Math.round(value);
  };
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k += 1) tail += choose(n, k);
  return Math.min(1, (2 * tail) / 2 ** n);
}

export function summarise(rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const arms = ["page", "tail", "anchored", "anchored-bracketed", "placebo"] as const;
  const accuracy = Object.fromEntries(
    arms.map((arm) => [
      arm,
      (() => {
        // A row that does not carry this arm is excluded, not counted as wrong.
        const labelled = rows.filter((row) => {
          const label = (row.labels as Record<string, string | undefined>)[arm];
          return label !== undefined && label !== "UNPARSED";
        });
        const correct = labelled.filter(
          (row) => (row.labels as Record<string, string>)[arm] === "CORRECT",
        );
        return {
          n: labelled.length,
          correct: correct.length,
          pct: labelled.length ? +((100 * correct.length) / labelled.length).toFixed(1) : null,
        };
      })(),
    ]),
  );
  const pair = (left: string, right: string) => {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const row of rows) {
      const labels = row.labels as Record<string, string | undefined>;
      const a = labels[left];
      const b = labels[right];
      if (a === undefined || b === undefined || a === "UNPARSED" || b === "UNPARSED") continue;
      if (a === b) ties += 1;
      else if (a === "CORRECT") wins += 1;
      else losses += 1;
    }
    return { wins, losses, ties, p: exactPairedP(wins, losses) };
  };
  return {
    accuracy,
    tailVsPage: pair("tail", "page"),
    anchoredVsPage: pair("anchored", "page"),
    anchoredVsTail: pair("anchored", "tail"),
    bracketedVsAnchored: pair("anchored-bracketed", "anchored"),
    bracketedVsTail: pair("anchored-bracketed", "tail"),
    placeboVsPage: pair("placebo", "page"),
  };
}

/** True when the appended neighbours bring in a labelled evidence turn the
 * recorded page did not contain: the only questions where placement can matter. */
export function rescuesLabelledEvidence(
  item: ReturnType<typeof loadLocomo>[number],
  page: Candidate[],
): boolean {
  const { pageTurns, appended } = prepareTurns(item, page);
  const pageSet = new Set(pageTurns.map((turn) => turn.sid));
  const appendedSet = new Set(appended.map((entry) => entry.turn.sid));
  const labels = (item as { evidenceIds?: string[] }).evidenceIds ?? [];
  return labels.some((label) => !pageSet.has(label) && appendedSet.has(label));
}

type Prepared = { id: string; arms: Array<{ arm: Arm; render: string; lines: string[] }> };

/** Resolve the recorded page back to conversation turns and compute the
 * neighbours the chain rules would append. */
export function prepareTurns(
  item: ReturnType<typeof loadLocomo>[number],
  page: Candidate[],
): {
  pageTurns: Turn[];
  appended: Array<{ turn: Turn; anchor: Turn; score: number }>;
  placebo: Turn[];
} {
  const turns: Turn[] = [];
  for (const session of item.sessions) {
    const sessionIndex = Number(session.id.replace(/^session_/u, ""));
    session.turns.forEach((turn, index) =>
      turns.push({
        sid: turn.sourceId,
        si: sessionIndex,
        i: index,
        ...(turn.speaker ? { speaker: turn.speaker } : {}),
        raw: turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content,
        ...(session.date ? { date: session.date } : {}),
        text: normalize(turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content),
      }),
    );
  }
  const bySession = new Map<number, Turn[]>();
  for (const turn of turns) {
    const list = bySession.get(turn.si) ?? [];
    list.push(turn);
    bySession.set(turn.si, list);
  }
  const pageTurns: Turn[] = [];
  for (const memory of page) {
    const text = normalize(memory.content ?? memory.statement ?? "");
    const match = turns.find((turn) => text.includes(turn.text));
    if (match && !pageTurns.some((entry) => entry.sid === match.sid)) pageTurns.push(match);
  }
  const appended = appendedNeighbours(pageTurns, bySession, item.question);
  // Placebo records: the same count, from sessions the page never touched.
  const touched = new Set(pageTurns.map((turn) => turn.si));
  const placebo = turns
    .filter((turn) => !touched.has(turn.si))
    .sort((a, b) => a.si - b.si || a.i - b.i)
    .slice(0, appended.length);
  return { pageTurns, appended, placebo };
}

function prepare(
  item: ReturnType<typeof loadLocomo>[number],
  page: Candidate[],
  answerPrompt: string,
): Prepared {
  const { pageTurns, appended, placebo } = prepareTurns(item, page);
  return {
    id: item.id,
    arms: (["page", "tail", "anchored", "anchored-bracketed", "placebo"] as const).map((arm) => {
      const lines = renderArm(arm, pageTurns, appended, placebo);
      return {
        arm,
        lines,
        render: `${answerPrompt.replace("{context}", lines.join("\n\n")).replace("{question}", item.question)}`,
      };
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
