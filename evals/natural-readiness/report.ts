import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveNmgDataDir } from "../../src/cli/data-path.ts";
import {
  buildShadowDataset,
  summarizeShadowDataset,
  type ShadowDatasetSummary,
} from "../controller-shadow/dataset.ts";
import {
  readShadowEvents,
  resolveShadowEventPath,
  summarizeShadowEvents,
  type ShadowCoverageReport,
} from "../controller-shadow/report.ts";
import {
  auditNaturalMaintenance,
  type NaturalMaintenanceAudit,
} from "../natural-maintenance/audit.ts";

export interface NaturalReadinessAction {
  id: string;
  state: "required" | "available" | "blocked";
  reason: string;
  command?: string;
}

export interface NaturalReadinessPacket {
  version: 1;
  generatedAt: string;
  readOnly: true;
  controller: {
    coverage: ShadowCoverageReport;
    dataset: ShadowDatasetSummary;
    canCreateCandidate: boolean;
    canPromote: false;
  };
  maintenance: {
    evidenceGaps: string[];
    stgToLtgValidated: boolean;
    automaticMergeValidated: boolean;
  };
  actions: NaturalReadinessAction[];
}

const STG_GAPS = new Set([
  "no_stg_store_observed",
  "no_stg_claim_outcomes",
  "no_stg_consolidation_candidates",
  "no_materialized_stg_to_ltg_examples",
  "no_stg_consolidation_retractions",
  "duplicate_active_stg_materializations",
]);

const MERGE_GAPS = new Set([
  "no_identity_merge_proposals",
  "no_accepted_topology_proposals",
  "no_rejected_topology_proposals",
  "no_topology_rollbacks",
]);

/**
 * Convert the existing read-only audits into one Agent-facing decision packet.
 * The packet recommends the next safe operation; it never activates a candidate,
 * edits runtime policy, or treats a missing observation as a passing result.
 */
export function buildNaturalReadinessPacket(input: {
  coverage: ShadowCoverageReport;
  dataset: ShadowDatasetSummary;
  maintenance: NaturalMaintenanceAudit;
  generatedAt?: string;
}): NaturalReadinessPacket {
  const canCreateCandidate = input.dataset.blockers.length === 0;
  const stgGaps = input.maintenance.evidenceGaps.filter((gap) => STG_GAPS.has(gap));
  const mergeGaps = input.maintenance.evidenceGaps.filter((gap) => MERGE_GAPS.has(gap));
  const actions: NaturalReadinessAction[] = [];

  if (canCreateCandidate) {
    actions.push({
      id: "create_controller_candidate",
      state: "available",
      reason: "natural controller rows satisfy the dataset construction contract",
      command: "npm run eval:controller-calibrate -- --compact",
    });
    actions.push({
      id: "promote_controller_candidate",
      state: "blocked",
      reason:
        "candidate promotion still requires a matched held-out natural shadow result with quality and cost gates",
    });
  } else {
    actions.push({
      id: "collect_verified_controller_evidence",
      state: "required",
      reason: input.dataset.blockers.join("; "),
      command: "npm run eval:controller-dataset -- --compact",
    });
  }

  if (stgGaps.length > 0) {
    actions.push({
      id: "collect_stg_consolidation_evidence",
      state: "required",
      reason: stgGaps.join("; "),
      command: "npm run eval:natural-maintenance -- --project-dir <REAL_PROJECT>",
    });
  }
  if (mergeGaps.length > 0) {
    actions.push({
      id: "collect_identity_merge_evidence",
      state: "required",
      reason: mergeGaps.join("; "),
      command: "npm run eval:natural-maintenance -- --project-dir <REAL_PROJECT>",
    });
  }

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    readOnly: true,
    controller: {
      coverage: input.coverage,
      dataset: input.dataset,
      canCreateCandidate,
      canPromote: false,
    },
    maintenance: {
      evidenceGaps: [...input.maintenance.evidenceGaps],
      stgToLtgValidated: stgGaps.length === 0,
      automaticMergeValidated: mergeGaps.length === 0,
    },
    actions,
  };
}

interface CliOptions {
  eventPath?: string;
  ltgPath: string;
  stgPaths: string[];
  outputPath?: string;
}

function parseArguments(argv: readonly string[]): CliOptions {
  const result: CliOptions = {
    ltgPath: join(resolveNmgDataDir(), "nmg.sqlite"),
    stgPaths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--events" && value) {
      result.eventPath = resolve(value);
    } else if (argument === "--ltg" && value) {
      result.ltgPath = resolve(value);
    } else if (argument === "--stg" && value) {
      result.stgPaths.push(resolve(value));
    } else if (argument === "--project-dir" && value) {
      result.stgPaths.push(resolve(value, ".nmg", "stg.sqlite"));
    } else if (argument === "--out" && value) {
      result.outputPath = resolve(value);
    } else {
      throw new Error(`unknown or incomplete argument: ${argument ?? ""}`);
    }
    index += 1;
  }
  const localStg = resolve(process.cwd(), ".nmg", "stg.sqlite");
  if (result.stgPaths.length === 0 && existsSync(localStg)) result.stgPaths.push(localStg);
  return result;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArguments(process.argv.slice(2));
  const eventPath = resolveShadowEventPath(options.eventPath);
  const events = readShadowEvents(eventPath);
  const packet = buildNaturalReadinessPacket({
    coverage: summarizeShadowEvents(events),
    dataset: summarizeShadowDataset(buildShadowDataset(events)),
    maintenance: auditNaturalMaintenance({
      ltgPath: options.ltgPath,
      stgPaths: options.stgPaths,
    }),
  });
  if (options.outputPath) writeAtomic(options.outputPath, packet);
  process.stdout.write(`${JSON.stringify({ eventPath, outputPath: options.outputPath ?? null, ...packet }, null, 2)}\n`);
}
