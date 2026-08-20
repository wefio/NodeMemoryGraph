import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { resolveNmgDataDir } from "../../src/cli/data-path.ts";
import { canonicalNodeIdentity } from "../../src/core/store/rows.ts";
import { parseStringArray } from "../../src/core/store/row-parse.ts";
import {
  configuredMaintenancePolicy,
  configuredStgConsolidationPolicy,
  type MaintenancePolicyConfig,
  type StgConsolidationPolicyConfig,
} from "../../src/integration/config.ts";

type Row = Record<string, SQLOutputValue>;

export interface NaturalMaintenanceAuditOptions {
  ltgPath: string;
  stgPaths?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  generatedAt?: string;
}

export interface AutomaticMergeAudit {
  proposalId: string;
  eligible: boolean;
  reasons: string[];
  targetName: string | null;
}

export interface StoreAudit {
  path: string;
  exists: boolean;
  memories: { total: number; active: number; sessions: number };
  claims: {
    outcomeEvents: number;
    semanticTasks: number;
    posteriors: number;
    memoriesWithPosteriors: number;
    promotionCandidates: string[];
    belowRetention: string[];
  };
  warnings: string[];
}

export interface NaturalMaintenanceAudit {
  generatedAt: string;
  readOnly: true;
  policy: {
    stgConsolidation: StgConsolidationPolicyConfig;
    maintenance: MaintenancePolicyConfig;
  };
  ltg: StoreAudit & {
    maintenanceBacklog: {
      indexDeltas: number;
      pendingAccesses: number;
      activeNodesWithWrites: number;
      activeNodesWithAccesses: number;
      writeDueNodes: number;
      accessDueNodes: number;
      largestNodeWrites: number;
      largestNodeAccesses: number;
      distributedWritePressure: boolean;
      distributedAccessPressure: boolean;
    };
    topology: {
      proposalsByStatus: Record<string, number>;
      proposalsByRelation: Record<string, number>;
      pendingAutomaticMergeAssessments: AutomaticMergeAudit[];
      relationsByType: Record<string, number>;
      transformsByType: Record<string, number>;
      transforms: number;
      rollbacks: number;
    };
    consolidatedFromStg: Array<{ memoryId: string; sourceMemoryId: string }>;
  };
  stg: StoreAudit[];
  evidenceGaps: string[];
}

const EMPTY_STORE_COUNTS = {
  memories: { total: 0, active: 0, sessions: 0 },
  claims: {
    outcomeEvents: 0,
    semanticTasks: 0,
    posteriors: 0,
    memoriesWithPosteriors: 0,
    promotionCandidates: [] as string[],
    belowRetention: [] as string[],
  },
};

/**
 * Inspect maintenance evidence without opening a writable NMG store. Missing
 * databases are reported rather than created, and no maintenance actuator runs.
 */
export function auditNaturalMaintenance(options: NaturalMaintenanceAuditOptions): NaturalMaintenanceAudit {
  const environment = options.environment ?? process.env;
  const stgPolicy = configuredStgConsolidationPolicy(environment);
  const maintenancePolicy = configuredMaintenancePolicy(environment);
  const ltg = auditStore(resolve(options.ltgPath), stgPolicy);
  const ltgDetails = ltg.exists
    ? withReadOnlyDatabase(ltg.path, (db) => auditLtgDetails(db, maintenancePolicy))
    : emptyLtgDetails();
  const stg = [...new Set(options.stgPaths ?? [])].map((path) => auditStore(resolve(path), stgPolicy));
  const evidenceGaps: string[] = [];
  const naturalClaimEvents = stg.reduce((sum, store) => sum + store.claims.outcomeEvents, 0);
  const candidates = stg.reduce((sum, store) => sum + store.claims.promotionCandidates.length, 0);
  if (stg.length === 0 || stg.every((store) => !store.exists)) evidenceGaps.push("no_stg_store_observed");
  if (naturalClaimEvents === 0) evidenceGaps.push("no_stg_claim_outcomes");
  if (candidates === 0) evidenceGaps.push("no_stg_consolidation_candidates");
  if (ltgDetails.consolidatedFromStg.length === 0) evidenceGaps.push("no_materialized_stg_to_ltg_examples");
  if ((ltgDetails.topology.proposalsByRelation.same_as ?? 0) === 0) {
    evidenceGaps.push("no_identity_merge_proposals");
  }
  if ((ltgDetails.topology.proposalsByStatus.accepted ?? 0) === 0) {
    evidenceGaps.push("no_accepted_topology_proposals");
  }
  if ((ltgDetails.topology.proposalsByStatus.rejected ?? 0) === 0) {
    evidenceGaps.push("no_rejected_topology_proposals");
  }
  if (ltgDetails.topology.rollbacks === 0) evidenceGaps.push("no_topology_rollbacks");
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    readOnly: true,
    policy: { stgConsolidation: stgPolicy, maintenance: maintenancePolicy },
    ltg: { ...ltg, ...ltgDetails },
    stg,
    evidenceGaps,
  };
}

