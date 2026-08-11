import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cosineSimilarity, HashingVectorEmbedder } from "../../src/core/vector.ts";

export interface NamesakesMention {
  text: string;
  start: number;
  end: number;
  tag: "Same" | "Other";
}

export interface NamesakesEntity {
  pagename: string;
  pageid: number | string;
  title: string;
  url: string;
  text: string;
  entities: NamesakesMention[];
}

export interface NamesakesCandidate {
  pageId: string;
  title: string;
  mention: string;
  tag: "Same" | "Other";
  score: number;
  aliasPositive: boolean;
  exactNameNegative: boolean;
}

export interface NamesakesThresholdPoint {
  threshold: number;
  candidates: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  recall: number;
  precision: number;
  aliasRecall: number;
  exactNameNegativeRejection: number;
}

export interface NamesakesStreamingPoint {
  threshold: number;
  incomingMentions: number;
  proposals: number;
  proposalRate: number;
  entitiesWithProposal: number;
  entitiesWithFalseProposal: number;
  falseProposalEntityRate: number;
  contaminatingMentions: number;
  meanContaminationPerAffectedEntity: number;
  maxContaminationPerEntity: number;
}

export interface NamesakesTopologyReport {
  benchmark: "Namesakes";
  source: string;
  entitiesRead: number;
  entitiesEvaluated: number;
  examples: number;
  positives: number;
  negatives: number;
  aliasPositives: number;
  exactNameNegatives: number;
  thresholds: NamesakesThresholdPoint[];
  streaming: NamesakesStreamingPoint[];
  limitations: string[];
}

const DEFAULT_THRESHOLDS = [-0.25, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7] as const;

/**
 * Stream the official JSONL instead of loading the ~216 MB release in memory.
 * maxEntities bounds a local smoke run without changing the scoring protocol.
 */
export async function loadNamesakesEntities(
  path: string,
  maxEntities = Number.POSITIVE_INFINITY,
): Promise<NamesakesEntity[]> {
  const rows: NamesakesEntity[] = [];
  const input = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as NamesakesEntity;
    validateEntity(row);
    rows.push(row);
    if (rows.length >= maxEntities) break;
  }
  return rows;
}

/**
 * Use one labelled Same mention as the local entity prototype. Labels are not
 * exposed to the hashing embedder; they are consulted only after scoring.
 */
export function buildNamesakesCandidates(
  rows: readonly NamesakesEntity[],
  contextRadius = 240,
): NamesakesCandidate[] {
  const embedder = new HashingVectorEmbedder();
  return rows.flatMap((row) => {
    const positives = row.entities.filter((mention) => mention.tag === "Same");
    if (positives.length < 2) return [];
    const anchor = positives[0]!;
    const anchorVector = embedder.embed(mentionContext(row.text, anchor, contextRadius));
    return row.entities
      .filter((mention) => mention !== anchor)
      .map((mention) => ({
        pageId: String(row.pageid),
        title: row.title,
        mention: mention.text,
        tag: mention.tag,
        score: cosineSimilarity(
          anchorVector,
          embedder.embed(mentionContext(row.text, mention, contextRadius)),
        ),
        aliasPositive:
          mention.tag === "Same" && normalizeName(mention.text) !== normalizeName(row.title),
        exactNameNegative:
          mention.tag === "Other" && normalizeName(mention.text) === normalizeName(row.title),
      }));
  });
}

export function namesakesThresholdCurve(
  candidates: readonly NamesakesCandidate[],
  thresholds: readonly number[] = DEFAULT_THRESHOLDS,
): NamesakesThresholdPoint[] {
  const positives = candidates.filter((item) => item.tag === "Same");
  const aliasPositives = candidates.filter((item) => item.aliasPositive);
  const exactNameNegatives = candidates.filter((item) => item.exactNameNegative);
  return thresholds.map((threshold) => {
    const selected = candidates.filter((item) => item.score >= threshold);
    const truePositives = selected.filter((item) => item.tag === "Same").length;
    const falsePositives = selected.length - truePositives;
    const selectedAliases = selected.filter((item) => item.aliasPositive).length;
    const rejectedExactNameNegatives = exactNameNegatives.filter(
      (item) => item.score < threshold,
    ).length;
    return {
      threshold,
      candidates: selected.length,
      truePositives,
      falsePositives,
      falseNegatives: positives.length - truePositives,
      recall: ratio(truePositives, positives.length),
      precision: ratio(truePositives, selected.length),
      aliasRecall: ratio(selectedAliases, aliasPositives.length),
      exactNameNegativeRejection: ratio(
        rejectedExactNameNegatives,
        exactNameNegatives.length,
      ),
    };
  });
}

