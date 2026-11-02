import type { CoordinationEvent } from "./coordination-events.ts";
import { coordinationNames, coordinationText } from "./coordination-events.ts";

export type CollaborationPhase = "discussion" | "execution";
export interface PhaseProposal {
  id: string;
  target: CollaborationPhase;
  proposer: string;
  reason: string;
  requiredApprovers: string[];
  agreedBy: string[];
}
export interface CollaborationState {
  phase: CollaborationPhase | null;
  phaseRevision: number;
  pending: PhaseProposal | null;
}
type PhaseChangeBase = { text: string; proposalId: string; expectedPhaseRevision: number };
export type PhaseMutation = PhaseChangeBase &
  (
    | { kind: "phasePropose"; target: CollaborationPhase; requiredApprovers?: string[] }
    | { kind: "phaseAgree" | "phaseSwitch" | "phaseWithdraw" }
  );

export function isPhaseMutation(change: { kind: string }): change is PhaseMutation {
  return ["phasePropose", "phaseAgree", "phaseSwitch", "phaseWithdraw"].includes(change.kind);
}

export function parsePhaseMutation(data: Record<string, unknown>, text: string): PhaseMutation {
  const kind = data.kind;
  if (
    kind !== "phasePropose" &&
    kind !== "phaseAgree" &&
    kind !== "phaseSwitch" &&
    kind !== "phaseWithdraw"
  )
    throw new Error("Invalid phase change kind");
  if (!Number.isSafeInteger(data.expectedPhaseRevision) || Number(data.expectedPhaseRevision) < 0)
    throw new Error("expectedPhaseRevision must be a nonnegative safe integer");
  const base = {
    text,
    proposalId: coordinationText(data.proposalId, "proposalId", 200),
    expectedPhaseRevision: Number(data.expectedPhaseRevision),
  };
  if (kind !== "phasePropose") return { ...base, kind };
  if (data.target !== "discussion" && data.target !== "execution")
    throw new Error("Invalid collaboration phase");
  return {
    ...base,
    kind,
    target: data.target,
    ...(data.requiredApprovers === undefined
      ? {}
      : { requiredApprovers: coordinationNames(data.requiredApprovers, "requiredApprovers") }),
  };
}

/** Shared agreement only; callers still own resource permission and in-flight operations. */
export function applyPhaseMutation(
  event: CoordinationEvent,
  change: PhaseMutation,
  actor: string,
): void {
  if (event.status !== "active") throw new Error("Reopen event before changing its phase");
  const state = event.collaboration ?? { phase: null, phaseRevision: 0, pending: null };
  if (state.phaseRevision !== change.expectedPhaseRevision)
    throw new Error("Phase revision changed; read before updating");
  if (change.kind === "phasePropose") {
    propose(event, state, change, actor);
  } else {
    const proposal = state.pending;
    if (!proposal || proposal.id !== change.proposalId)
      throw new Error("Phase proposal changed or absent");
    if (change.kind === "phaseAgree") {
      if (!proposal.requiredApprovers.includes(actor))
        throw new Error("Agent is not a required phase approver");
      proposal.agreedBy = [...new Set([...proposal.agreedBy, actor])];
    } else if (change.kind === "phaseWithdraw") {
      if (proposal.proposer !== actor)
        throw new Error("Only the proposer may withdraw the phase proposal");
      state.pending = null;
    } else {
      if (proposal.requiredApprovers.some((id) => !proposal.agreedBy.includes(id)))
        throw new Error("Phase proposal requires confirmation from its approvers");
      state.phase = proposal.target;
      state.phaseRevision++;
      state.pending = null;
    }
  }
  event.collaboration = state;
}

function propose(
  event: CoordinationEvent,
  state: CollaborationState,
  change: Extract<PhaseMutation, { kind: "phasePropose" }>,
  actor: string,
): void {
  if (state.pending) throw new Error("Withdraw the pending phase proposal before replacing it");
  if (state.phase === change.target) throw new Error("Event already has the target phase");
  const required = [...new Set([actor, ...(change.requiredApprovers ?? event.participants)])];
  if (
    required.length > 32 ||
    required.some((id) => id !== actor && !event.participants.includes(id))
  )
    throw new Error("Phase approvers must be event participants, at most 32");
  state.pending = {
    id: change.proposalId,
    target: change.target,
    proposer: actor,
    reason: change.text,
    requiredApprovers: required,
    agreedBy: [actor],
  };
}
