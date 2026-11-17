import type { NmgStateResult } from "../cli/protocol.ts";
import { TASK_BOARD_VERDICTS, WORLD_BOARD_ID } from "../core/types.ts";
import { loadPrompts } from "../prompts/load.ts";
import type { AdapterToolSession, StateToolIdentity } from "./adapter-tool-session.ts";
import { contextBoardEntries } from "./context-information.ts";
import {
  boardStateDirection,
  captureStateInvocation,
  COORDINATION_OPERATIONS,
  renderStateOutput,
  requireBoardEventCapability,
  STATE_AG_READ_OPERATIONS,
  STATE_AG_WRITE_OPERATIONS,
  STATE_BOARD_READ_OPERATIONS,
  STATE_BOARD_WRITE_OPERATIONS,
  stateOperation,
} from "./state.ts";

export type StateToolSpace = "ag" | "board";

export interface StateToolArguments extends Record<string, unknown> {
  action: string;
  space: string;
  operation?: string;
}

const prompts = loadPrompts();
const string = { type: "string" };
const object = { type: "object", additionalProperties: true };
const boardFields = {
  taskId: { ...string, description: prompts.board_task_id_parameter_description },
  content: { ...string, description: prompts.board_content_parameter_description },
  kind: {
    type: "string",
    enum: ["blocker", "decision", "goal", "handoff", "note", "question", "result"],
  },
  entryId: string,
  resolution: string,
  leaseSeconds: { type: "integer", minimum: 60, maximum: 86_400 },
  digest: { ...string, description: "SHA-256 of the deliverable, required by deliver." },
  ref: string,
  summary: string,
  verdict: { type: "string", enum: TASK_BOARD_VERDICTS },
  afterCursor: string,
  limit: { type: "integer", minimum: 1, maximum: 200 },
  includeResolved: { type: "boolean" },
  to: { ...string, description: "Stable Agent name or ID from discover." },
  capabilities: { ...string, description: "Capability substring used by discover." },
  need: { ...string, description: "Optional capability need used by discover." },
  agentName: { ...string, description: "New display name for rename." },
  eventId: string,
  event: { ...object, description: "Event payload, including expectedRevision for mutations." },
  notification: { ...object, description: "Explicit notice with key, scopes and recipients." },
  activity: { ...object, description: "Session processing report for agentActivity." },
};

function stateToolSchema(spaces: readonly StateToolSpace[]) {
  return {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["read", "write"] },
      space: { type: "string", enum: [...spaces] },
      operation: {
        type: "string",
        enum: [
          ...new Set([
            ...(spaces.includes("ag")
              ? [...STATE_AG_READ_OPERATIONS, ...STATE_AG_WRITE_OPERATIONS]
              : []),
            ...(spaces.includes("board")
              ? [...STATE_BOARD_READ_OPERATIONS, ...STATE_BOARD_WRITE_OPERATIONS]
              : []),
          ]),
        ],
      },
      reason: string,
      ttlSeconds: { type: "integer", minimum: 60, maximum: 2_592_000 },
      text: { ...string, description: "Working state text or public Agent status note." },
      ...(spaces.includes("board") ? boardFields : {}),
    },
    required: ["action", "space"],
    additionalProperties: false,
  };
}

export function createStateTool(spaces: readonly StateToolSpace[]) {
  return {
    name: "nmg_state" as const,
    requiresNativeSession: true,
    label: "NMG state",
    description: prompts.state_description,
    inputSchema: stateToolSchema(spaces),
    async execute(input: Record<string, unknown>, session: AdapterToolSession) {
      if (!spaces.includes(input.space as StateToolSpace)) {
        if (input.space === "board") throw new Error("Board coordination is disabled");
        throw new Error(`NMG state space is unavailable: ${input.space}`);
      }
      // Only model-visible fields may cross the tool boundary. The host owns the
      // actor, requester, session and writer fence.
      const allowed = stateToolSchema([input.space as StateToolSpace]).properties;
      const scoped = Object.fromEntries(
        Object.entries(input).filter(([key]) => Object.hasOwn(allowed, key)),
      ) as StateToolArguments;
      const args =
        session.legacyBoardVerbs && scoped.space === "board"
          ? normalizeBoardArguments(scoped)
          : scoped;
      const operation = stateOperation(args);
      if (!session.sessionId.trim()) throw new Error("NMG state requires a host session binding");
      return args.space === "ag"
        ? invokeAg(args, operation, session)
        : invokeBoard(args, operation, session);
    },
  };
}

export type SharedStateTool = ReturnType<typeof createStateTool>;

export function resolveBoardOperation(args: Record<string, unknown>): string | null {
  const operation = String(args.operation ?? args.action ?? "").trim();
  return !operation || operation === "write" ? null : operation;
}

function normalizeBoardArguments(args: Record<string, unknown>): StateToolArguments {
  const operation = resolveBoardOperation(args);
  if (!operation) throw new Error("nmg_state board requires a concrete operation");
  return {
    ...args,
    action: boardStateDirection(operation, args.action),
    space: "board",
    operation,
  };
}

