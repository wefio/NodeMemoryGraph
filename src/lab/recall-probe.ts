/**
 * Deterministic, gold-free controlled recall probe over a store snapshot.
 *
 * No external gold is required: a probe row names the memory its trigger
 * SHOULD recall (writer-declared recall intent), and the probe measures whether
 * real retrieval actually surfaces it — recallable (`on_target`) or not (`gap`)
 * — plus robustness: does a controlled perturbation of the trigger still recall
 * it? Both signals are internal-consistency checks the store can answer on its
 * own, so the probe produces data on demand without an oracle, an LLM, or an
 * embedding provider (lexical retrieval is deterministic).
 *
 * The probe is NOT a disclosure to a consumer and has no activeGraphId, so its
 * output stays a probe-result surface rather than a recall-instance graph entry.
 */

export type ProbeLabel = "on_target" | "gap";

export interface RecallProbeRow {
  /** Stable identity for one recall target (e.g. the memory id or a semantic key). */
  groupId: string;
  /** The trigger that should recall expectMemoryId. */
  query: string;
  /** The memory this trigger must surface. */
  expectMemoryId: string;
  /** Controlled perturbations of the trigger used to test robustness. */
  variants?: string[];
}

export interface ProbeVariantResult {
  query: string;
  label: ProbeLabel;
}

export interface ProbeExecution {
  groupId: string;
  query: string;
  expectMemoryId: string;
  primary: ProbeLabel;
  /** Perturbation results; empty when the row declared no variants. */
  variants: ProbeVariantResult[];
}

export type RetrieveFn = (query: string) => Promise<readonly string[]>;

/** Deterministic label: did the trigger's retrieval surface the memory it should? */
export function probeLabel(
  retrievedMemoryIds: readonly string[],
  expectMemoryId: string,
): ProbeLabel {
  return retrievedMemoryIds.includes(expectMemoryId) ? "on_target" : "gap";
}

/** Run one row: label the primary query and every declared variant. */
export async function executeProbeRow(
  row: RecallProbeRow,
  retrieve: RetrieveFn,
): Promise<ProbeExecution> {
  const primary = probeLabel(await retrieve(row.query), row.expectMemoryId);
  const variants: ProbeVariantResult[] = [];
  for (const variant of row.variants ?? []) {
    const retrieved = await retrieve(variant);
    variants.push({ query: variant, label: probeLabel(retrieved, row.expectMemoryId) });
  }
  return {
    groupId: row.groupId,
    query: row.query,
    expectMemoryId: row.expectMemoryId,
    primary,
    variants,
  };
}

export interface ProbeGroupSummary {
  /** groupIds whose primary trigger failed to recall their memory. */
  gaps: string[];
  /** groupIds robust across primary + all declared variants. */
  robust: string[];
  /** groupIds that recall on the primary trigger but drop under at least one variant. */
  fragile: Array<{ groupId: string; failedVariants: string[] }>;
}

export function summarizeProbe(executions: ProbeExecution[]): ProbeGroupSummary {
  const gaps: string[] = [];
  const robust: string[] = [];
  const fragile: Array<{ groupId: string; failedVariants: string[] }> = [];
  for (const execution of executions) {
    if (execution.primary === "gap") {
      gaps.push(execution.groupId);
      continue;
    }
    const failedVariants = execution.variants
      .filter((variant) => variant.label === "gap")
      .map((variant) => variant.query);
    if (failedVariants.length > 0) {
      fragile.push({ groupId: execution.groupId, failedVariants });
    } else {
      robust.push(execution.groupId);
    }
  }
  return { gaps, robust, fragile };
}

/** Plain query variants that cost nothing and need no external resources:
 *  a trailing question mark and a de-fluffed copy. Real probes supply their own
 *  CJK/EN and synonym variants; these are a floor, not a substitute. */
export function defaultVariants(query: string): string[] {
  const deFluffed = query
    .replace(/\b(please|would you|can you|how do i|do you remember|你记得|请|帮我|吗|呢)\b/gu, "")
    .trim();
  return Array.from(
    new Set([`${query}?`, deFluffed].filter((variant) => variant && variant !== query)),
  );
}
