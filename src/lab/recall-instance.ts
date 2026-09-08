import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Self-contained recall instances — a source-agnostic benchmark substrate.
 *
 * Every disclosure recall (automatic pre-turn or the model's own explicit
 * search — both have a trigger, a retrieval, and a relevance question) is
 * captured as one durable instance: { trigger, retrieved candidates + text,
 * activeGraphId }. Relevance of the retrieval to the trigger is judged
 * STANDALONE — it never needs the downstream answer, so a code-heavy session
 * cannot starve the corpus the way turn-level usefulness feedback could. This
 * is the retrieval-layer supervision signal the online router optimises; it is
 * deliberately not an end-to-end "did my answer succeed" claim.
 *
 * Internal probes (persistTrace:false) never surface content and are excluded
 * by the caller, exactly as they are excluded from online staging.
 */

export const RECALL_LABELS = ["on_target", "partial", "noise", "misleading", "gap"] as const;
export type RecallLabel = (typeof RECALL_LABELS)[number];

/** Who produced the label. remember = settled on the write path from store
 *  verifiable supersession; judge = offline relevance labelling. Both are
 *  content/store-groundable, never an assistant self-report of usefulness. */
export type RecallLabelSource = "remember" | "judge";

/** One label on one instance, keyed by the graph the instance names. Immutable
 *  capture instances stay untouched; labels live in a separate append-only
 *  ledger so neither producer rewrites the corpus. */
export interface RecallLabelEntry {
  activeGraphId: string;
  label: RecallLabel;
  source: RecallLabelSource;
  at: string;
}

export interface RecallCandidate {
  memoryId: string;
  statement: string;
  combinedScore?: number;
  recallReason?: string;
}

export interface RecallInstance {
  at: string;
  /** Who asked for the recall: host automatic pre-turn vs the model's explicit search. */
  kind: "auto" | "explicit";
  /** The content that triggered the recall (user message or the search query). */
  trigger: string;
  activeGraphId: string;
  sessionId?: string;
  /** What retrieval surfaced for the trigger (bounded; full statements). */
  candidates: RecallCandidate[];
  /** Offline relevance label; the collector writes instances unlabeled. */
  label?: RecallLabel;
}

export interface RecallLabelSummary {
  total: number;
  labeled: number;
  perLabel: Record<RecallLabel, number>;
  /** Share of judged instances the retrieval got on-target or partially (a
   *  clean-signal precision proxy; gap instances are excluded from the
   *  denominator because they judge absence, not a wrong candidate). */
  precision: number | null;
  /** Share of judged instances where a needed memory was absent. */
  gapRate: number | null;
}

/** Capture gate, independent of online learning. Disable with NMG_RECALL_INSTANCES=0. */
export function recallInstancesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NMG_RECALL_INSTANCES !== "0";
}

export function recallInstancesPath(dataDir: string): string {
  return join(dataDir, "recall-instances.jsonl");
}

export function recallLabelsPath(dataDir: string): string {
  return join(dataDir, "recall-instance-labels.jsonl");
}

const MAX_CANDIDATES = 8;
const MAX_STATEMENT = 2_000;

/** Bound a candidate list for the corpus (top-N, statement truncated). */
export function boundCandidates(candidates: RecallCandidate[]): RecallCandidate[] {
  return candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({
    ...candidate,
    statement:
      candidate.statement.length > MAX_STATEMENT
        ? `${candidate.statement.slice(0, MAX_STATEMENT)}…`
        : candidate.statement,
  }));
}

/** Append one instance (JSONL, one object per line). Best-effort: never throws
 *  to the caller — corpus capture must not break a recall search. */
export function appendRecallInstance(dataDir: string, instance: RecallInstance): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(recallInstancesPath(dataDir), `${JSON.stringify(instance)}\n`, {
      flag: "a",
      encoding: "utf8",
    });
  } catch {
    // Corpus capture is diagnostic; it never breaks the surrounding recall.
  }
}

/** Read all instances from a JSONL corpus (skips malformed lines). */
export function readRecallInstances(path: string): RecallInstance[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const instances: RecallInstance[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RecallInstance;
      if (parsed && typeof parsed.activeGraphId === "string") instances.push(parsed);
    } catch {
      // Skip one malformed line rather than dropping the whole corpus.
    }
  }
  return instances;
}

const precisionLabels = new Set<RecallLabel>(["on_target", "partial"]);

/** Append one label to the ledger (best-effort; never throws). */
export function appendRecallLabel(dataDir: string, entry: RecallLabelEntry): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(recallLabelsPath(dataDir), `${JSON.stringify(entry)}\n`, {
      flag: "a",
      encoding: "utf8",
    });
  } catch {
    // Diagnostic; never breaks the write path.
  }
}

/** Read the label ledger (skips malformed lines). */
export function readRecallLabels(path: string): RecallLabelEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: RecallLabelEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RecallLabelEntry;
      if (parsed && typeof parsed.activeGraphId === "string") entries.push(parsed);
    } catch {
      // Skip one malformed line rather than losing the rest.
    }
  }
  return entries;
}

/** Overlay ledger labels onto instances (ledger wins; last write wins per graph). */
export function applyRecallLabels(
  instances: RecallInstance[],
  entries: RecallLabelEntry[],
): RecallInstance[] {
  const byGraph = new Map<string, RecallLabel>();
  for (const entry of entries) byGraph.set(entry.activeGraphId, entry.label);
  return instances.map((instance) => {
    const label = byGraph.get(instance.activeGraphId);
    return label ? { ...instance, label } : instance;
  });
}

/** Instances whose retrieval surfaced the given memory — the candidates the
 *  write path can settle against when that memory is superseded. Pure. */
export function instancesSurfacing(
  instances: RecallInstance[],
  memoryId: string,
): RecallInstance[] {
  return instances.filter((instance) =>
    instance.candidates.some((candidate) => candidate.memoryId === memoryId),
  );
}

/** Pure aggregate over a labeled corpus. */
export function summarizeLabels(instances: RecallInstance[]): RecallLabelSummary {
  const perLabel = Object.fromEntries(RECALL_LABELS.map((label) => [label, 0])) as Record<
    RecallLabel,
    number
  >;
  let labeled = 0;
  for (const instance of instances) {
    if (instance.label) {
      labeled += 1;
      perLabel[instance.label] += 1;
    }
  }
  const judgedCandidates = labeled - perLabel.gap; // gap judges absence, not a wrong candidate
  const precision =
    judgedCandidates > 0 ? (perLabel.on_target + perLabel.partial) / judgedCandidates : null;
  return {
    total: instances.length,
    labeled,
    perLabel,
    precision,
    gapRate: labeled > 0 ? perLabel.gap / labeled : null,
  };
}
