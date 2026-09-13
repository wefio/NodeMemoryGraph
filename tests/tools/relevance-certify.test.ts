import assert from "node:assert/strict";
import test from "node:test";

import { RELEVANCE_FEATURE_NAMES } from "../../src/core/relevance-features.ts";
import {
  CONTROLLER_FEATURE_NAMES,
  binomialAtMost,
  bootstrapNoiseShareUpperBound,
  certifyPoints,
  evaluatePoint,
  isoAcceptanceFrontier,
  lowestRisk,
  maxAcceptance,
  quantileCuts,
  type LatticePoint,
} from "../../tools/relevance-model-train.ts";

/** A lattice point with the derived fields the selection logic reads. */
function point(partial: Partial<LatticePoint> & { family?: LatticePoint["family"] }): LatticePoint {
  const accepted = partial.accepted ?? 0;
  const errors = partial.errors ?? 0;
  return {
    family: partial.family ?? "cv",
    cut: partial.cut ?? 0,
    modelFloor: partial.modelFloor ?? null,
    acceptedQuestions: partial.acceptedQuestions ?? accepted,
    errorQuestions: partial.errorQuestions ?? errors,
    keptCandidates: partial.keptCandidates ?? accepted,
    noiseCandidates: partial.noiseCandidates ?? errors,
    accepted,
    errors,
    acceptance: partial.acceptance ?? 0,
    risk: partial.risk ?? (accepted === 0 ? 0 : errors / accepted),
    items: partial.items ?? (accepted === 0 ? [] : [{ kept: accepted, noise: errors }]),
  };
}

test("binomialAtMost is the exact one-sided tail", () => {
  // P(Bin(10, 0.1) <= 0) = 0.9^10
  assert.ok(Math.abs(binomialAtMost(0, 10, 0.1) - 0.9 ** 10) < 1e-12);
  // P(Bin(4, 0.5) <= 2) = (1 + 4 + 6) / 16
  assert.ok(Math.abs(binomialAtMost(2, 4, 0.5) - 11 / 16) < 1e-12);
  // Every mass counted: k >= m is certain, and the tail is monotone in k.
  assert.equal(binomialAtMost(10, 10, 0.1), 1);
  assert.ok(binomialAtMost(2, 20, 0.3) > binomialAtMost(1, 20, 0.3));
});

test("binomialAtMost refuses an alpha outside (0,1)", () => {
  assert.throws(() => binomialAtMost(1, 10, 0), /alpha must be in/u);
  assert.throws(() => binomialAtMost(1, 10, 1), /alpha must be in/u);
});

test("certifyPoints requires evidence, not just a low observed risk", () => {
  // 0 errors but only 6 trials: P(Bin(6, 0.1) <= 0) = 0.53 — no evidence at all.
  const thin = point({ accepted: 6, errors: 0, acceptance: 0.02 });
  assert.equal(certifyPoints([thin], 0.1, 0.05).certified.length, 0);
  // 0 errors in 300 trials is overwhelming.
  const thick = point({ accepted: 300, errors: 0, acceptance: 1 });
  assert.equal(certifyPoints([thick], 0.1, 0.05).certified.length, 1);
  // Observed risk above alpha can never certify, however many trials.
  const highRisk = point({ accepted: 1000, errors: 300, acceptance: 1 });
  assert.equal(certifyPoints([highRisk], 0.1, 0.05).certified.length, 0);
});

test("certifyPoints spends the delta across the whole lattice (Bonferroni)", () => {
  // P(Bin(20, 0.25) <= 1) = 0.75^20 + 20*0.25*0.75^19 ~ 0.024: below delta = 0.05
  // alone, above delta/41 = 0.00122 once the budget is shared.
  const borderline = point({ accepted: 20, errors: 1, acceptance: 0.2 });
  const p = binomialAtMost(borderline.errors, borderline.accepted, 0.25);
  assert.ok(p > 0.00122 && p < 0.05, `expected a borderline p, got ${p}`);
  assert.equal(certifyPoints([borderline], 0.25, 0.05).certified.length, 1);
  const crowded = certifyPoints(
    [borderline, ...Array.from({ length: 40 }, () => point({ accepted: 1, errors: 0 }))],
    0.25,
    0.05,
  );
  assert.equal(crowded.certified.length, 0);
  assert.ok(Math.abs(crowded.threshold - 0.05 / 41) < 1e-12);
});

test("maxAcceptance prefers acceptance then the lower risk, ignoring empty points", () => {
  const best = maxAcceptance([
    point({ accepted: 0, errors: 0, acceptance: 0 }),
    point({ accepted: 10, errors: 5, acceptance: 0.3 }),
    point({ accepted: 20, errors: 2, acceptance: 0.3 }),
    point({ accepted: 5, errors: 0, acceptance: 0.1 }),
  ]);
  assert.equal(best?.accepted, 20);
  assert.equal(
    lowestRisk([point({ accepted: 10, errors: 5 }), point({ accepted: 10, errors: 1 })])?.errors,
    1,
  );
});

