import { claimPosterior } from "../claims.ts";
import type {
  ClaimOutcomeEvent,
  ClaimOutcomeVoteInput,
  ClaimPosterior,
  MemoryRecord,
  RecordClaimOutcomesInput,
} from "../types.ts";
import { MemoryLifecycleError } from "./lifecycle.ts";
import type { MemoryPlan } from "./plan.ts";
import { memoryIdentity } from "./model.ts";

export function claimPosteriorId(memoryId: string, claimIndex: number): string {
  return memoryIdentity("claim-posterior", memoryId, String(claimIndex));
}

export function claimOutcomeId(
  memoryId: string,
  claimIndex: number,
  semanticTaskId: string,
): string {
  return memoryIdentity("claim-outcome", memoryId, String(claimIndex), semanticTaskId);
}

export async function recordClaimOutcomes(
  plan: MemoryPlan,
  input: RecordClaimOutcomesInput,
  now: string,
) {
  const origin =
    input.collectionOrigin ??
    (input.votes.some((vote) => vote.source === "benchmark") ? "controlled" : "natural");
  const events: ClaimOutcomeEvent[] = [];
  const seen = new Map<string, ClaimOutcomeEvent["outcome"]>();
  const affected = new Set<string>();
  for (const vote of input.votes) {
    const memory = await plan.record(vote.memoryId, input.sessionId);
    if (!memory || memory.status === "deleted")
      throw new MemoryLifecycleError("Claim outcome targets must exist in this store and session");
    validateEvidence(vote);
    for (const [index, claim] of selectClaims(memory, vote)) {
      const id = claimOutcomeId(memory.id, index, input.semanticTaskId);
      if (seen.has(id) && seen.get(id) !== vote.outcome)
        throw new MemoryLifecycleError("Conflicting claim outcomes for the same claim and task");
      seen.set(id, vote.outcome);
      const [existing] = await plan.find({
        kind: "claimOutcome",
        ids: [id],
        sessionId: input.sessionId,
      });
      if (existing) continue;
      const evidenceId = retainEvidence(plan, vote, id, now);
      const event: ClaimOutcomeEvent = {
        id,
        memoryId: memory.id,
        claimIndex: index,
        semanticTaskId: input.semanticTaskId,
        outcome: vote.outcome,
        source: vote.source,
        sourceLineage: vote.sourceLineage,
        evidenceId,
        collectionOrigin: origin,
        weight: vote.weight ?? 1,
        activeGraphId: input.activeGraphId ?? null,
        createdAt: now,
      };
      plan.put({ kind: "claimOutcome", value: { ...event, sessionId: memory.sessionId } });
      await applyOutcome(plan, memory, claim, event);
      events.push(event);
      affected.add(memory.id);
    }
  }
  const posteriors: ClaimPosterior[] = [];
  for (const memoryId of affected) {
    const rows = await plan.find({
      kind: "claimPosterior",
      claimMemoryId: memoryId,
      sessionId: input.sessionId,
    });
    posteriors.push(
      ...rows
        .flatMap((row) => {
          if (row.kind !== "claimPosterior") return [];
          return [row.value.posterior];
        })
        .sort((a, b) => a.claimIndex - b.claimIndex),
    );
  }
  return { events, posteriors };
}

function selectClaims(memory: MemoryRecord, vote: ClaimOutcomeVoteInput) {
  const claims = memory.claims ?? [{ text: memory.statement, confidence: memory.confidence }];
  const indexes = new Set(vote.claimIndexes ?? claims.map((_, index) => index));
  if (!indexes.size) throw new MemoryLifecycleError("claimIndexes must not be empty");
  const weight = vote.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1)
    throw new MemoryLifecycleError("Claim outcome weight must be in (0,1]");
  return [...indexes].map((index) => {
    const claim = claims[index];
    if (!claim) throw new MemoryLifecycleError("Claim index does not exist on the memory");
    return [index, claim] as const;
  });
}

function validateEvidence(vote: ClaimOutcomeVoteInput): void {
  const evidence = vote.evidenceSource;
  if (!evidence) return;
  if (
    (vote.source !== "user" && vote.source !== "tool") ||
    evidence.actor !== vote.source ||
    evidence.sourceMessageId !== vote.sourceLineage
  )
    throw new MemoryLifecycleError("Claim evidence actor and sourceMessageId must match the vote");
}

function retainEvidence(
  plan: MemoryPlan,
  vote: ClaimOutcomeVoteInput,
  eventId: string,
  now: string,
) {
  const evidence = vote.evidenceSource;
  if (!evidence) return null;
  const id = `${eventId}_evidence`;
  plan.put({
    kind: "history",
    value: {
      id,
      sessionId: evidence.sessionId,
      sourceMessageId: evidence.sourceMessageId,
      role: evidence.actor,
      content: evidence.content,
      sourceRef: evidence.sourceRef ?? null,
      createdAt: now,
    },
  });
  return id;
}

async function applyOutcome(
  plan: MemoryPlan,
  memory: MemoryRecord,
  claim: { text: string; confidence: number | null },
  event: ClaimOutcomeEvent,
) {
  const { memoryId, claimIndex } = event;
  const id = claimPosteriorId(memoryId, claimIndex);
  const sessionId = memory.sessionId;
  const [entity] = await plan.find({
    kind: "claimPosterior",
    ids: [id],
    sessionId: sessionId ?? undefined,
  });
  const previous = entity?.kind === "claimPosterior" ? entity.value.posterior : undefined;
  const posterior = posteriorAfterVote(event, claim, memory.confidence, previous);
  plan.put({ kind: "claimPosterior", value: { posterior, id, sessionId } });
}

function posteriorAfterVote(
  event: ClaimOutcomeEvent,
  claim: { text: string; confidence: number | null },
  memoryConfidence: number | null,
  previous?: ClaimPosterior,
) {
  const { memoryId, claimIndex, weight } = event;
  const priorConfidence =
    previous?.priorConfidence ??
    Math.max(0, Math.min(1, claim.confidence ?? memoryConfidence ?? 0.5));
  const alpha =
    (previous?.alpha ?? 1 + 2 * priorConfidence) + (event.outcome === "supported" ? weight : 0);
  const beta =
    (previous?.beta ?? 1 + 2 * (1 - priorConfidence)) +
    (event.outcome === "contradicted" ? weight : 0);
  return claimPosterior({
    memoryId,
    claimIndex,
    claimText: previous?.claimText ?? claim.text,
    priorConfidence,
    alpha,
    beta,
    independentVoteCount: (previous?.independentVoteCount ?? 0) + 1,
    updatedAt: event.createdAt,
  });
}
