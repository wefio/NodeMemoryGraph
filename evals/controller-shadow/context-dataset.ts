import { createHash } from "node:crypto";
import {
  admitContextIntervention,
  type ContextIntervention,
} from "../../src/lab/context-intervention.ts";
import type { ContextTrialEvent } from "../../src/lab/context-trial.ts";

export type ContextSplit = "train" | "validation" | "test";
export interface ContextDatasetRow {
  groupId: string;
  split: ContextSplit;
  sample: ContextIntervention;
}

/** Caller maps every retry/paraphrase from one source conversation to one group.
 * Ordered event replay gives the last revision authority: reopening or a later
 * error retracts a previously admitted label. Duplicate decision IDs with a
 * changed decision payload fail closed instead of silently rewriting history.
 */
export function buildContextDataset(options: {
  events: readonly ContextTrialEvent[];
  featureVersion: string;
  acceptanceVersion: string;
  origin: ContextIntervention["origin"];
  groupForTask: (taskId: string) => string;
  verifyEvidence: (sample: Readonly<ContextIntervention>) => boolean;
}): { rows: ContextDatasetRow[]; excluded: number } {
  const latest = new Map<string, ContextTrialEvent>();
  const identities = new Map<string, string>();
  for (const event of options.events) {
    const sample = event.sample;
    const decision = { ...sample };
    delete decision.execution;
    delete decision.outcome;
    const identity = JSON.stringify(decision);
    const prior = identities.get(sample.decisionId);
    if (prior !== undefined && prior !== identity) throw new Error("decision ID collision");
    identities.set(sample.decisionId, identity);
    latest.set(sample.decisionId, event);
  }
  const rows: ContextDatasetRow[] = [];
  for (const event of latest.values()) {
    const sample = event.sample;
    if (event.phase !== "outcome") continue;
    if (sample.featureVersion !== options.featureVersion) continue;
    if (sample.acceptanceVersion !== options.acceptanceVersion) continue;
    if (sample.origin !== options.origin) continue;
    const admitted = admitContextIntervention(sample, options.verifyEvidence).sample;
    if (!admitted) continue;
    const groupId = options.groupForTask(sample.taskId);
    if (!groupId.trim()) throw new Error("missing independent group identity");
    rows.push({ groupId, split: contextGroupSplit(groupId), sample: admitted });
  }
  return { rows, excluded: latest.size - rows.length };
}

/** Stable hash partition independent of scores, policies and arrival order.
 * Approximately 60/20/20; tiny corpora may have an empty partition, which is a
 * blocker for fitting/evaluation, not permission to shuffle until scores improve.
 */
export function contextGroupSplit(groupId: string): ContextSplit {
  const bucket = createHash("sha256").update(groupId).digest().readUInt32BE(0) % 10;
  if (bucket < 6) return "train";
  return bucket < 8 ? "validation" : "test";
}
