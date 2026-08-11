import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadLocomo } from "../benchmarks/loaders.ts";
import {
  DEFAULT_STG_CONSOLIDATION_POLICY,
  configuredStgConsolidationPolicy,
  type StgConsolidationPolicyConfig,
} from "../../src/integration/config.ts";

export interface PosteriorSnapshot {
  alpha: number;
  beta: number;
  mean: number;
  conservativeLowerBound: number;
  independentVotes: number;
}

export function posteriorAfterOutcomes(
  priorConfidence: number,
  supported: number,
  contradicted: number,
): PosteriorSnapshot {
  const priorStrength = 2;
  const alpha = 1 + priorStrength * priorConfidence + supported;
  const beta = 1 + priorStrength * (1 - priorConfidence) + contradicted;
  const total = alpha + beta;
  const mean = alpha / total;
  const standardError = Math.sqrt((mean * (1 - mean)) / Math.max(1, total + 1));
  return {
    alpha,
    beta,
    mean,
    conservativeLowerBound: Math.max(0, Math.min(1, mean - 1.96 * standardError)),
    independentVotes: supported + contradicted,
  };
}

export function consolidationEligible(
  posterior: PosteriorSnapshot,
  policy: StgConsolidationPolicyConfig,
): boolean {
  return (
    posterior.independentVotes >= policy.minimumIndependentVotes &&
    posterior.mean >= policy.minimumPosteriorMean &&
    posterior.conservativeLowerBound >= policy.minimumConservativeLowerBound
  );
}

export function minimumPositiveVotes(
  priorConfidence: number,
  policy: StgConsolidationPolicyConfig,
): number | null {
  for (let votes = 1; votes <= 100; votes += 1) {
    if (consolidationEligible(posteriorAfterOutcomes(priorConfidence, votes, 0), policy)) {
      return votes;
    }
  }
  return null;
}

export function contradictionsToRetract(
  priorConfidence: number,
  supported: number,
  policy: StgConsolidationPolicyConfig,
): number | null {
  if (!consolidationEligible(posteriorAfterOutcomes(priorConfidence, supported, 0), policy)) {
    return 0;
  }
  for (let contradictions = 1; contradictions <= 100; contradictions += 1) {
    const posterior = posteriorAfterOutcomes(priorConfidence, supported, contradictions);
    if (
      posterior.mean < policy.minimumRetainedPosteriorMean ||
      posterior.conservativeLowerBound < policy.minimumRetainedConservativeLowerBound
    ) {
      return contradictions;
    }
  }
  return null;
}

export function evaluateLocomoConsolidation(
  dataPath: string,
  priorConfidence = 0.5,
  policy = DEFAULT_STG_CONSOLIDATION_POLICY,
) {
  const cases = loadLocomo(dataPath);
  const uses = new Map<string, number>();
  for (const item of cases) {
    const sampleId = String(item.officialMetadata.sampleId ?? item.id.split(":")[0]);
    for (const sourceId of new Set(item.evidenceIds ?? [])) {
      const key = `${sampleId}\0${sourceId}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const counts = [...uses.values()];
  const eligible = counts.filter((supported) =>
    consolidationEligible(posteriorAfterOutcomes(priorConfidence, supported, 0), policy)
  );
  const repeated = counts.filter((count) => count >= policy.minimumIndependentVotes);
  const reversal = eligible.map((supported) =>
    contradictionsToRetract(priorConfidence, supported, policy)
  );
  const reversalHistogram = Object.fromEntries(
    [...new Set(reversal)].sort(numberOrNull).map((count) => [String(count), reversal.filter((x) => x === count).length]),
  );
  return {
    protocol: "nmg.stg-consolidation-locomo.v1",
    source: resolve(dataPath),
    supervision: "LoCoMo official evidence IDs; no model-generated labels",
    cases: cases.length,
    conversations: new Set(cases.map((item) => String(item.officialMetadata.sampleId))).size,
    priorConfidence,
    policy: {
      ...policy,
      enabled: false,
    },
    uniqueOfficialEvidence: counts.length,
    repeatedOfficialEvidence: repeated.length,
    eligibleOfficialEvidence: eligible.length,
    minimumAllPositiveVotes: minimumPositiveVotes(priorConfidence, policy),
    coverage: {
      allOfficialEvidence: ratio(eligible.length, counts.length),
      repeatedOfficialEvidence: ratio(eligible.length, repeated.length),
    },
    reversalStress: {
      contradictionsNeededHistogram: reversalHistogram,
      oneContradictionRetracts: reversal.filter((count) => count === 1).length,
      oneContradictionRetractRate: ratio(
        reversal.filter((count) => count === 1).length,
        reversal.length,
      ),
    },
    limits: [
      "This measures gate coverage and posterior reversibility under official-positive outcomes.",
      "It cannot estimate false-promotion precision because absence from a QA evidence list is not a contradiction.",
      "Automatic actuation remains disabled until natural negative/correction labels exist.",
    ],
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function numberOrNull(left: number | null, right: number | null): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function dataPath(): string {
  const candidates = [
    process.env.NMG_CONSOLIDATION_DATA,
    resolve("evals/locomo/data/locomo10.json"),
    resolve(".benchmarks/official/LoCoMo/data/locomo10.json"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`LoCoMo data not found; checked: ${candidates.join(", ")}`);
  return found;
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  const policy = configuredStgConsolidationPolicy(process.env);
  process.stdout.write(`${JSON.stringify(evaluateLocomoConsolidation(dataPath(), 0.5, policy), null, 2)}\n`);
}