function auditStore(path: string, policy: StgConsolidationPolicyConfig): StoreAudit {
  if (!existsSync(path)) {
    return { path, exists: false, ...structuredClone(EMPTY_STORE_COUNTS), warnings: ["database_missing"] };
  }
  return withReadOnlyDatabase(path, (db) => {
    const warnings: string[] = [];
    if (!tableExists(db, "memory_records")) {
      return {
        path,
        exists: true,
        ...structuredClone(EMPTY_STORE_COUNTS),
        warnings: ["memory_records_table_missing"],
      };
    }
    const memories = singleRow(
      db,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              COUNT(DISTINCT session_id) AS sessions
       FROM memory_records`,
    );
    const posteriorRows = tableExists(db, "claim_posteriors")
      ? allRows(db, "SELECT * FROM claim_posteriors ORDER BY memory_id, claim_index")
      : [];
    if (!tableExists(db, "claim_posteriors")) warnings.push("claim_posteriors_table_missing");
    const outcome = tableExists(db, "claim_outcome_events")
      ? singleRow(
          db,
          "SELECT COUNT(*) AS events, COUNT(DISTINCT semantic_task_id) AS tasks FROM claim_outcome_events",
        )
      : {};
    if (!tableExists(db, "claim_outcome_events")) warnings.push("claim_outcome_events_table_missing");
    const grouped = groupPosteriors(posteriorRows);
    return {
      path,
      exists: true,
      memories: {
        total: numberValue(memories.total),
        active: numberValue(memories.active),
        sessions: numberValue(memories.sessions),
      },
      claims: {
        outcomeEvents: numberValue(outcome.events),
        semanticTasks: numberValue(outcome.tasks),
        posteriors: posteriorRows.length,
        memoriesWithPosteriors: grouped.size,
        promotionCandidates: [...grouped.entries()]
          .filter(([, claims]) => claims.length > 0 && claims.every((claim) => qualifiesForPromotion(claim, policy)))
          .map(([memoryId]) => memoryId),
        belowRetention: [...grouped.entries()]
          .filter(([, claims]) => claims.length > 0 && claims.some((claim) => !qualifiesForRetention(claim, policy)))
          .map(([memoryId]) => memoryId),
      },
      warnings,
    };
  });
}

function auditLtgDetails(
  db: DatabaseSync,
  maintenancePolicy: MaintenancePolicyConfig,
): Omit<NaturalMaintenanceAudit["ltg"], keyof StoreAudit> {
  const backlogRows =
    tableExists(db, "memory_nodes") &&
    tableExists(db, "memory_records") &&
    tableExists(db, "memory_index_delta")
      ? allRows(
          db,
          `SELECT n.id,
                  (SELECT COUNT(*) FROM memory_index_delta d
                    WHERE d.node_id = n.id AND d.compacted = 0) AS writes,
                  (SELECT COALESCE(SUM(m.pending_access_count), 0) FROM memory_records m
                    WHERE m.node_id = n.id) AS accesses
             FROM memory_nodes n WHERE n.status = 'active'`,
        )
      : [];
  const indexDeltas = backlogRows.reduce((sum, row) => sum + numberValue(row.writes), 0);
  const pendingAccesses = backlogRows.reduce((sum, row) => sum + numberValue(row.accesses), 0);
  const writeDueNodes = backlogRows.filter(
    (row) => numberValue(row.writes) >= maintenancePolicy.writeThreshold,
  ).length;
  const accessDueNodes = backlogRows.filter(
    (row) => numberValue(row.accesses) >= maintenancePolicy.accessThreshold,
  ).length;
  const maintenanceBacklog = {
    indexDeltas,
    pendingAccesses,
    activeNodesWithWrites: backlogRows.filter((row) => numberValue(row.writes) > 0).length,
    activeNodesWithAccesses: backlogRows.filter((row) => numberValue(row.accesses) > 0).length,
    writeDueNodes,
    accessDueNodes,
    largestNodeWrites: Math.max(0, ...backlogRows.map((row) => numberValue(row.writes))),
    largestNodeAccesses: Math.max(0, ...backlogRows.map((row) => numberValue(row.accesses))),
    distributedWritePressure: indexDeltas >= maintenancePolicy.writeThreshold && writeDueNodes === 0,
    distributedAccessPressure: pendingAccesses >= maintenancePolicy.accessThreshold && accessDueNodes === 0,
  };
  const proposals = tableExists(db, "topology_proposals")
    ? allRows(db, "SELECT * FROM topology_proposals ORDER BY created_at, id")
    : [];
  const transforms = tableExists(db, "node_transforms") ? allRows(db, "SELECT * FROM node_transforms") : [];
  const journals = tableExists(db, "node_transform_journals")
    ? allRows(db, "SELECT * FROM node_transform_journals")
    : [];
  const relations = tableExists(db, "node_relations") ? allRows(db, "SELECT * FROM node_relations") : [];
  const consolidatedFromStg = tableExists(db, "memory_records")
    ? allRows(db, "SELECT id, markers_json FROM memory_records WHERE status = 'active'").flatMap((row) => {
        const sourceMemoryId = consolidatedSource(row.markers_json);
        return sourceMemoryId ? [{ memoryId: String(row.id), sourceMemoryId }] : [];
      })
    : [];
  return {
    maintenanceBacklog,
    topology: {
      proposalsByStatus: countBy(proposals, "status"),
      proposalsByRelation: countBy(proposals, "relation_type", "none"),
      pendingAutomaticMergeAssessments: proposals
        .filter((row) => String(row.status) === "pending" && String(row.relation_type) === "same_as")
        .map((row) => assessAutomaticMerge(db, row)),
      relationsByType: countBy(relations, "relation_type"),
      transformsByType: countBy(transforms, "transform_type"),
      transforms: transforms.length,
      rollbacks: journals.filter((row) => row.rolled_back_at !== null).length,
    },
    consolidatedFromStg,
  };
}

function emptyLtgDetails(): Omit<NaturalMaintenanceAudit["ltg"], keyof StoreAudit> {
  return {
    maintenanceBacklog: {
      indexDeltas: 0,
      pendingAccesses: 0,
      activeNodesWithWrites: 0,
      activeNodesWithAccesses: 0,
      writeDueNodes: 0,
      accessDueNodes: 0,
      largestNodeWrites: 0,
      largestNodeAccesses: 0,
      distributedWritePressure: false,
      distributedAccessPressure: false,
    },
    topology: {
      proposalsByStatus: {},
      proposalsByRelation: {},
      pendingAutomaticMergeAssessments: [],
      relationsByType: {},
      transformsByType: {},
      transforms: 0,
      rollbacks: 0,
    },
    consolidatedFromStg: [],
  };
}

function assessAutomaticMerge(db: DatabaseSync, proposal: Row): AutomaticMergeAudit {
  const reasons: string[] = [];
  const sourceNodeIds = parseStringArray(proposal.source_node_ids_json ?? null);
  const evidenceMemoryIds = parseStringArray(proposal.evidence_memory_ids_json ?? null);
  if (numberValue(proposal.observations) < 5) reasons.push("insufficient_observations");
  if (numberValue(proposal.estimated_gain) < 0.98) reasons.push("insufficient_confidence");
  if (evidenceMemoryIds.length < 4) reasons.push("insufficient_evidence_memories");
  const evidenceRows = evidenceMemoryIds.map((id) =>
    db.prepare("SELECT node_id, scope_json, status FROM memory_records WHERE id = ?").get(id) as Row | undefined,
  );
  if (evidenceRows.some((row) => !row || String(row.status) !== "active")) {
    reasons.push("missing_or_inactive_evidence");
  }
  if (sourceNodeIds.some((nodeId) => !evidenceRows.some((row) => String(row?.node_id ?? "") === nodeId))) {
    reasons.push("evidence_not_balanced_across_nodes");
  }
  const scopes = new Set(evidenceRows.filter(Boolean).map((row) => String(row?.scope_json ?? "{}")));
  if (scopes.size > 1) reasons.push("scope_mismatch");
  let targetName: string | null = null;
  if (scopes.size === 1) {
    try {
      const scope = JSON.parse([...scopes][0] ?? "{}") as Record<string, unknown>;
      const identities = Object.values(scope).filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (identities.length === 1) targetName = identities[0]!.trim();
      else reasons.push("ambiguous_target_identity");
    } catch {
      reasons.push("invalid_scope_identity");
    }
  }
  if (targetName && tableExists(db, "memory_nodes")) {
    const identity = canonicalNodeIdentity(targetName);
    const duplicate = allRows(db, "SELECT canonical_name FROM memory_nodes WHERE status = 'active'").some(
      (row) => canonicalNodeIdentity(String(row.canonical_name)) === identity,
    );
    if (duplicate) reasons.push("target_name_already_active");
  }
  const nodeKey = [...sourceNodeIds].sort().join("\0");
  const competing = allRows(
    db,
    `SELECT source_node_ids_json FROM topology_proposals
     WHERE id <> ? AND status = 'pending' AND relation_type IN ('distinct_from', 'contradicts')`,
    String(proposal.id),
  ).some((row) => parseStringArray(row.source_node_ids_json ?? null).sort().join("\0") === nodeKey);
  if (competing) reasons.push("competing_conflict_proposal");
  return {
    proposalId: String(proposal.id),
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    targetName,
  };
}

interface PosteriorAudit {
  independentVoteCount: number;
  mean: number;
  lowerBound: number;
}

function groupPosteriors(rows: readonly Row[]): Map<string, PosteriorAudit[]> {
  const grouped = new Map<string, PosteriorAudit[]>();
  for (const row of rows) {
    const alpha = numberValue(row.alpha);
    const beta = numberValue(row.beta);
    const total = alpha + beta;
    const mean = total > 0 ? alpha / total : 0.5;
    const standardError = Math.sqrt((mean * (1 - mean)) / Math.max(1, total + 1));
    const claim = {
      independentVoteCount: numberValue(row.independent_vote_count),
      mean,
      lowerBound: Math.max(0, Math.min(1, mean - 1.96 * standardError)),
    };
    const memoryId = String(row.memory_id);
    grouped.set(memoryId, [...(grouped.get(memoryId) ?? []), claim]);
  }
  return grouped;
}

function qualifiesForPromotion(claim: PosteriorAudit, policy: StgConsolidationPolicyConfig): boolean {
  return (
    claim.independentVoteCount >= policy.minimumIndependentVotes &&
    claim.mean >= policy.minimumPosteriorMean &&
    claim.lowerBound >= policy.minimumConservativeLowerBound
  );
}

function qualifiesForRetention(claim: PosteriorAudit, policy: StgConsolidationPolicyConfig): boolean {
  return (
    claim.mean >= policy.minimumRetainedPosteriorMean &&
    claim.lowerBound >= policy.minimumRetainedConservativeLowerBound
  );
}

function consolidatedSource(value: SQLOutputValue | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    const markers = JSON.parse(value) as unknown;
    if (!Array.isArray(markers)) return null;
    for (const marker of markers) {
      if (!marker || typeof marker !== "object") continue;
      const candidate = marker as { kind?: unknown; attributes?: { sourceMemoryId?: unknown } };
      if (candidate.kind === "consolidated_from_stg" && typeof candidate.attributes?.sourceMemoryId === "string") {
        return candidate.attributes.sourceMemoryId;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function withReadOnlyDatabase<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function allRows(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function singleRow(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row {
  return (db.prepare(sql).get(...params) as Row | undefined) ?? {};
}

function numberValue(value: SQLOutputValue | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function countBy(rows: readonly Row[], key: string, fallback = "unknown"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = row[key];
    const label = value === null || value === undefined || String(value).length === 0 ? fallback : String(value);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function parseArguments(argv: readonly string[]): { ltgPath: string; stgPaths: string[] } {
  let ltgPath = join(resolveNmgDataDir(), "nmg.sqlite");
  const stgPaths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--ltg" && value) {
      ltgPath = resolve(value);
      index += 1;
    } else if (argument === "--stg" && value) {
      stgPaths.push(resolve(value));
      index += 1;
    } else if (argument === "--project-dir" && value) {
      stgPaths.push(resolve(value, ".nmg", "stg.sqlite"));
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument ?? ""}`);
    }
  }
  const localStg = resolve(process.cwd(), ".nmg", "stg.sqlite");
  if (stgPaths.length === 0 && existsSync(localStg)) stgPaths.push(localStg);
  return { ltgPath, stgPaths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = auditNaturalMaintenance(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
