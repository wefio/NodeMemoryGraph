export interface ControllerEvaluationMetrics {
  trainingCases: number;
  trainingEvidenceTargets?: number;
  validationEvidenceTargets?: number;
  overlappingEvidenceTargets?: number;
  candidateRecall: number;
  baselineRecall: number;
  learnedRecall: number;
  baselinePrecision: number;
  learnedPrecision: number;
  baselineInferenceMs: number;
  learnedInferenceMs: number;
  matchedProduct?: ControllerMatchedProductMetrics;
}

export interface ControllerMatchedProductMetrics {
  cases: number;
  baseline: ControllerProductArmMetrics;
  learned: ControllerProductArmMetrics;
}

export interface ControllerProductArmMetrics {
  taskSuccessRate: number;
  evidenceSufficiencyRate: number;
  meanToolRounds: number;
  meanTokens: number;
  meanEndToEndLatencyMs: number;
}

export interface ControllerGateOptions {
  minimumTrainingCases?: number;
  minimumTrainingEvidenceTargets?: number;
  minimumCandidateRecall?: number;
  qualityTolerance?: number;
  latencyFactor?: number;
  minimumInferenceMs?: number;
  minimumMatchedProductCases?: number;
  productQualityTolerance?: number;
  productCostFactor?: number;
  minimumToolRoundAllowance?: number;
  minimumTokenAllowance?: number;
  minimumEndToEndLatencyMs?: number;
}

export interface ControllerEvaluationGate {
  retrievalGate: {
    candidateRecallAdequate: boolean;
    passed: boolean;
  };
  controllerGate: {
    enoughTrainingCases: boolean;
    enoughEvidenceDiversity: boolean;
    evidenceTargetsHeldOut: boolean;
    recallNotDegraded: boolean;
    precisionNotDegraded: boolean;
    inferenceCostBounded: boolean;
    passed: boolean;
  };
  productGate: {
    hasMatchedEvidence: boolean;
    enoughMatchedCases: boolean;
    taskSuccessNotDegraded: boolean;
    evidenceSufficiencyNotDegraded: boolean;
    toolRoundsBounded: boolean;
    tokensBounded: boolean;
    endToEndLatencyBounded: boolean;
    passed: boolean;
  };
  eligibility: {
    shadow: boolean;
    active: boolean;
    defaultPi: boolean;
  };
}

/**
 * Separates candidate-generation quality from controller quality.
 *
 * A controller may run in shadow mode once its own held-out gate passes. It may
 * affect active/default retrieval only when the upstream candidate generator
 * meets its recall target and a matched product comparison preserves task and
 * evidence quality within bounded end-to-end tool, token, and latency cost.
 * Missing matched evidence fails closed rather than treating offline replay as
 * a causal product evaluation.
 */
export function evaluateControllerGate(
  metrics: ControllerEvaluationMetrics,
  options: ControllerGateOptions = {},
): ControllerEvaluationGate {
  const minimumTrainingCases = options.minimumTrainingCases ?? 8;
  const minimumTrainingEvidenceTargets =
    options.minimumTrainingEvidenceTargets ?? minimumTrainingCases;
  const minimumCandidateRecall = options.minimumCandidateRecall ?? 0.8;
  const qualityTolerance = options.qualityTolerance ?? 0.01;
  const latencyFactor = options.latencyFactor ?? 4;
  const minimumInferenceMs = options.minimumInferenceMs ?? 0.25;
  const minimumMatchedProductCases = options.minimumMatchedProductCases ?? 8;
  const productQualityTolerance = options.productQualityTolerance ?? qualityTolerance;
  const productCostFactor = options.productCostFactor ?? 1.25;
  const minimumToolRoundAllowance = options.minimumToolRoundAllowance ?? 1;
  const minimumTokenAllowance = options.minimumTokenAllowance ?? 256;
  const minimumEndToEndLatencyMs = options.minimumEndToEndLatencyMs ?? 250;

  const retrievalGate = {
    candidateRecallAdequate: metrics.candidateRecall >= minimumCandidateRecall,
    passed: false,
  };
  retrievalGate.passed = retrievalGate.candidateRecallAdequate;

  const controllerGate = {
    enoughTrainingCases: metrics.trainingCases >= minimumTrainingCases,
    enoughEvidenceDiversity:
      (metrics.trainingEvidenceTargets ?? metrics.trainingCases) >= minimumTrainingEvidenceTargets,
    evidenceTargetsHeldOut:
      (metrics.validationEvidenceTargets ?? 1) > 0 &&
      (metrics.overlappingEvidenceTargets ?? 0) === 0,
    recallNotDegraded: metrics.learnedRecall + qualityTolerance >= metrics.baselineRecall,
    precisionNotDegraded: metrics.learnedPrecision + qualityTolerance >= metrics.baselinePrecision,
    inferenceCostBounded:
      metrics.learnedInferenceMs <=
      Math.max(minimumInferenceMs, metrics.baselineInferenceMs * latencyFactor),
    passed: false,
  };
  controllerGate.passed =
    controllerGate.enoughTrainingCases &&
    controllerGate.enoughEvidenceDiversity &&
    controllerGate.evidenceTargetsHeldOut &&
    controllerGate.recallNotDegraded &&
    controllerGate.precisionNotDegraded &&
    controllerGate.inferenceCostBounded;

  const matched = metrics.matchedProduct;
  const productGate = {
    hasMatchedEvidence: matched !== undefined,
    enoughMatchedCases: (matched?.cases ?? 0) >= minimumMatchedProductCases,
    taskSuccessNotDegraded:
      matched !== undefined &&
      matched.learned.taskSuccessRate + productQualityTolerance >=
        matched.baseline.taskSuccessRate,
    evidenceSufficiencyNotDegraded:
      matched !== undefined &&
      matched.learned.evidenceSufficiencyRate + productQualityTolerance >=
        matched.baseline.evidenceSufficiencyRate,
    toolRoundsBounded:
      matched !== undefined &&
      matched.learned.meanToolRounds <=
        Math.max(
          matched.baseline.meanToolRounds * productCostFactor,
          matched.baseline.meanToolRounds + minimumToolRoundAllowance,
        ),
    tokensBounded:
      matched !== undefined &&
      matched.learned.meanTokens <=
        Math.max(
          matched.baseline.meanTokens * productCostFactor,
          matched.baseline.meanTokens + minimumTokenAllowance,
        ),
    endToEndLatencyBounded:
      matched !== undefined &&
      matched.learned.meanEndToEndLatencyMs <=
        Math.max(
          minimumEndToEndLatencyMs,
          matched.baseline.meanEndToEndLatencyMs * productCostFactor,
        ),
    passed: false,
  };
  productGate.passed =
    productGate.hasMatchedEvidence &&
    productGate.enoughMatchedCases &&
    productGate.taskSuccessNotDegraded &&
    productGate.evidenceSufficiencyNotDegraded &&
    productGate.toolRoundsBounded &&
    productGate.tokensBounded &&
    productGate.endToEndLatencyBounded;

  const active = controllerGate.passed && retrievalGate.passed && productGate.passed;
  return {
    retrievalGate,
    controllerGate,
    productGate,
    eligibility: {
      shadow: controllerGate.passed,
      active,
      defaultPi: active,
    },
  };
}