export function assembleBoardStateParams(
  args: Record<string, unknown>,
  sessionId: string,
  identity: StateToolIdentity,
): Record<string, unknown> & { taskId: string } {
  return {
    ...normalizeBoardArguments(args),
    taskId: String(args.taskId ?? "").trim() || WORLD_BOARD_ID,
    sessionId,
    sourceSessionId: sessionId,
    id: identity.id,
    agentId: identity.id,
    agentName: identity.agentName,
  };
}

async function invokeAg(input: StateToolArguments, operation: string, session: AdapterToolSession) {
  const { sessionId, requester } = session;
  const params = await captureStateInvocation({ ...input, operation, sessionId, requester }, () =>
    session.invoke("state", { action: "read", space: "ag", operation: "status", sessionId }),
  );
  const result = (await session.invoke("state", params)) as NmgStateResult;
  return {
    text: renderStateOutput(result),
    details: {
      ...result,
      ...(result.result.action === "invoke" ? { output: result.result.output } : {}),
      workingStateBinding: params.workingStateBinding,
    },
  };
}

function checkBoardInput(input: StateToolArguments, operation: string): void {
  if (operation === "deliver" && !input.digest)
    throw new Error("deliver requires digest: the sha256 identity of the artifact being handed in");
  if (operation === "judge" && !input.verdict)
    throw new Error("judge requires verdict: accepted | rejected | undecidable");
  if (operation === "judge" && !input.reason)
    throw new Error(
      "judge requires reason: the ruling is recorded in the entry and survives a restart",
    );
}

async function invokeBoard(
  input: StateToolArguments,
  operation: string,
  session: AdapterToolSession,
) {
  checkBoardInput(input, operation);
  if (!session.boardIdentity) throw new Error("Board coordination is disabled");
  const identity = await session.boardIdentity();
  const { sessionId } = session;
  const name = String(input.agentName ?? "").trim();
  if (operation === "rename" && !name) {
    return {
      text: `当前 agent 名：${identity.agentName}（id=${identity.id}）。用法：nmg_state action=write space=board operation=rename agentName=<新名>`,
      details: { action: "rename", id: identity.id, agentName: identity.agentName },
    };
  }
  const params = {
    ...assembleBoardStateParams({ ...input, operation }, sessionId, identity),
    agentName: operation === "rename" ? name : identity.agentName,
  };
  await requireBoardEventCapability(params, () => session.invoke("hello", {}));
  const result = (await session.invoke("state", params)) as NmgStateResult;
  if (result.result.action === "rename") identity.saveName?.(name);
  await afterBoardRead(
    result.result,
    session,
    identity,
    params.taskId,
    input.includeResolved === true,
  );
  return {
    text: boardText(result),
    details: COORDINATION_OPERATIONS.has(operation) ? result : result.result,
  };
}

function boardText(result: NmgStateResult): string {
  switch (result.result.action) {
    case "subscribe":
      return `已加入频道 ${result.result.taskId}（未订阅的频道不会打扰你）。`;
    case "unsubscribe":
      return `已退出频道 ${result.result.taskId}。重新加入使用 nmg_state space=board action=write operation=subscribe。`;
    case "rename":
      return `已改名：${result.result.agentName}（id=${result.result.id}）——定向 to= 可用新名或 id。`;
    default:
      return renderStateOutput(result);
  }
}

async function afterBoardRead(
  result: NmgStateResult["result"],
  session: AdapterToolSession,
  identity: StateToolIdentity,
  taskId: string,
  includeResolved: boolean,
): Promise<void> {
  if (!session.boardReads || result.action !== "read") return;
  const { sessionId } = session;
  const entries = result.entries;
  if (session.boardReads === "project") {
    const projected = contextBoardEntries(entries, includeResolved);
    await Promise.allSettled(
      projected.map((entry) =>
        session.invoke("sessionActiveGraph", {
          action: "observe",
          sessionId,
          kind: "board_projection",
          sourceId: `board:${taskId}:${entry.id}`,
          nodeId: `board:${taskId}`,
          statement: `[task-board ${taskId} #${entry.id} ${entry.kind} by ${entry.agentId}] ${entry.content}`,
        }),
      ),
    );
    if (projected.length)
      await session
        .invoke("sessionActiveGraph", { action: "activate", sessionId })
        .catch(() => undefined);
  }
  await Promise.allSettled(
    entries
      .filter(
        (entry) =>
          entry.status === "open" &&
          entry.sourceSessionId !== sessionId &&
          !(entry.sourceSessionId == null && entry.agentId === identity.id),
      )
      .map((entry) =>
        session.invoke("taskBoard", {
          action: "recordDelivery",
          entryId: entry.id,
          sessionId,
          agentId: identity.id,
          source: "read",
        }),
      ),
  );
}
