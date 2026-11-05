import type { NmgStore } from "../core/store.ts";

/** Local run/board transaction boundary. It is never implemented by a memory backend. */
export type CoordinationPort = Pick<
  NmgStore,
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
