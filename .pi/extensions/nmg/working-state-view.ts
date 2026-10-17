import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionActiveGraphSnapshot } from "../../../src/core/session-active-graph.ts";
import {
  prepareWorkingStateInput,
  type WorkingStateInput,
} from "../../../src/integration/working-state-input.ts";

/** The read-only user view of the current state. index.ts exposes it through the
 * `/nmg` menu, so the extension adds no top-level command of its own.
 */
export interface WorkingStateView {
  /** Toggle the preview only: state, carriage and ledger are untouched.
   * Re-enabling reads again instead of repainting a remembered body.
   */
  setPreview(enabled: boolean, ctx: ExtensionContext): Promise<void>;
  previewEnabled(): boolean;
  /** Notify the complete admitted body without changing any state. */
  readForUser(ctx: ExtensionContext): Promise<void>;
}

/** Pi carries the current state once per user turn: index.ts folds the prepared
 * body into the persisted `nmg-context` message. Nothing here is injected at a
 * later model call in the same turn, and no earlier position is rewritten.
 */
export function registerWorkingStateView(
  pi: ExtensionAPI,
  readSnapshot: (sessionId: string) => Promise<SessionActiveGraphSnapshot | null>,
): WorkingStateView {
  // Presentation fencing only: no cached body or competing state store.
  let generation = 0;
  let preview = true;
  const paint = (ctx: ExtensionContext, lines: string[] | undefined): void => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("nmg-working-state", preview ? lines : undefined);
  };
  const readCurrent = async (ctx: ExtensionContext) => {
    const request = ++generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const stillCurrent = () =>
      request === generation && ctx.sessionManager.getSessionId() === sessionId;
    try {
      const snapshot = await readSnapshot(sessionId);
      if (!stillCurrent()) return;
      if (snapshot && snapshot.sessionId !== sessionId) throw new Error("Foreign working state");
      const current = prepareWorkingStateInput(snapshot);
      if (
        !current &&
        snapshot?.items.some(
          (item) =>
            item.kind === "working_state" && item.taskFrameId === snapshot.activeTaskFrameId,
        )
      )
        throw new Error("Incomplete working state");
      paint(ctx, current ? previewLines(current) : undefined);
      return { sessionId, current, unavailable: false };
    } catch {
      if (!stillCurrent()) return;
      paint(ctx, ["NMG 当前状态不可用；未确认当前进度。"]);
      return { sessionId, current: null, unavailable: true };
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    generation++;
    paint(ctx, undefined);
    await readCurrent(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    generation++;
    paint(ctx, undefined);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (isWorkingStateWrite(event)) await readCurrent(ctx);
  });
  return {
    previewEnabled: () => preview,
    async setPreview(enabled, ctx) {
      preview = enabled;
      paint(ctx, undefined);
      // A remembered body could already be stale, so re-enabling reads again.
      if (enabled) await readCurrent(ctx);
    },
    async readForUser(ctx) {
      const result = await readCurrent(ctx);
      if (result && ctx.hasUI)
        ctx.ui.notify(
          result.unavailable
            ? "当前工作状态不可用。"
            : (result.current?.text ?? "尚未维护当前工作状态。"),
          result.unavailable ? "warning" : "info",
        );
    },
  };
}

function isWorkingStateWrite(event: { toolName: string; input: Record<string, unknown> }): boolean {
  return (
    (event.toolName === "nmg_state" &&
      event.input.space === "ag" &&
      event.input.action === "write") ||
    (event.toolName === "nmg_lab" && event.input.capability === "working_state")
  );
}

function previewLines(current: WorkingStateInput): string[] {
  const lines = current.text.split("\n");
  return [
    "NMG 当前工作状态（临时）",
    ...lines.slice(0, 6),
    ...(lines.length > 6 ? ["… /nmg state 查看完整状态"] : []),
  ];
}
