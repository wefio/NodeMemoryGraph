import type { SqliteLocalDaemonState } from "../core/store/local-daemon-state.ts";

/** Local run/board transaction boundary. It is never implemented by a memory backend. */
export type CoordinationPort = Pick<
  SqliteLocalDaemonState,
  | "taskRunFacts"
  | "taskRunManifest"
  | "taskRunForEntry"
  | "coordinateRunWrite"
  | "appendTaskRunFact"
  | "getTaskBoardEntryById"
  | "taskRunTasks"
  | "writeTransaction"
  | "putTaskBoardEntry"
  | "registerTaskRun"
  | "freezeTaskRunTask"
>;

export type TaskBoardPort = CoordinationPort &
  Pick<
    SqliteLocalDaemonState,
    | "postBoardMessage"
    | "readTaskBoard"
    | "listCoordinationEvents"
    | "readDirectedTaskBoard"
    | "readInboxTaskBoard"
    | "readTaskBoardPreviews"
    | "listTaskBoards"
    | "claimTaskBoardEntry"
    | "releaseTaskBoardEntry"
    | "hasTaskBoardDelivery"
    | "taskBoardAckedIds"
    | "inactiveTaskBoardEntries"
    | "isTaskBoardSuppressed"
    | "recordTaskBoardDelivery"
    | "acknowledgeTaskBoardEntry"
    | "vetoTaskBoardEntry"
    | "deliverTaskBoardEntry"
    | "judgeTaskBoardEntry"
    | "setBoardChannelSubscription"
    | "registerTaskBoardAgent"
    | "heartbeatTaskBoardAgent"
    | "renameTaskBoardAgent"
    | "unregisterTaskBoardAgent"
    | "discoverTaskBoardAgents"
    | "getAgentWorkStatus"
    | "listBoardChannelSubscriptions"
    | "resolveTaskBoardEntry"
  >;

export type CoordinationStatePort = Pick<
  SqliteLocalDaemonState,
  | "reportAgentActivity"
  | "readAgentActivity"
  | "setAgentStatusNote"
  | "getAgentWorkStatus"
  | "createCoordinationEvent"
  | "listCoordinationEvents"
  | "readCoordinationEvent"
  | "updateCoordinationEvent"
  | "deleteCoordinationEvent"
  | "subscribeCoordinationEvent"
  | "unsubscribeCoordinationEvent"
>;
