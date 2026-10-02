/** Session lifecycle, counters and completion checks independent of work-shape interpretation.
 * The compatibility exports carry the default policy; the generic contracts do not require it. */

export interface SessionLimits {
  turns: number;
  reads: number;
  timeoutMs: number;
}

/** Bounds are declared by the caller. The mechanism does not choose a read minimum. */
export interface CompletionBounds {
  minTurns: number;
  maxTurns: number;
  minReads: number;
  maxReads: number;
}

export function completionAllowed(
  completed: boolean,
  timedOut: boolean,
  turns: number,
  reads: number,
  bounds: CompletionBounds,
): boolean {
  return (
    completed &&
    !timedOut &&
    turns >= bounds.minTurns &&
    turns <= bounds.maxTurns &&
    reads >= bounds.minReads &&
    reads <= bounds.maxReads
  );
}

/** A host-declared requirement on an upstream artifact, not a worker-selected predicate. */
export interface PushbackSpec {
  requirements: readonly { task: string; requirement: string }[];
}

export interface PushbackReport {
  dependency: string;
  requirement: string;
  evidence: string;
}

/** One bounded execution. Optional cumulative fields distinguish unit spend from session spend. */
export interface PiRun {
  artifact: string;
  pushback?: PushbackReport;
  sessionId: string;
  provider: string;
  model: string;
  reads: number;
  turns: number;
  checks: number;
  tokens: number;
  cacheRead: number;
  cacheWrite: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Identity of the rendered input actually presented, not just the task specification. */
  promptDigest: string;
  sessionTokens?: number;
  sessionCacheRead?: number;
  sessionCacheWrite?: number;
  sessionInputTokens?: number;
  sessionOutputTokens?: number;
  sessionCost?: number;
}

/** Mutable per-unit state. An adopter extends this with its own tool and declaration state. */
export interface SessionState {
  snapshot: string;
  limits: SessionLimits;
  maxArtifact: number;
  reads: { value: number };
  runs: { value: number };
  turns: number;
  calls: string[];
  artifact: string | null;
  artifactError: string | null;
  report: PushbackReport | null;
  abort: () => void;
}

/** Providers need not report the same split; absent accounting is not zero spend. */
interface TurnUsage {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** Sum the accounting reported for assistant turns, without inventing unreported splits. */
export function usageTotals(messages: readonly { role: string; usage?: TurnUsage }[]) {
  let total = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const item of messages) {
    if (item.role !== "assistant") continue;
    const usage = item.usage;
    if (!usage) continue;
    total += usage.totalTokens ?? 0;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  }
  return { total, input, output, cacheRead, cacheWrite, cost };
}

export function totalTokens(messages: readonly { role: string; usage?: TurnUsage }[]) {
  return usageTotals(messages).total;
}

export function cacheTotals(messages: readonly { role: string; usage?: TurnUsage }[]) {
  const totals = usageTotals(messages);
  return { cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite };
}

/** Bounded text extraction does not interpret an artifact's domain schema. */
export function boundedArtifact(
  message: { content: readonly { type: string; text?: string }[] } | undefined,
  maxArtifact: number,
): string | null {
  if (!message) return null;
  const artifact = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  return artifact && artifact.length <= maxArtifact ? artifact : null;
}

export function turnError(event: {
  type: string;
  message: { role: string; stopReason?: string; errorMessage?: string };
}): string | null {
  if (event.type !== "turn_end" || event.message.role !== "assistant") return null;
  if (event.message.stopReason !== "error") return null;
  return `pi turn error: ${event.message.errorMessage}\n`;
}

/** Rendered input, with execution bounds but no required declaration or tool vocabulary. */
export interface SessionInput {
  prompt: string;
  snapshot: string;
  maxArtifact: number;
  limits: SessionLimits;
}

export interface SessionRunner<Input extends SessionInput = SessionInput> {
  sessionId: string;
  runUnit(input: Input): Promise<PiRun>;
  dispose(): void;
}

/** Compatibility facade, not another implementation. Default-policy bodies live in the adopter. */
export {
  SNAPSHOT_LIMITS,
  ARTIFACT_TOOL,
  checkToolCandidate,
  artifactEnvelope,
  patchSessionInput,
  piCompletionAllowed,
  snapshotText,
  artifactFromText,
  toolNames,
} from "./ooo-patch-session.ts";
export type {
  CheckTool,
  ArtifactParams,
  PatchExecOptions,
  UnitState,
  SessionRunInput,
  PiSessionRunner,
} from "./ooo-patch-session.ts";
