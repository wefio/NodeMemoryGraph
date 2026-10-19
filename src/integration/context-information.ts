import type { InformationPurpose, InformationView } from "../core/information-view.ts";
import type { SessionActiveGraphSnapshot } from "../core/session-active-graph.ts";
import type { ReasoningCheckpoint } from "../lab/reasoning-workspace.ts";
import { prepareSessionActiveGraphSurface } from "./agent-surface.ts";
import { prepareWorkingStateInput } from "./working-state-input.ts";

/** Raw owner results, not parsed tool text. The existing projection keeps
 * admission/labels; only automatic continuity requests the owner turn window.
 */
export function contextStateViews(
  snapshot: SessionActiveGraphSnapshot | null,
  sessionId: string,
): readonly InformationView[] {
  if (!snapshot) return [];
  if (snapshot.sessionId !== sessionId) throw new Error("Foreign AG context snapshot");
  if (!Number.isSafeInteger(snapshot.disclosureTurn) || snapshot.disclosureTurn < 0) {
    throw new Error("Invalid AG context turn");
  }
  const currentState = prepareWorkingStateInput(snapshot);
  return prepareSessionActiveGraphSurface(snapshot, undefined, {
    contextTurn: snapshot.disclosureTurn,
  }).views.filter((view) => view.purpose !== "state" || currentState !== null);
}

/** A checkpoint is a self-contained owner projection. Its preview/scratchpad
 * nature cannot become exact evidence through grouping or confirmation.
 */
export function checkpointInformationViews(
  checkpoint: ReasoningCheckpoint | null,
  sessionId: string,
): InformationView[] {
  if (!checkpoint) return [];
  if (checkpoint.sessionId !== sessionId) throw new Error("Foreign reasoning checkpoint");
  return [
    {
      purpose: "reasoning",
      source: {
        kind: "workspace",
        sessionId,
        generatedAt: checkpoint.generatedAt,
      },
      body: checkpoint.text,
      requiredLabels: ["[temporary]", "[scratchpad preview; not verified fact]"],
      preview: true,
    },
  ];
}

/** Each generated control/diagnostic item stays independent; it has no fact
 * source or write authority merely because it appears in the same message.
 */
export function contextNotice(
  body: string,
  purpose: InformationPurpose = "guidance",
): InformationView[] {
  return body ? [{ purpose, body }] : [];
}

/** Explicit history access is not an instruction to stage working context. */
export function contextBoardEntries<T extends { status?: string }>(
  entries: readonly T[],
  historyRead: boolean,
): T[] {
  return historyRead ? [] : entries.filter((entry) => entry.status === "open");
}