test("quantileCuts always offers a keep-everything cut and stays on the data's scale", () => {
  const cuts = quantileCuts([0.1, 0.2, 0.3, 0.4, 0.5], [0, 0.5, 1]);
  assert.deepEqual(cuts, [0, 0.1, 0.3, 0.5]);
  assert.throws(() => quantileCuts([], [0.5]), /at least one value/u);
});

test("isoAcceptanceFrontier compares at a fixed acceptance level", () => {
  const rows = isoAcceptanceFrontier(
    [
      point({ accepted: 100, errors: 50, acceptance: 0.1, risk: 0.5 }),
      point({ accepted: 100, errors: 20, acceptance: 0.1, risk: 0.2, modelFloor: 0.5 }),
      point({ accepted: 200, errors: 100, acceptance: 0.2, risk: 0.5 }),
    ],
    [0.1, 0.2],
  );
  // At 10% the model-on point is reachable and wins; at 20% only the model-off one exists.
  assert.equal(rows[0]!.anyPoint?.risk, 0.2);
  assert.equal(rows[0]!.modelOff?.risk, 0.5);
  assert.equal(rows[1]!.anyPoint?.modelFloor, null);
});

test("bootstrapNoiseShareUpperBound stays conservative under clustering", () => {
  // Every kept item is noise: no sample can look better than 1.
  const allNoise = [
    { kept: 5, noise: 5 },
    { kept: 1, noise: 1 },
  ];
  assert.equal(
    bootstrapNoiseShareUpperBound(allNoise, { replicates: 200, level: 0.95, seed: 7 }),
    1,
  );
  // No noise at all: every resample is 0.
  assert.equal(
    bootstrapNoiseShareUpperBound([{ kept: 3, noise: 0 }], {
      replicates: 200,
      level: 0.95,
      seed: 7,
    }),
    0,
  );
  // Mixed: the bound sits above the aggregate share and rises with the level.
  const mixed = [
    { kept: 4, noise: 0 },
    { kept: 4, noise: 4 },
  ];
  const aggregate = 4 / 8;
  const at95 = bootstrapNoiseShareUpperBound(mixed, { replicates: 500, level: 0.95, seed: 11 });
  const at50 = bootstrapNoiseShareUpperBound(mixed, { replicates: 500, level: 0.5, seed: 11 });
  assert.ok(at95 >= at50, `expected monotone-in-level bound, got ${at50} -> ${at95}`);
  assert.ok(at95 >= aggregate && at95 <= 1, `bound ${at95} outside [${aggregate}, 1]`);
  // Deterministic for a fixed seed: the same calibration must reproduce.
  assert.equal(
    at95,
    bootstrapNoiseShareUpperBound(mixed, { replicates: 500, level: 0.95, seed: 11 }),
  );
});

test("bootstrapNoiseShareUpperBound refuses degenerate input", () => {
  assert.throws(
    () => bootstrapNoiseShareUpperBound([], { replicates: 10, level: 0.95, seed: 1 }),
    /at least one accepted question/u,
  );
  assert.throws(
    () =>
      bootstrapNoiseShareUpperBound([{ kept: 0, noise: 0 }], {
        replicates: 10,
        level: 0.95,
        seed: 1,
      }),
    /zero kept items/u,
  );
  assert.throws(
    () =>
      bootstrapNoiseShareUpperBound([{ kept: 1, noise: 0 }], { replicates: 10, level: 1, seed: 1 }),
    /level must be in/u,
  );
});

test("the item unit certifies on the clustering-aware bound, not the item binomial", () => {
  // One question, 20 kept items, 20 of them noise: the item view is 100% noise.
  const oneCluster = point({ accepted: 20, errors: 20, acceptance: 0.5 });
  assert.equal(certifyPoints([oneCluster], 0.3, 0.05, "item").certified.length, 0);
  // 30 questions each perfectly clean: the item bound is 0 and it certifies.
  const clean = point({
    accepted: 30,
    errors: 0,
    acceptance: 0.5,
    items: Array.from({ length: 30 }, () => ({ kept: 1, noise: 0 })),
  });
  assert.equal(certifyPoints([clean], 0.3, 0.05, "item").certified.length, 1);
});

test("the controller feature list matches the candidate features it reads", () => {
  assert.equal(new Set(CONTROLLER_FEATURE_NAMES).size, CONTROLLER_FEATURE_NAMES.length);
  assert.equal(CONTROLLER_FEATURE_NAMES.length, 12);
  for (const name of [
    "bounded",
    "term_coverage",
    "idf_coverage",
    "jaccard",
    "char_overlap",
    "raw_log",
  ]) {
    assert.ok(
      RELEVANCE_FEATURE_NAMES.includes(name as never),
      `controller reads candidate feature ${name}, which does not exist`,
    );
  }
});

