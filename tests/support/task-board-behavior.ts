import type { SqliteLocalDaemonState } from "../../src/core/store/local-daemon-state.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";

interface ClaimAndDeliverInput {
  agentId: string;
  digest: string;
  now: string;
  leaseSeconds: number;
}

/** Acts on an existing entry. The two store writes are not an atomic transaction. */
export function claimAndDeliver(
  store: SqliteLocalDaemonState,
  entry: Pick<TaskBoardEntry, "taskId" | "id">,
  input: ClaimAndDeliverInput,
): TaskBoardEntry {
  const reference = { taskId: entry.taskId, entryId: entry.id, agentId: input.agentId };
  store.claimTaskBoardEntry({ ...reference, now: input.now, leaseSeconds: input.leaseSeconds });
  return store.deliverTaskBoardEntry({ ...reference, now: input.now, digest: input.digest });
}
