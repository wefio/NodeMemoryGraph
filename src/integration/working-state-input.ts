import { createHash } from "node:crypto";
import type { SessionActiveGraphSnapshot } from "../core/session-active-graph.ts";
import { prepareSessionActiveGraphSurface } from "./agent-surface.ts";

/** Host metadata identifies one dedicated fragment, not arbitrary matching prose.
 * It is context fencing, not authentication, fact support or a disclosure receipt.
 */
export interface WorkingStateInput {
  readonly version: 1;
  readonly sessionId: string;
  readonly agId: string;
  readonly taskFrameId: string;
  readonly bindingId: string;
  readonly contentHash: string;
  readonly text: string;
  readonly textHash: string;
}

/** How a host carries the current state into model input. Pi attaches one
 * prepared body to the persisted per-turn message, so a later model call in the
 * same turn re-sends nothing and rewrites no earlier position. Final provider
 * input stays unconfirmed until that host reports it.
 */
export const PI_WORKING_STATE_INPUT_CAPABILITY = Object.freeze({
  carriage: "per-user-turn",
  confirmation: "unsupported",
} as const);

export function prepareWorkingStateInput(
  snapshot: SessionActiveGraphSnapshot | null,
  maxCharacters?: number,
): WorkingStateInput | null {
  if (!snapshot) return null;
  const item = snapshot.items.find(
    (item) => item.kind === "working_state" && item.taskFrameId === snapshot.activeTaskFrameId,
  );
  if (!item?.contentHash || !item.sourceId) return null;
  const output = prepareSessionActiveGraphSurface({ ...snapshot, items: [item] }, maxCharacters);
  if (output.included.length !== 1 || output.omitted.length > 0) return null;
  return Object.freeze({
    version: 1,
    sessionId: snapshot.sessionId,
    agId: snapshot.agId,
    taskFrameId: item.taskFrameId,
    bindingId: item.sourceId,
    contentHash: item.contentHash,
    text: output.text,
    textHash: textHash(output.text),
  });
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