test("the fusion family combines the two scores instead of intersecting them", () => {
  const bounded = RELEVANCE_FEATURE_NAMES.indexOf("bounded" as never);
  assert.ok(bounded >= 0, "the fusion family reads the bounded lexical feature");
  const row = (boundedScore: number) => {
    const features = RELEVANCE_FEATURE_NAMES.map(() => 0);
    features[bounded] = boundedScore;
    return features;
  };
  // The model's favourite (bounded 0: the program half rejects it outright) and
  // the program's favourite (bounded 1: the model half rejects it). An item
  // threshold on the model alone keeps one of them; the fused rule, which reads
  // both, keeps both — that is the difference between a fusion and an AND.
  const features = [row(0), row(1)];
  const entry = {
    group: { features, labels: [1, 0], keywords: [], question: "q" } as never,
    cv: 1,
    qpp: 1,
    controller: [] as number[],
  };
  const models = {
    item: { predict: (given: readonly number[]) => (given[bounded] === 0 ? 0.9 : 0.1) },
  } as never;

  const andPoint = evaluatePoint([entry], models, "cv", 0, 0.45, "item");
  const fusedPoint = evaluatePoint([entry], models, "fusion", 0.5, 0.45, "item");
  assert.equal(andPoint.keptCandidates, 1);
  assert.equal(fusedPoint.keptCandidates, 2);
  assert.equal(fusedPoint.noiseCandidates, 1);
  // A fused weight of 1 is the model alone, and weight 0 is the program alone.
  assert.equal(evaluatePoint([entry], models, "fusion", 1, 0.45, "item").keptCandidates, 1);
  assert.equal(evaluatePoint([entry], models, "fusion", 0, 0.45, "item").keptCandidates, 1);
  // The set-level half of a fusion point is not a signal: the query is always
  // a candidate for acceptance, so a weight alone cannot abstain.
  assert.equal(evaluatePoint([entry], models, "fusion", 0.5, 0.99, "item").accepted, 0);
});

test("the rrf family fuses rule rankings and can still abstain", () => {
  const index = (name: string) => {
    const column = RELEVANCE_FEATURE_NAMES.indexOf(name as never);
    assert.ok(column >= 0, `missing feature ${name}`);
    return column;
  };
  const bounded = index("bounded");
  const idf = index("idf_coverage");
  // The absolute-relevance rule and the overlap rule disagree about the best
  // candidate. RRF gives both a nonzero fused score; per-rule thresholds in
  // series would keep neither.
  const first = RELEVANCE_FEATURE_NAMES.map(() => 0);
  const second = RELEVANCE_FEATURE_NAMES.map(() => 0);
  first[bounded] = 0.8;
  second[idf] = 0.9;
  const entry = {
    group: { features: [first, second], labels: [1, 0], keywords: [], question: "q" } as never,
    cv: 1,
    qpp: 1,
    controller: [] as number[],
  };
  const models = {} as never;
  const kept = evaluatePoint([entry], models, "rrf", 0.01, null, "item");
  assert.equal(kept.keptCandidates, 2);
  // A cut above every fused score keeps nothing: the composition can abstain.
  assert.equal(evaluatePoint([entry], models, "rrf", 0.99, null, "item").accepted, 0);
  // With a floor the model joins as a second item filter rather than a set cut.
  const filtered = evaluatePoint(
    [entry],
    { item: { predict: (row: readonly number[]) => (row[bounded] === 0.8 ? 0.9 : 0.1) } } as never,
    "rrf",
    0.01,
    0.5,
    "item",
  );
  assert.equal(filtered.keptCandidates, 1);
});

test("the rrffusion family weights the fused rule score against the model", () => {
  const column = (name: string) => {
    const index = RELEVANCE_FEATURE_NAMES.indexOf(name as never);
    assert.ok(index >= 0, `missing feature ${name}`);
    return index;
  };
  // Candidate 0 tops all four rule routes; candidate 1 tops none. RRF on two
  // candidates gives them nearly equal fused scores (4/61 versus 4/62), so the
  // normalised rules half barely separates them: the weight is what decides.
  const strong = RELEVANCE_FEATURE_NAMES.map((_, index) => (index === column("bounded") ? 1 : 0));
  const weak = RELEVANCE_FEATURE_NAMES.map((name) => (name === "bounded" ? 0 : 0));
  const entry = {
    group: { features: [strong, weak], labels: [1, 0], keywords: [], question: "q" } as never,
    cv: 1,
    qpp: 1,
    controller: [] as number[],
  };
  const models = {
    item: { predict: (row: readonly number[]) => (row[column("bounded")] === 1 ? 0.1 : 0.9) },
  } as never;
  const keptAt = (weight: number) =>
    evaluatePoint([entry], models, "rrffusion", weight, 0.5, "item").keptCandidates;

  assert.equal(keptAt(1), 1, "weight 1 is the model alone");
  assert.equal(keptAt(0), 2, "weight 0 is the rules half alone");
  assert.equal(keptAt(0.5), 2, "half the fused rule score rescues the model's reject");
  assert.equal(evaluatePoint([entry], models, "rrffusion", 0.5, null, "item").keptCandidates, 2);
});
