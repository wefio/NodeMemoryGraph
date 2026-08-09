export const DEFAULT_CONSOLIDATION_POLICY = {
  minIndependentTasks: 3,
  promoteThreshold: 0.75,
  demoteThreshold: 0.45,
  cooldownMs: 7 * 24 * 60 * 60 * 1_000,
} as const;

export const DEFAULT_TOPOLOGY_POLICY = {
  minObservations: 3,
  minGain: 0.6,
  cooldownMs: 7 * 24 * 60 * 60 * 1_000,
} as const;

export const DEFAULT_RETENTION_POLICY = {
  dormantAfterDays: 365,
  quarantineAfterDays: 365,
  maximumImportance: 0.25,
  maximumAccessCount: 1,
} as const;

export const SUPERSEDE_SUCCESSOR_BOOST = 0.3;
export const TEMPORAL_ASOF_BOOST = 0.25;
export const TEMPORAL_ASOF_DECAY_DAYS = 730;
export const MIN_WARM_DISCLOSURE_SIZE = 5;

export const NEAR_DUPLICATE_THRESHOLD = 0.7;
export const NEAR_DUPLICATE_SCAN = 50;
export const SUPERSEDE_MIN_SHARED_TOKENS = 1;
export const SUPERSEDE_CANDIDATE_MAX = 10;
/** Bounds SQLite's OR expression and favors selective long content terms. */
export const SUPERSEDE_PREFILTER_MAX_TERMS = 64;
