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
}

export interface ControllerGateOptions {
  minimumTrainingCases?: number;
  minimumTrainingEvidenceTargets?: number;
  minimumCandidateRecall?: number;
  qualityTolerance?: number;
  latencyFactor?: number;
  minimumInferenceMs?: number;
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
 * also meets its recall target.
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

  const active = controllerGate.passed && retrievalGate.passed;
  return {
    retrievalGate,
    controllerGate,
    eligibility: {
      shadow: controllerGate.passed,
      active,
      defaultPi: active,
    },
  };
}
