/** Custom component probe, NOT the official OmniMemEval answer benchmark.
 * Executes all four context actions from identical per-question snapshots.
 * Lexical message ranking is an explicitly custom baseline, not NMG retrieval.
 * Gold evidence is visible only to scoring/admission, never to features/ranking.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ContextIntervention } from "../../src/lab/context-intervention.ts";
import { ContextTrialJournal } from "../../src/lab/context-journal.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDataset, type EvalQuestion } from "../retrieval/datasets.ts";
import { scoreQuestion } from "../retrieval/score.ts";
import { CONTEXT_ACTIONS, ContextRouter } from "../../src/lab/context-router.ts";
import { CONTEXT_FEATURE_VERSION, encodeContextFeatures } from "../../src/lab/context-features.ts";
import { runContextTrial, type ContextTrialEvent } from "../../src/lab/context-trial.ts";
import type { ContextEvidence } from "../../src/lab/context-executor.ts";
import { buildContextDataset, type ContextDatasetRow } from "./context-dataset.ts";
import { contextCostPenalties } from "./context-cost.ts";
import { summarizeContextGroups } from "./context-report.ts";

const ACCEPTANCE = "locomo-evidence-coverage-v1";
const MAX_CHARS = 4000;
// Pinned illustrative pre-action estimates, not fitted to held-out outcomes.
const COST_ESTIMATES = [
  { tokens: 0, latencyMs: 0, toolCalls: 0 },
  { tokens: 21, latencyMs: 0, toolCalls: 0 },
  { tokens: 200, latencyMs: 1, toolCalls: 0 },
  { tokens: 800, latencyMs: 10, toolCalls: 1 },
];
const COST_PRICES = { perThousandTokens: 1, perSecond: 1, perToolCall: 0 };
const terms = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function rank(query: string, source: readonly ContextEvidence[]) {
  const queryTerms = terms(query);
  return source
    .map((evidence) => {
      const words = terms(evidence.text);
      const hits = [...queryTerms].filter((term) => words.has(term)).length;
      return { evidence, score: hits / Math.max(queryTerms.size, 1) };
    })
    .sort((a, b) => b.score - a.score || a.evidence.id.localeCompare(b.evidence.id));
}

function verifyProbeEvidence(
  sample: Readonly<ContextIntervention>,
  verified: ReadonlyMap<string, string>,
  artifacts: ReadonlyMap<string, { text: string; evidenceIds: string[] }>,
): boolean {
  const artifact = artifacts.get(sample.decisionId);
  if (!artifact || !sample.execution?.result) return false;
  return (
    verified.get(sample.decisionId) === JSON.stringify(sample.outcome) &&
    sample.execution.result.contentHash ===
      createHash("sha256").update(artifact.text).digest("hex") &&
    sample.execution.result.characters === artifact.text.length &&
    JSON.stringify(sample.execution.result.evidenceIds) === JSON.stringify(artifact.evidenceIds)
  );
}

function coverage(question: EvalQuestion, text: string): number {
  const scored = scoreQuestion(
    { category: question.category, golds: question.golds, candidates: [[text]], contextText: text },
    "gold-in-candidate",
  );
  return scored.legacyHits.filter(Boolean).length / Math.max(scored.legacyHits.length, 1);
}

async function collectQuestion(
  question: EvalQuestion,
  source: readonly ContextEvidence[],
  sink: (event: ContextTrialEvent) => void,
  verified: Map<string, string>,
  artifacts: Map<string, { text: string; evidenceIds: string[] }>,
) {
  const ranked = rank(question.query, source);
  const features = encodeContextFeatures({
    contextOccupancy: 0,
    remainingTokenRatio: 1,
    remainingToolRatio: 1,
    topCandidateScore: ranked[0]?.score ?? 0,
    candidateScoreGap: (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0),
    candidateCount: ranked.length,
  });
  for (const action of CONTEXT_ACTIONS) {
    const decisionId = `${question.id}:${action}`;
    await runContextTrial({
      decision: {
        schemaVersion: 1,
        decisionId,
        taskId: question.id,
        sessionId: "component-probe",
        taskFrameId: question.id,
        acceptanceVersion: ACCEPTANCE,
        featureVersion: CONTEXT_FEATURE_VERSION,
        policyVersion: "matched-snapshot-v1",
        origin: "benchmark",
        mode: "executed",
        decidedAt: Date.now(),
        features,
        allowed: [...CONTEXT_ACTIONS],
        selected: action,
        probability: 1,
      },
      executor: {
        authorized: true,
        maxChars: MAX_CHARS,
        remainingToolCalls: 1,
        evidence: ranked.slice(0, 1).map((item) => item.evidence),
        signal: new AbortController().signal,
        retrieve: async () => ranked.slice(0, 5).map((item) => item.evidence),
      },
      sink,
      evaluate: async (output, startedAt) => {
        const outcome = {
          taskId: question.id,
          acceptanceVersion: ACCEPTANCE,
          windowStart: startedAt,
          windowEnd: Date.now(),
          recordedAt: Date.now(),
          status: "observed" as const,
          reward: coverage(question, output.text),
          evidenceRefs: [`probe:${decisionId}`],
          // Character/4 is an explicit estimate, not measured provider usage.
          costs: {
            tokens: Math.ceil(output.text.length / 4),
            toolCalls: output.toolCalls,
            latencyMs: Date.now() - startedAt,
          },
        };
        artifacts.set(decisionId, { text: output.text, evidenceIds: output.evidenceIds });
        verified.set(decisionId, JSON.stringify(outcome));
        return outcome;
      },
      verifyEvidence: (sample) => verifyProbeEvidence(sample, verified, artifacts),
    });
  }
}

function evaluatePolicy(rows: ContextDatasetRow[], router: ContextRouter | null, lambda = 0) {
  const penalties = contextCostPenalties(COST_ESTIMATES, COST_PRICES, lambda);
  const groups = new Map<string, ContextDatasetRow[]>();
  for (const row of rows) {
    const group = groups.get(row.sample.taskId) ?? [];
    group.push(row);
    groups.set(row.sample.taskId, group);
  }
  let reward = 0;
  let tokens = 0;
  const counts: Record<string, number> = {};
  for (const group of groups.values()) {
    const first = group[0]!.sample;
    const action =
      router?.select(first.features, first.allowed, penalties, 0, () => 0).action ?? "retrieve";
    const selected = group.find((row) => row.sample.selected === action)?.sample;
    if (!selected?.outcome || group.length !== 4) throw new Error("incomplete matched snapshot");
    reward += selected.outcome.reward;
    tokens += selected.outcome.costs.tokens;
    counts[action] = (counts[action] ?? 0) + 1;
  }
  return {
    questions: groups.size,
    evidenceCoverage: reward / groups.size,
    estimatedTokens: tokens / groups.size,
    actions: counts,
  };
}

export async function runContextProbe(out: string) {
  const dataset = loadDataset("locomo", { full: true });
  mkdirSync(out, { recursive: true });
  const events: ContextTrialEvent[] = [];
  const verified = new Map<string, string>();
  const artifacts = new Map<string, { text: string; evidenceIds: string[] }>();
  const groups = new Map(dataset.questions.map((q) => [q.id, q.userId]));
  const eventPath = resolve(out, "events.jsonl");
  writeFileSync(eventPath, "", { flag: "wx" });
  const journal = new ContextTrialJournal(eventPath);
  const sink = (event: ContextTrialEvent) => {
    journal.append(event);
    events.push(event);
  };
  try {
    for (const question of dataset.questions.filter((q) => q.golds.length > 0)) {
      const source = dataset.conversations
        .filter((c) => c.userId === question.userId)
        .flatMap((c) =>
          c.messages.map((m, i) => ({ id: `${c.conversationId}:${i}`, text: m.content })),
        );
      await collectQuestion(question, source, sink, verified, artifacts);
    }
  } finally {
    journal.close();
  }
  writeFileSync(resolve(out, "evidence.json"), JSON.stringify(Object.fromEntries(artifacts)));
  const data = buildContextDataset({
    events,
    featureVersion: CONTEXT_FEATURE_VERSION,
    acceptanceVersion: ACCEPTANCE,
    origin: "benchmark",
    groupForTask: (task) => groups.get(task) ?? "",
    verifyEvidence: (sample) => verifyProbeEvidence(sample, verified, artifacts),
  });
  const partition = (split: string) => data.rows.filter((row) => row.split === split);
  const train = partition("train");
  const validation = partition("validation");
  const heldOut = partition("test");
  if (![train, validation, heldOut].every((rows) => rows.length > 0))
    throw new Error("empty independent partition");
  const candidates = [1, 5, 20].map((epochs) => {
    const router = new ContextRouter();
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const row of train)
        router.update(row.sample.features, row.sample.selected, row.sample.outcome!.reward, 0.01);
    }
    return { epochs, router, validation: evaluatePolicy(validation, router) };
  });
  candidates.sort(
    (a, b) => b.validation.evidenceCoverage - a.validation.evidenceCoverage || a.epochs - b.epochs,
  );
  const selected = candidates[0]!;
  const report = {
    scope:
      "custom lexical context-evidence component probe; NOT answer accuracy, product retrieval or causal full-task benefit",
    dataset: { path: dataset.dataPath, sha256: dataset.sha256 },
    featureVersion: CONTEXT_FEATURE_VERSION,
    acceptanceVersion: ACCEPTANCE,
    splitUnit: "source user/conversation, stable SHA256 60/20/20 buckets",
    budget: { maxChars: MAX_CHARS, maxToolCalls: 1 },
    caveats: [
      "cue cannot improve this evidence-only metric",
      "no main LLM executed",
      "token counts are character/4 estimates",
      "independent matched snapshots cannot test sequential history by construction",
      "primary held-out comparison keeps lambda=0; separate validation-only cost scan is diagnostic",
    ],
    groups: Object.fromEntries(
      ["train", "validation", "test"].map((s) => [
        s,
        new Set(partition(s).map((r) => r.groupId)).size,
      ]),
    ),
    independentSamples: summarizeContextGroups(data.rows),
    rows: data.rows.length,
    excluded: data.excluded,
    selectedEpochs: selected.epochs,
    validation: selected.validation,
    costSensitivity: {
      scope: "validation-only diagnostic; not a new held-out confirmation or activation gate",
      estimates: COST_ESTIMATES,
      prices: COST_PRICES,
      scan: [0, 0.1, 1].map((lambda) => ({
        lambda,
        ...evaluatePolicy(validation, selected.router, lambda),
      })),
    },
    heldOut: {
      fixedRetrieve: evaluatePolicy(heldOut, null),
      linear: evaluatePolicy(heldOut, selected.router),
    },
    parameters: selected.router.parameters(),
    defaultActivation: false,
  };
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve(process.argv[2] ?? `.nmg/context-probe/${Date.now()}`);
  console.log(JSON.stringify(await runContextProbe(out), null, 2));
}