/**
 * Replay each non-anchor mention as one online arrival. A selected `Other`
 * mention is a false same-entity proposal; if such proposals were actuated it
 * would co-locate that many foreign records with the page entity. This remains
 * a read-only counterfactual and never mutates NMG topology.
 */
export function namesakesStreamingAudit(
  candidates: readonly NamesakesCandidate[],
  thresholds: readonly number[] = DEFAULT_THRESHOLDS,
): NamesakesStreamingPoint[] {
  const entities = new Set(candidates.map((candidate) => candidate.pageId));
  return thresholds.map((threshold) => {
    const selected = candidates.filter((candidate) => candidate.score >= threshold);
    const proposalsByEntity = groupCount(selected, () => true);
    const falseByEntity = groupCount(selected, (candidate) => candidate.tag === "Other");
    const contamination = [...falseByEntity.values()];
    return {
      threshold,
      incomingMentions: candidates.length,
      proposals: selected.length,
      proposalRate: ratio(selected.length, candidates.length),
      entitiesWithProposal: proposalsByEntity.size,
      entitiesWithFalseProposal: falseByEntity.size,
      falseProposalEntityRate: ratio(falseByEntity.size, entities.size),
      contaminatingMentions: contamination.reduce((sum, count) => sum + count, 0),
      meanContaminationPerAffectedEntity: ratio(
        contamination.reduce((sum, count) => sum + count, 0),
        falseByEntity.size,
      ),
      maxContaminationPerEntity: contamination.length === 0 ? 0 : Math.max(...contamination),
    };
  });
}

export async function auditNamesakes(
  path: string,
  maxEntities = Number.POSITIVE_INFINITY,
): Promise<NamesakesTopologyReport> {
  const rows = await loadNamesakesEntities(path, maxEntities);
  const candidates = buildNamesakesCandidates(rows);
  return {
    benchmark: "Namesakes",
    source: resolve(path),
    entitiesRead: rows.length,
    entitiesEvaluated: new Set(candidates.map((item) => item.pageId)).size,
    examples: candidates.length,
    positives: candidates.filter((item) => item.tag === "Same").length,
    negatives: candidates.filter((item) => item.tag === "Other").length,
    aliasPositives: candidates.filter((item) => item.aliasPositive).length,
    exactNameNegatives: candidates.filter((item) => item.exactNameNegative).length,
    thresholds: namesakesThresholdCurve(candidates),
    streaming: namesakesStreamingAudit(candidates),
    limitations: [
      "The first Same mention is a deterministic prototype, not a learned entity representation.",
      "The local hashing score is a candidate-generation baseline, not calibrated identity confidence.",
      "This evaluator is read-only and never submits or actuates an NMG topology proposal.",
      "The streaming audit measures proposal prevalence and structural co-location contamination, not downstream Agent answer quality or user correction events.",
    ],
  };
}

function groupCount(
  candidates: readonly NamesakesCandidate[],
  include: (candidate: NamesakesCandidate) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!include(candidate)) continue;
    counts.set(candidate.pageId, (counts.get(candidate.pageId) ?? 0) + 1);
  }
  return counts;
}

function mentionContext(text: string, mention: NamesakesMention, radius: number): string {
  const start = Math.max(0, mention.start - radius);
  const end = Math.min(text.length, mention.end + radius);
  return text.slice(start, mention.start) + " [MENTION] " + text.slice(mention.end, end);
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function validateEntity(row: NamesakesEntity): void {
  if (!row || typeof row.text !== "string" || !Array.isArray(row.entities)) {
    throw new Error("invalid Namesakes entity row");
  }
  for (const mention of row.entities) {
    if (
      typeof mention.text !== "string" ||
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      !["Same", "Other"].includes(mention.tag)
    ) {
      throw new Error("invalid Namesakes mention");
    }
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

async function main(): Promise<void> {
  const path = resolve(
    process.env.NMG_NAMESAKES_DATA ??
      ".benchmarks/namesakes/data/Namesakes_entities.jsonl",
  );
  const maxEntities = process.env.NMG_NAMESAKES_MAX_ENTITIES
    ? Number(process.env.NMG_NAMESAKES_MAX_ENTITIES)
    : Number.POSITIVE_INFINITY;
  const report = await auditNamesakes(path, maxEntities);
  const output = resolve(
    process.env.NMG_NAMESAKES_REPORT ?? "evals/topology/results/namesakes-latest.json",
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, ...report }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
